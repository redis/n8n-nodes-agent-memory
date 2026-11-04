import type { AgentMemoryTestClient } from '../../support/agent-memory-client';
import {
	stubMessageText,
	stubRequestsContaining,
	type SerializedMessage,
	type StubRequest,
} from '../harness';
import { callWebhook, type WorkflowNode, type WorkflowSpec } from '../n8n-api';

/**
 * Builders and readers shared by the chat-memory scenario files: workflows
 * around the Redis Agent Chat Memory sub-node, the chat webhook calls, and
 * views of what the model, the chat widget and the store ended up with.
 */

export const AGENT_MEMORY_CREDENTIAL = {
	redisAgentMemoryApi: { id: 'e2eAgentMemory01', name: 'Agent Memory (e2e)' },
};

export const OPENAI_STUB_CREDENTIAL = {
	openAiApi: { id: 'e2eOpenAiStub001', name: 'OpenAI stub (e2e)' },
};

export const MEMORY_NODE_TYPE = '@redis/n8n-nodes-agent-memory.redisAgentMemoryChatMemory';
export const TOOL_NODE_TYPE = '@redis/n8n-nodes-agent-memory.redisAgentMemoryTool';
export const MEMORY_MANAGER_TYPE = '@n8n/n8n-nodes-langchain.memoryManager';

/** The first line of the message that carries recalled long-term memories. */
export const RECALL_HEADER = 'Long-term memories about the user, from earlier conversations:';
/** The first line of the message that carries the server summary. */
export const SUMMARY_HEADER = 'Summary of the earlier conversation:';

/** The sub-node's parameters, as they appear in a workflow. */
export interface MemoryNodeParameters {
	sessionId: string;
	actorId: string;
	/** The recall switch; the two fields below apply only when it is on. */
	recallLongTermMemories?: boolean | string;
	/** Defaults to `{{ $json.chatInput }}` in the node when left out. */
	recallQuery?: string;
	recallLimit?: number | string;
	options?: Record<string, unknown>;
}

/** The sub-node, with the e2e credential. */
export function memoryNode(name: string, parameters: MemoryNodeParameters): WorkflowNode {
	return {
		name,
		type: MEMORY_NODE_TYPE,
		typeVersion: 1,
		parameters: { options: {}, ...parameters },
		credentials: AGENT_MEMORY_CREDENTIAL,
	};
}

export interface ChatAgentWorkflowOptions {
	name: string;
	memory: MemoryNodeParameters;
	/** Extra nodes wired to the Agent's Tool input, such as the action node. */
	tools?: WorkflowNode[];
}

/**
 * Chat Trigger → AI Agent, with the stub model and the sub-node as memory.
 * The sub-node is also connected to the Chat Trigger, so the trigger's
 * "Load Previous Session" reads it, the way the chat-agent fixture does.
 */
export function chatAgentWorkflow(options: ChatAgentWorkflowOptions): WorkflowSpec {
	const tools = options.tools ?? [];
	const connections: Record<string, unknown> = {
		'Chat Trigger': { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
		'OpenAI stub': {
			ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]],
		},
		'Redis Agent Chat Memory': {
			ai_memory: [
				[
					{ node: 'AI Agent', type: 'ai_memory', index: 0 },
					{ node: 'Chat Trigger', type: 'ai_memory', index: 0 },
				],
			],
		},
	};
	for (const tool of tools) {
		connections[tool.name] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
	}
	return {
		name: options.name,
		nodes: [
			{
				name: 'Chat Trigger',
				type: '@n8n/n8n-nodes-langchain.chatTrigger',
				typeVersion: 1.5,
				parameters: {
					public: true,
					mode: 'webhook',
					options: { responseMode: 'lastNode', loadPreviousSession: 'memory' },
				},
			},
			{
				name: 'AI Agent',
				type: '@n8n/n8n-nodes-langchain.agent',
				typeVersion: 3.1,
				parameters: { options: {} },
			},
			{
				name: 'OpenAI stub',
				type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
				typeVersion: 1.2,
				position: [160, 220],
				parameters: { model: { __rl: true, mode: 'id', value: 'gpt-4o-mini' }, options: {} },
				credentials: OPENAI_STUB_CREDENTIAL,
			},
			{ ...memoryNode('Redis Agent Chat Memory', options.memory), position: [320, 220] },
			...tools.map(
				(tool, index): WorkflowNode => ({ position: [480 + index * 160, 220], ...tool }),
			),
		],
		connections,
	};
}

