import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	AGENT_MEMORY_CREDENTIAL,
	createAgentMemoryRequest,
	type AgentMemoryRequest,
} from '../shared/agentMemoryRequest';
import {
	longTermMemoryFields,
	longTermMemoryOperations,
} from './descriptions/LongTermMemoryDescription';
import { namespaceFields, namespaceOperations } from './descriptions/NamespaceDescription';
import { sessionFields, sessionOperations } from './descriptions/SessionDescription';

/** Largest page the search endpoint serves. */
const MAX_PAGE_SIZE = 100;

interface Page<T> {
	items: T[];
	nextPageToken?: string;
}

/** The namespace endpoints wrap their record. */
interface NamespaceResponse {
	namespace: IDataObject;
}

/** Response of the bulk create, delete and move endpoints. */
interface BulkResult {
	created?: string[];
	deleted?: string[];
	moved?: string[];
	errors?: Array<{ id: string; error: string }>;
}

/** Fields shared by the memory filters, the create fields and the update fields. */
interface MemoryFields {
	id?: string;
	text?: string;
	ownerId?: string;
	memoryType?: string;
	namespaceId?: string;
	sessionId?: string;
	topics?: string;
}

/** Trimmed string, or undefined when empty or not a string. */
function optional(value: unknown): string | undefined {
	const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
	return text || undefined;
}

