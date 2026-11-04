import type { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { runPrefix } from '../../support/env';
import {
	callWebhookAndWait,
	executionError,
	nodeOutput,
	nodeRuns,
	type CreatedWorkflow,
	type Execution,
	type ExecutionError,
	type WebhookResponse,
	type WorkflowNode,
	type WorkflowSpec,
} from '../n8n-api';

/**
 * Builders for the long-term memory scenario tests: a workflow made of
 * Webhook → action node pairs, each driven by its own webhook, with every
 * node parameter read from the POST body.
 */

export const ACTION_NODE_TYPE = '@redis/n8n-nodes-agent-memory.redisAgentMemory';

export const AGENT_MEMORY_CREDENTIAL = {
	redisAgentMemoryApi: { id: 'e2eAgentMemory01', name: 'Agent Memory (e2e)' },
};

/** `={{ $json.body.<field> ?? <fallback> }}`: an empty string when the body omits the field. */
export function fromBody(field: string, fallback = "''"): string {
	return `={{ $json.body.${field} ?? ${fallback} }}`;
}

/** The same, for a node that runs after Split Out, where the item is the element itself. */
export function fromItem(field: string, fallback = "''"): string {
	return `={{ $json.${field} ?? ${fallback} }}`;
}

export interface PairSpec {
	/** Name of the action node; the webhook is called `<key> webhook`. */
	key: string;
	/** Parameters of the action node, `resource` included. */
	parameters: Record<string, unknown>;
	/** Node-level settings such as `onError` or `alwaysOutputData`. */
	settings?: Record<string, unknown>;
	/** Nodes to run between the webhook and the action node, in order. */
	through?: WorkflowNode[];
	/** Credentials of the action node; defaults to the e2e Agent Memory credential. */
	credentials?: WorkflowNode['credentials'];
}

/** A webhook per pair, each feeding its own copy of the action node. */
export function pairsWorkflow(name: string, pairs: PairSpec[]): WorkflowSpec {
	const nodes: WorkflowNode[] = [];
	const connections: Record<
		string,
		{ main: Array<Array<{ node: string; type: string; index: number }>> }
	> = {};
	pairs.forEach((pair, row) => {
		const y = row * 200;
		const webhookName = `${pair.key} webhook`;
		const chain: WorkflowNode[] = [
			...(pair.through ?? []).map((node) => ({ ...node })),
			{
				name: pair.key,
				type: ACTION_NODE_TYPE,
				typeVersion: 1,
				parameters: pair.parameters,
				credentials: pair.credentials ?? AGENT_MEMORY_CREDENTIAL,
				...pair.settings,
			},
		];
		nodes.push({
			name: webhookName,
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [0, y],
			parameters: {
				httpMethod: 'POST',
				path: pair.key.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
				responseMode: 'lastNode',
				options: {},
			},
		});
		let previous = webhookName;
		chain.forEach((node, column) => {
			nodes.push({ ...node, position: [(column + 1) * 260, y] });
			connections[previous] = { main: [[{ node: node.name, type: 'main', index: 0 }]] };
			previous = node.name;
		});
	});
	return { name, nodes, connections };
}

/** A Split Out node over `body.items`, so each element becomes one input item. */
export function splitItems(name: string): WorkflowNode {
	return {
		name,
		type: 'n8n-nodes-base.splitOut',
		typeVersion: 1,
		parameters: { fieldToSplitOut: 'body.items', options: {} },
	};
}

export interface PairResult {
	response: WebhookResponse;
	execution: Execution;
	/** The action node's items on its main output. */
	items: Array<Record<string, unknown>>;
	/** The error the editor would show, when the run failed. */
	error: ExecutionError | undefined;
}

/** Calls the webhook of one pair and reads what its action node produced. */
export async function runPair(
	workflow: CreatedWorkflow,
	key: string,
	body: unknown,
): Promise<PairResult> {
	const { response, execution } = await callWebhookAndWait(
		workflow.id,
		workflow.webhooks[`${key} webhook`],
		body,
	);
	return {
		response,
		execution,
		items: nodeOutput(execution, key),
		error: executionError(execution),
	};
}

/** The API's not-found body, which `NodeApiError` keeps in `context.data`. */
export const NOT_FOUND_BODY = { status: 404, type: '/errors/resource-not-found' };

/** The raw items of a node's output, `pairedItem` included. */
export function rawOutput(
	execution: Execution,
	nodeName: string,
	outputIndex = 0,
): Array<{ json: Record<string, unknown>; pairedItem?: unknown }> {
	const branch = nodeRuns(execution, nodeName)[0]?.data?.main?.[outputIndex];
	return (branch ?? []) as Array<{ json: Record<string, unknown>; pairedItem?: unknown }>;
}

export interface StoredMemory {
	id: string;
	text: string;
	ownerId: string;
	memoryType?: string;
	sessionId?: string;
	topics?: string[];
	namespaceRef?: { namespaceId: string; [key: string]: unknown };
	createdAt: string;
	updatedAt: string;
}

/** Straight reads and writes on the store, so a test can check what n8n left behind. */
export class LongTermMemoryStore {
	private readonly namespaceIds: string[] = [];
	private readonly memoryIds = new Set<string>();

	constructor(private readonly client: AgentMemoryTestClient) {}

	/** An owner ID inside this run's prefix, registered for cleanup. */
	owner(name: string): string {
		const ownerId = `${runPrefix}-ltm-${name}`;
		this.client.track(`${runPrefix}-ltm-no-session`, ownerId);
		return ownerId;
	}

	/** A memory ID inside this run's prefix, deleted at cleanup even when its owner is not tracked. */
	memoryId(name: string): string {
		const id = `${runPrefix}-ltm-${name}`;
		this.memoryIds.add(id);
		return id;
	}

	async get(id: string): Promise<StoredMemory | undefined> {
		return await this.client.request<StoredMemory>({
			method: 'GET',
			path: `/long-term-memory/${encodeURIComponent(id)}`,
			allowNotFound: true,
		});
	}

	/**
	 * Bulk creates, in requests of at most 100 records, the most the endpoint
	 * takes. Every record gets an ID inside the run prefix when it has none.
	 */
	async create(
		memories: Array<Partial<StoredMemory> & { text: string; ownerId: string }>,
	): Promise<string[]> {
		const records = memories.map((memory, index) => ({
			id: this.memoryId(`bulk-${Date.now().toString(36)}-${index}`),
			...memory,
		}));
		for (let start = 0; start < records.length; start += 100) {
			await this.client.request({
				method: 'POST',
				path: '/long-term-memory',
				body: { memories: records.slice(start, start + 100) },
			});
		}
		return records.map((record) => record.id);
	}

	async createNamespace(name: string): Promise<string> {
		const created = await this.client.request<{ namespace: { namespaceId: string } }>({
			method: 'POST',
			path: '/namespaces',
			body: { name: `${runPrefix}-ltm-${name}`, scope: 'SHARED' },
		});
		const namespaceId = created!.namespace.namespaceId;
		this.namespaceIds.push(namespaceId);
		return namespaceId;
	}

	/** Deletes the memories created by ID, then the tracked owners' memories, then the namespaces. */
	async cleanup(): Promise<void> {
		const ids = [...this.memoryIds];
		for (let start = 0; start < ids.length; start += 100) {
			await this.client
				.request({
					method: 'DELETE',
					path: '/long-term-memory',
					body: { memoryIds: ids.slice(start, start + 100) },
				})
				.catch(() => undefined);
		}
		await this.client.cleanup();
		for (const namespaceId of this.namespaceIds) {
			await this.client
				.request({ method: 'DELETE', path: `/namespaces/${namespaceId}`, allowNotFound: true })
				.catch(() => undefined);
		}
	}
}