/** One Webhook → Chat Memory Manager branch, with its own sub-node instance. */
export interface ManagerBranch {
	/** Node name prefix and webhook path. */
	key: string;
	/** The Chat Memory Manager's parameters (`mode`, `insertMode`, `messages`, ...). */
	manager: Record<string, unknown>;
	/** Defaults to the session and user from `body.sessionId` and `body.userId`. */
	memory?: Partial<MemoryNodeParameters>;
	/** Nodes between the webhook and the manager, each connected to the next. */
	between?: WorkflowNode[];
}

export const MANAGER_MEMORY_DEFAULTS: MemoryNodeParameters = {
	sessionId: '={{ $json.body.sessionId }}',
	actorId: '={{ $json.body.userId }}',
	options: {},
};

/** Node names of one branch; the webhook's name is the key in `webhooks`. */
export function branchNodes(key: string) {
	return { webhook: key, manager: `${key} manager`, memory: `${key} memory` };
}

/**
 * Several Webhook → Chat Memory Manager branches in one workflow, one
 * sub-node per branch, so each branch can have its own options.
 */
export function memoryManagerWorkflow(name: string, branches: ManagerBranch[]): WorkflowSpec {
	const nodes: WorkflowNode[] = [];
	const connections: Record<string, unknown> = {};
	branches.forEach((branch, row) => {
		const names = branchNodes(branch.key);
		const y = row * 240;
		const between = branch.between ?? [];
		nodes.push({
			name: names.webhook,
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [0, y],
			parameters: { httpMethod: 'POST', path: branch.key, responseMode: 'lastNode', options: {} },
		});
		between.forEach((node, index) => nodes.push({ position: [220 * (index + 1), y], ...node }));
		nodes.push({
			name: names.manager,
			type: MEMORY_MANAGER_TYPE,
			typeVersion: 1.1,
			position: [220 * (between.length + 1), y],
			parameters: branch.manager,
		});
		nodes.push({
			...memoryNode(names.memory, { ...MANAGER_MEMORY_DEFAULTS, ...branch.memory }),
			position: [220 * (between.length + 1), y + 160],
		});
		const chain = [names.webhook, ...between.map((node) => node.name), names.manager];
		for (let i = 0; i < chain.length - 1; i++) {
			connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
		}
		connections[names.memory] = {
			ai_memory: [[{ node: names.manager, type: 'ai_memory', index: 0 }]],
		};
	});
	return { name, nodes, connections };
}

/** A Chat Memory Manager "insert" parameter block. */
export function insertMessages(
	messages: Array<{ type: 'user' | 'ai' | 'system'; message: string }>,
	insertMode: 'insert' | 'override' = 'insert',
): Record<string, unknown> {
	return { mode: 'insert', insertMode, messages: { messageValues: messages } };
}

/** The user/ai pair the manager branches insert from `body.user` and `body.ai`. */
export const USER_AI_FROM_BODY = [
	{ type: 'user' as const, message: '={{ $json.body.user }}' },
	{ type: 'ai' as const, message: '={{ $json.body.ai }}' },
];

/** The body of a Chat Trigger `sendMessage`, plus any extra fields a scenario passes through. */
export interface ChatBody {
	sessionId: unknown;
	chatInput: string;
	[key: string]: unknown;
}

export interface ChatReply {
	status: number;
	output?: string;
	body: string;
}

/** One chat turn through a Chat Trigger webhook, never throwing. */
export async function sendMessage(chatPath: string, body: ChatBody): Promise<ChatReply> {
	const response = await callWebhook(chatPath, { action: 'sendMessage', ...body });
	const output = (response.json as { output?: string } | undefined)?.output;
	return { status: response.status, output, body: response.body };
}

/**
 * What the chat widget gets from the Chat Trigger's "Load Previous Session".
 * `extra` fields ride along in the body, for workflows that read options
 * from `$json`.
 */
export async function loadPrevious(
	chatPath: string,
	sessionId: unknown,
	extra: Record<string, unknown> = {},
): Promise<SerializedMessage[]> {
	const response = await callWebhook(chatPath, {
		action: 'loadPreviousSession',
		sessionId,
		...extra,
	});
	if (response.status !== 200) {
		throw new Error(`loadPreviousSession returned ${response.status}: ${response.body}`);
	}
	return (response.json as { data: SerializedMessage[] }).data;
}