/** Comma-separated list to an array, or undefined when empty. */
function splitList(value: unknown): string[] | undefined {
	const items = (optional(value) ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}

/** The API's `filter` object for the long-term memory search. */
function memoryFilter(fields: MemoryFields): IDataObject {
	const filter: IDataObject = {};
	const ownerId = optional(fields.ownerId);
	const namespaceId = optional(fields.namespaceId);
	const sessionId = optional(fields.sessionId);
	const memoryType = optional(fields.memoryType);
	const topics = splitList(fields.topics);
	if (ownerId) filter.ownerId = { eq: ownerId };
	if (namespaceId) filter.namespaceRef = { eq: namespaceId };
	if (sessionId) filter.sessionId = { eq: sessionId };
	if (memoryType) filter.memoryType = { eq: memoryType };
	if (topics) filter.topics = { in: topics };
	return filter;
}

/** The record fields the create and update endpoints accept. */
function memoryRecordFields(fields: MemoryFields): IDataObject {
	const record: IDataObject = {};
	const text = optional(fields.text);
	const ownerId = optional(fields.ownerId);
	const memoryType = optional(fields.memoryType);
	const namespaceId = optional(fields.namespaceId);
	const sessionId = optional(fields.sessionId);
	const topics = splitList(fields.topics);
	if (text) record.text = text;
	if (ownerId) record.ownerId = ownerId;
	if (memoryType) record.memoryType = memoryType;
	if (namespaceId) record.namespaceRef = { namespaceId };
	if (sessionId) record.sessionId = sessionId;
	if (topics) record.topics = topics;
	return record;
}

/** An ID the API accepts (letters, digits and dashes) that is unique enough for one store. */
function generateMemoryId(): string {
	return `n8n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Follows `nextPageToken` until the pages run out or `max` items are collected. */
async function collectPages<T>(
	fetchPage: (pageToken: string | undefined) => Promise<Page<T> | undefined>,
	max: number | undefined,
): Promise<T[]> {
	const items: T[] = [];
	let pageToken: string | undefined;
	do {
		const page = await fetchPage(pageToken);
		items.push(...(page?.items ?? []));
		pageToken = page?.nextPageToken;
	} while (pageToken && (max === undefined || items.length < max));
	return max === undefined ? items : items.slice(0, max);
}

/** Fails when a bulk endpoint did not apply the operation to `id`. */
function assertBulkApplied(
	node: INode,
	itemIndex: number,
	result: BulkResult | undefined,
	key: 'created' | 'deleted' | 'moved',
	id: string,
): void {
	const failure = result?.errors?.find((error) => error.id === id);
	if (failure) {
		throw new NodeOperationError(node, `Memory "${id}" was not ${key}: ${failure.error}`, {
			itemIndex,
		});
	}
	if (!result?.[key]?.includes(id)) {
		throw new NodeOperationError(node, `Memory "${id}" was not ${key}`, {
			itemIndex,
			description: 'The server did not report an error, but the ID is missing from its response',
		});
	}
}

export class RedisAgentMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Redis Agent Memory',
		name: 'redisAgentMemory',
		icon: {
			light: 'file:../../icons/memory.svg',
			dark: 'file:../../icons/memory.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Search, store and manage long-term memories, sessions and namespaces in Redis Agent Memory',
		defaults: {
			name: 'Redis Agent Memory',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: AGENT_MEMORY_CREDENTIAL,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Long-Term Memory', value: 'longTermMemory' },
					{ name: 'Namespace', value: 'namespace' },
					{ name: 'Session', value: 'session' },
				],
				default: 'longTermMemory',
			},
			...longTermMemoryOperations,
			...longTermMemoryFields,
			...namespaceOperations,
			...namespaceFields,
			...sessionOperations,
			...sessionFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			// Errors are already `NodeApiError`s (from the request helper) or
			// `NodeOperationError`s (from validation), so they pass through as they are.
			const outcome = await runItem(this, itemIndex).then(
				(result): { result: IDataObject | IDataObject[] } => ({ result }),
				(error: unknown): { error: unknown } => ({ error }),
			);
			if ('error' in outcome) {
				if (!this.continueOnFail()) throw outcome.error;
				returnData.push({
					json: { error: (outcome.error as Error).message },
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			for (const json of Array.isArray(outcome.result) ? outcome.result : [outcome.result]) {
				returnData.push({ json, pairedItem: { item: itemIndex } });
			}
		}

		return [returnData];
	}
}

/** Runs the configured operation for one input item. */
async function runItem(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject | IDataObject[]> {
	const resource = context.getNodeParameter('resource', itemIndex) as string;
	const operation = context.getNodeParameter('operation', itemIndex) as string;
	const request = await createAgentMemoryRequest(context, itemIndex);
	const run = new Operations(context, itemIndex, request);

	if (resource === 'longTermMemory') return await run.longTermMemory(operation);
	if (resource === 'session') return await run.session(operation);
	if (resource === 'namespace') return await run.namespace(operation);
	throw new NodeOperationError(context.getNode(), `Unknown resource "${resource}"`, { itemIndex });
}

/** The operations for one input item. Errors from the API arrive as `NodeApiError`s from `request`. */
class Operations {
	constructor(
		private readonly context: IExecuteFunctions,
		private readonly itemIndex: number,
		private readonly request: AgentMemoryRequest,
	) {}

	private get node(): INode {
		return this.context.getNode();
	}

	private param<T>(name: string, fallback?: T): T {
		return this.context.getNodeParameter(name, this.itemIndex, fallback) as T;
	}

	/** A required string parameter, trimmed. Fails with the parameter's display name when empty. */
	private required(name: string, displayName: string): string {
		const value = optional(this.param<unknown>(name, ''));
		if (!value) {
			throw new NodeOperationError(this.node, `'${displayName}' is empty`, {
				itemIndex: this.itemIndex,
			});
		}
		return value;
	}

	/** Page size and item cap for a Get Many operation. */
	private paging(): { pageSize: number; max: number | undefined } {
		const returnAll = this.param<boolean>('returnAll', false);
		if (returnAll) return { pageSize: MAX_PAGE_SIZE, max: undefined };
		const limit = this.param<number>('limit', 50);
		return { pageSize: Math.min(limit, MAX_PAGE_SIZE), max: limit };
	}

	private unknownOperation(resource: string, operation: string): never {
		throw new NodeOperationError(
			this.node,
			`Unknown operation "${operation}" for resource "${resource}"`,
			{ itemIndex: this.itemIndex },
		);
	}

	async longTermMemory(operation: string): Promise<IDataObject | IDataObject[]> {
		switch (operation) {
			case 'search': {
				const query = this.required('query', 'Query');
				const ownerId = this.required('ownerId', 'User ID');
				const maxResults = this.param<number>('maxResults', 10);
				const options = this.param<
					MemoryFields & { filterOp?: string; similarityThreshold?: number }
				>('options', {});
				const body: IDataObject = {
					text: query,
					limit: maxResults,
					filter: memoryFilter({ ...options, ownerId }),
				};
				if (options.filterOp && options.filterOp !== 'all') body.filterOp = options.filterOp;
				if (options.similarityThreshold) body.similarityThreshold = options.similarityThreshold;
				const page = await this.request<Page<IDataObject>>({
					method: 'POST',
					path: '/long-term-memory/search',
					body,
				});
				return page?.items ?? [];
			}
			case 'getAll': {
				const filters = this.param<MemoryFields>('filters', {});
				const { pageSize, max } = this.paging();
				return await collectPages<IDataObject>(
					async (pageToken) =>
						await this.request<Page<IDataObject>>({
							method: 'POST',
							path: '/long-term-memory/search',
							body: {
								filter: memoryFilter(filters),
								limit: pageSize,
								...(pageToken ? { pageToken } : {}),
							},
						}),
					max,
				);
			}
			case 'create': {
				const text = this.required('text', 'Text');
				const ownerId = this.required('ownerId', 'User ID');
				const additionalFields = this.param<MemoryFields>('additionalFields', {});
				const id = optional(additionalFields.id) ?? generateMemoryId();
				const memory = { id, ...memoryRecordFields({ ...additionalFields, text, ownerId }) };
				const result = await this.request<BulkResult>({
					method: 'POST',
					path: '/long-term-memory',
					body: { memories: [memory] },
				});
				assertBulkApplied(this.node, this.itemIndex, result, 'created', id);
				return memory;
			}
			case 'get': {
				const memoryId = this.required('memoryId', 'Memory ID');
				return (
					(await this.request<IDataObject>({
						method: 'GET',
						path: `/long-term-memory/${encodeURIComponent(memoryId)}`,
					})) ?? {}
				);
			}
			case 'update': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const updateFields = this.param<MemoryFields>('updateFields', {});
				return (
					(await this.request<IDataObject>({
						method: 'PATCH',
						path: `/long-term-memory/${encodeURIComponent(memoryId)}`,
						body: memoryRecordFields(updateFields),
					})) ?? {}
				);
			}
			case 'delete': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const result = await this.request<BulkResult>({
					method: 'DELETE',
					path: '/long-term-memory',
					body: { memoryIds: [memoryId] },
				});
				assertBulkApplied(this.node, this.itemIndex, result, 'deleted', memoryId);
				return { deleted: true, id: memoryId };
			}
			case 'move': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const namespaceId = this.required('namespaceId', 'Namespace ID');
				const result = await this.request<BulkResult>({
					method: 'POST',
					path: '/long-term-memory/move',
					body: { memoryIds: [memoryId], namespaceRef: { namespaceId } },
				});
				assertBulkApplied(this.node, this.itemIndex, result, 'moved', memoryId);
				return { moved: true, id: memoryId, namespaceId };
			}
			default:
				return this.unknownOperation('longTermMemory', operation);
		}
	}

	async session(operation: string): Promise<IDataObject | IDataObject[]> {
		switch (operation) {
			case 'get': {
				const sessionId = this.required('sessionId', 'Session ID');
				const options = this.param<{ includeSummarisedEvents?: boolean }>('options', {});
				return (
					(await this.request<IDataObject>({
						method: 'GET',
						path: `/session-memory/${encodeURIComponent(sessionId)}`,
						...(options.includeSummarisedEvents ? { qs: { includeSummarisedEvents: true } } : {}),
					})) ?? {}
				);
			}
			case 'getAll': {
				const filters = this.param<{ ownerId?: string }>('filters', {});
				const ownerId = optional(filters.ownerId);
				const { pageSize, max } = this.paging();
				const sessionIds = await collectPages<string>(
					async (pageToken) =>
						await this.request<Page<string>>({
							method: 'GET',
							path: '/session-memory',
							qs: {
								limit: pageSize,
								...(ownerId ? { filterOwnerId: ownerId } : {}),
								...(pageToken ? { pageToken } : {}),
							},
						}),
					max,
				);
				return sessionIds.map((sessionId) => ({ sessionId }));
			}
			case 'delete': {
				const sessionId = this.required('sessionId', 'Session ID');
				await this.request({
					method: 'DELETE',
					path: `/session-memory/${encodeURIComponent(sessionId)}`,
				});
				return { deleted: true, sessionId };
			}
			case 'addEvent': {
				const sessionId = this.required('sessionId', 'Session ID');
				const actorId = this.required('actorId', 'User ID');
				const text = this.required('text', 'Text');
				const role = this.param<string>('role', 'USER');
				const additionalFields = this.param<{ createdAt?: string; namespaceId?: string }>(
					'additionalFields',
					{},
				);
				const createdAt = optional(additionalFields.createdAt);
				const namespaceId = optional(additionalFields.namespaceId);
				const result = await this.request<{ event: IDataObject }>({
					method: 'POST',
					path: '/session-memory/events',
					body: {
						sessionId,
						actorId,
						role,
						content: [{ text }],
						createdAt: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
						...(namespaceId ? { namespaceRef: { namespaceId } } : {}),
					},
				});
				return result?.event ?? {};
			}
			case 'deleteEvent': {
				const sessionId = this.required('sessionId', 'Session ID');
				const eventId = this.required('eventId', 'Event ID');
				await this.request({
					method: 'DELETE',
					path: `/session-memory/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}`,
				});
				return { deleted: true, sessionId, eventId };
			}
			default:
				return this.unknownOperation('session', operation);
		}
	}

	async namespace(operation: string): Promise<IDataObject | IDataObject[]> {
		switch (operation) {
			case 'create': {
				const name = this.required('name', 'Name');
				const scope = this.param<string>('scope', 'SHARED');
				const additionalFields = this.param<{ parentId?: string; ownerId?: string }>(
					'additionalFields',
					{},
				);
				const parentId = optional(additionalFields.parentId);
				const ownerId = optional(additionalFields.ownerId);
				const created = await this.request<NamespaceResponse>({
					method: 'POST',
					path: '/namespaces',
					body: {
						name,
						scope,
						...(parentId ? { parentId } : {}),
						...(ownerId ? { ownerId } : {}),
					},
				});
				return created?.namespace ?? {};
			}
			case 'get': {
				const namespaceId = this.required('namespaceId', 'Namespace ID');
				const fetched = await this.request<NamespaceResponse>({
					method: 'GET',
					path: `/namespaces/${encodeURIComponent(namespaceId)}`,
				});
				return fetched?.namespace ?? {};
			}
			case 'getAll': {
				const { pageSize, max } = this.paging();
				return await collectPages<IDataObject>(
					async (pageToken) =>
						await this.request<Page<IDataObject>>({
							method: 'GET',
							path: '/namespaces',
							qs: { limit: pageSize, ...(pageToken ? { pageToken } : {}) },
						}),
					max,
				);
			}
			case 'update': {
				const namespaceId = this.required('namespaceId', 'Namespace ID');
				const updateFields = this.param<{ name?: string; state?: string }>('updateFields', {});
				const name = optional(updateFields.name);
				const updated = await this.request<NamespaceResponse>({
					method: 'PATCH',
					path: `/namespaces/${encodeURIComponent(namespaceId)}`,
					body: {
						...(name ? { name } : {}),
						...(updateFields.state ? { state: updateFields.state } : {}),
					},
				});
				return updated?.namespace ?? {};
			}
			case 'delete': {
				const namespaceId = this.required('namespaceId', 'Namespace ID');
				await this.request({
					method: 'DELETE',
					path: `/namespaces/${encodeURIComponent(namespaceId)}`,
				});
				return { deleted: true, namespaceId };
			}
			default:
				return this.unknownOperation('namespace', operation);
		}
	}
}