/** `[role, text]` of every message in a stub request. */
export function roleAndText(request: StubRequest): Array<[string, string]> {
	return request.messages.map((m) => [m.role, stubMessageText(m)]);
}

/**
 * The stub request for one turn: among the requests that mention `marker`,
 * the first whose last message is the user's `chatInput`. That is the request
 * the Agent sent before any tool ran, so it shows the history as loaded.
 */
export async function modelRequestFor(marker: string, chatInput: string): Promise<StubRequest> {
	const requests = await stubRequestsContaining(marker);
	const request = requests.find((r) => {
		const last = r.messages[r.messages.length - 1];
		return last?.role === 'user' && stubMessageText(last) === chatInput;
	});
	if (!request) {
		throw new Error(
			`The model never received "${chatInput}" (${requests.length} requests mention ${marker})`,
		);
	}
	return request;
}

/**
 * The history the model received for a turn: everything between the Agent's
 * own system message and the current user message.
 */
export async function historySentToModel(
	marker: string,
	chatInput: string,
): Promise<Array<[string, string]>> {
	const request = await modelRequestFor(marker, chatInput);
	const messages = roleAndText(request);
	const start = messages[0]?.[0] === 'system' ? 1 : 0;
	return messages.slice(start, -1);
}

/** `[role, text, actorId]` of every event stored in a session, oldest first. */
export async function storedEvents(
	client: AgentMemoryTestClient,
	sessionId: string,
): Promise<Array<[string, string, string]>> {
	const session = await client.getSession(sessionId);
	return (session?.events ?? []).map((e) => [
		e.role,
		e.content.map((c) => c.text).join(''),
		e.actorId,
	]);
}

export interface MemorySeed {
	id: string;
	ownerId: string;
	text: string;
	namespaceId?: string;
}

/** Creates long-term memories directly, the way the contract test does, so recall has data. */
export async function createMemories(
	client: AgentMemoryTestClient,
	memories: MemorySeed[],
): Promise<void> {
	const created = await client.request<{ created: string[] }>({
		method: 'POST',
		path: '/long-term-memory',
		body: {
			memories: memories.map(({ id, ownerId, text, namespaceId }) => ({
				id,
				ownerId,
				text,
				...(namespaceId ? { namespaceRef: { namespaceId } } : {}),
			})),
		},
	});
	if (created?.created.length !== memories.length) {
		throw new Error(`Expected ${memories.length} memories created, got ${JSON.stringify(created)}`);
	}
}

/** The recall message's bullets, or undefined when the history has no recall message. */
export function recallBullets(history: Array<[string, string]>): string[] | undefined {
	const recall = history.find(([, text]) => text.startsWith(RECALL_HEADER));
	if (!recall) return undefined;
	return recall[1]
		.slice(RECALL_HEADER.length)
		.split('\n')
		.filter((line) => line.length > 0);
}

/** Creates a shared namespace and returns its ID; the caller deletes it. */
export async function createNamespace(
	client: AgentMemoryTestClient,
	name: string,
): Promise<string> {
	const created = await client.request<{ namespace: { namespaceId: string } }>({
		method: 'POST',
		path: '/namespaces',
		body: { name, scope: 'SHARED' },
	});
	const namespaceId = created?.namespace.namespaceId;
	if (!namespaceId) throw new Error(`POST /namespaces returned ${JSON.stringify(created)}`);
	return namespaceId;
}

export async function deleteNamespace(
	client: AgentMemoryTestClient,
	namespaceId: string,
): Promise<void> {
	await client
		.request({
			method: 'DELETE',
			path: `/namespaces/${encodeURIComponent(namespaceId)}`,
			allowNotFound: true,
		})
		.catch(() => undefined);
}

/** A seed branch: Webhook → Insert Messages with `body.user` and `body.ai`, user from `body.userId`. */
export const SEED_BRANCH: ManagerBranch = {
	key: 'seed',
	manager: insertMessages(USER_AI_FROM_BODY),
};

/** Writes `turns` user/assistant pairs into a session through a seed branch, with no model. */
export async function seedTurns(
	seedPath: string,
	session: { sessionId: unknown; userId: unknown },
	turns: Array<[string, string]>,
): Promise<void> {
	for (const [user, ai] of turns) {
		const response = await callWebhook(seedPath, { ...session, user, ai });
		if (response.status !== 200) {
			throw new Error(
				`Seeding ${String(session.sessionId)} returned ${response.status}: ${response.body}`,
			);
		}
	}
}
