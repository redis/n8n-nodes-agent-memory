import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	INodeListSearchResult,
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

/**
 * How many pages the namespace list search reads for one filter string. The
 * API has no name search, so the node matches names itself.
 */
const MAX_SEARCH_PAGES = 10;

interface Page<T> {
	items: T[];
	nextPageToken?: string;
}

/** The namespace endpoints wrap their record. */
interface NamespaceResponse {
	namespace: IDataObject;
}

/** A session as `GET /session-memory/{id}` returns it, as far as Simplify reads it. */
interface SessionResponse extends IDataObject {
	events?: Array<IDataObject & { content?: Array<{ text?: string }> }>;
	summary?: { text?: string };
	namespaceRef?: { namespaceId?: string };
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

/** The value as a whole number, or undefined when it is not one (an expression may give anything). */
function wholeNumber(value: unknown): number | undefined {
	const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
	return Number.isInteger(number) ? number : undefined;
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

/** The object without the keys whose value is undefined. */
function compact(record: Record<string, unknown>): IDataObject {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	) as IDataObject;
}

/**
 * The fields of a memory most workflows read, flat: `namespaceRef` becomes
 * `namespaceId`. Create's echo of its request body maps the same way, so
 * Create and Get agree.
 */
function simplifyMemory(memory: IDataObject): IDataObject {
	const namespaceRef = memory.namespaceRef as { namespaceId?: string } | undefined;
	return compact({
		id: memory.id,
		text: memory.text,
		ownerId: memory.ownerId,
		memoryType: memory.memoryType,
		topics: memory.topics,
		namespaceId: namespaceRef?.namespaceId,
		sessionId: memory.sessionId,
		createdAt: memory.createdAt,
	});
}

/** The fields of a namespace most workflows read. */
function simplifyNamespace(namespace: IDataObject): IDataObject {
	return compact({
		namespaceId: namespace.namespaceId,
		name: namespace.name,
		scope: namespace.scope,
		state: namespace.state,
		parentId: namespace.parentId,
		ownerId: namespace.ownerId,
	});
}

/** A session with the summary text and one line of text per event. */
function simplifySession(session: SessionResponse): IDataObject {
	return compact({
		sessionId: session.sessionId,
		ownerId: session.ownerId,
		namespaceId: session.namespaceRef?.namespaceId,
		summary: session.summary?.text,
		events: (session.events ?? []).map((event) =>
			compact({
				eventId: event.eventId,
				actorId: event.actorId,
				role: event.role,
				text: (event.content ?? []).map((part) => part.text ?? '').join('\n'),
				createdAt: event.createdAt,
			}),
		),
	});
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
			description: 'The server accepted the request, but its response does not list the ID',
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

	methods = {
		listSearch: {
			searchNamespaces,
		},
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

/**
 * The store's namespaces for the Namespace locator's "From List" mode, one
 * page at a time. With a filter string, it reads up to `MAX_SEARCH_PAGES`
 * pages and keeps the namespaces whose name contains the string, in any case.
 */
async function searchNamespaces(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const request = await createAgentMemoryRequest(this, 0);
	const needle = (filter ?? '').trim().toLowerCase();
	const results: INodeListSearchResult['results'] = [];
	let pageToken = paginationToken;
	for (let pages = 0; pages < (needle ? MAX_SEARCH_PAGES : 1); pages++) {
		const page = await request<Page<IDataObject>>({
			method: 'GET',
			path: '/namespaces',
			qs: { limit: MAX_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) },
		});
		for (const namespace of page?.items ?? []) {
			const name = String(namespace.name ?? namespace.namespaceId ?? '');
			if (needle && !name.toLowerCase().includes(needle)) continue;
			results.push({ name, value: String(namespace.namespaceId) });
		}
		pageToken = page?.nextPageToken;
		if (!pageToken) break;
	}
	return { results, ...(pageToken ? { paginationToken: pageToken } : {}) };
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

	/** True when the AI Agent runs the node as a tool; n8n appends `Tool` to the type. */
	private get runsAsTool(): boolean {
		return this.node.type.endsWith('Tool');
	}

	/**
	 * The memories found, or, as a tool, one item that says nothing matched.
	 * The Agent turns zero items into the string `""`; one item becomes a JSON
	 * array the model can read. As an action node no items stay no items,
	 * n8n's convention ("Always Output Data" exists for the other case).
	 */
	private memoriesFound(items: IDataObject[]): IDataObject[] {
		if (items.length === 0 && this.runsAsTool) return [{ message: 'No memories matched' }];
		return items;
	}

	/** An input-check failure: a `NodeOperationError` that points at the current item. */
	private refuse(message: string, description: string): never {
		throw new NodeOperationError(this.node, message, { itemIndex: this.itemIndex, description });
	}

	private param<T>(name: string, fallback?: T): T {
		return this.context.getNodeParameter(name, this.itemIndex, fallback) as T;
	}

	/** The Simplify switch; on for operations that have none. */
	private get simple(): boolean {
		return this.param<boolean>('simple', true);
	}

	/** The memories as Simplify wants them. */
	private memories(items: IDataObject[]): IDataObject[] {
		return this.simple ? items.map(simplifyMemory) : items;
	}

	/** One memory as Simplify wants it. */
	private memory(record: IDataObject | undefined): IDataObject {
		return this.memories([record ?? {}])[0];
	}

	/** The namespace as Simplify wants it. */
	private namespaceRecord(response: NamespaceResponse | undefined): IDataObject {
		const namespace = response?.namespace ?? {};
		return this.simple ? simplifyNamespace(namespace) : namespace;
	}

	/**
	 * A required string parameter, trimmed. Fails with the parameter's display
	 * name when empty. `extractValue` turns a resource locator into its value;
	 * for a plain string parameter n8n returns the string as it is.
	 */
	private required(name: string, displayName: string): string {
		const value = optional(
			this.context.getNodeParameter(name, this.itemIndex, '', { extractValue: true }),
		);
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
		// The editor enforces the minimum; an expression bypasses it.
		const limit = wholeNumber(this.param<unknown>('limit', 50));
		if (limit === undefined || limit < 1) {
			this.refuse("'Limit' must be 1 or more", 'Set Return All to list everything');
		}
		return { pageSize: Math.min(limit, MAX_PAGE_SIZE), max: limit };
	}

	/**
	 * The User ID is the one search filter the user must never be able to
	 * loosen. The API applies a single conjunction to every filter field, so a
	 * "match any" request would OR the owner away and return other users'
	 * memories. Search therefore sends no `filterOp`, and this check refuses to
	 * pass on a memory of another user should the store return one anyway.
	 */
	private ownedBy(items: IDataObject[], ownerId: string): IDataObject[] {
		const foreign = items.find((item) => item.ownerId !== undefined && item.ownerId !== ownerId);
		if (foreign) {
			throw new NodeOperationError(
				this.node,
				`The store returned a memory of user "${String(foreign.ownerId)}" for a search scoped to user "${ownerId}"`,
				{
					itemIndex: this.itemIndex,
					description:
						'The node did not pass it on. The store did not apply the User ID filter; report this to Redis.',
				},
			);
		}
		return items;
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
				// The editor caps Max Results at 1 to 100; an expression bypasses the cap.
				const maxResults = wholeNumber(this.param<unknown>('maxResults', 10));
				if (maxResults === undefined || maxResults < 1 || maxResults > MAX_PAGE_SIZE) {
					this.refuse(
						"'Max Results' must be a whole number from 1 to 100",
						'The API returns at most 100 memories per search',
					);
				}
				// Workflows saved before 0.1.0 may still carry a `filterOp` option
				// here. It is left out on purpose; see `ownedBy`.
				const options = this.param<MemoryFields & { similarityThreshold?: number }>('options', {});
				const body: IDataObject = {
					text: query,
					limit: maxResults,
					filter: memoryFilter({ ...options, ownerId }),
				};
				if (options.similarityThreshold) body.similarityThreshold = options.similarityThreshold;
				const page = await this.request<Page<IDataObject>>({
					method: 'POST',
					path: '/long-term-memory/search',
					body,
				});
				return this.memoriesFound(this.memories(this.ownedBy(page?.items ?? [], ownerId)));
			}
			case 'getAll': {
				const filter = memoryFilter(this.param<MemoryFields>('filters', {}));
				if (Object.keys(filter).length === 0) {
					this.refuse(
						'Add at least one filter',
						'The API lists memories only by User ID, Memory Type, Namespace ID, Session ID or Topics',
					);
				}
				const { pageSize, max } = this.paging();
				const memories = await collectPages<IDataObject>(
					async (pageToken) =>
						await this.request<Page<IDataObject>>({
							method: 'POST',
							path: '/long-term-memory/search',
							body: { filter, limit: pageSize, ...(pageToken ? { pageToken } : {}) },
						}),
					max,
				);
				return this.memoriesFound(this.memories(memories));
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
				return this.memory(memory);
			}
			case 'get': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const memory = await this.request<IDataObject>({
					method: 'GET',
					path: `/long-term-memory/${encodeURIComponent(memoryId)}`,
				});
				return this.memory(memory);
			}
			case 'update': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const changes = memoryRecordFields(this.param<MemoryFields>('updateFields', {}));
				if (Object.keys(changes).length === 0) {
					// n8n's request helper sends no body for `{}`, and the server
					// refuses a PATCH without one.
					this.refuse(
						"'Update Fields' is empty",
						'Add at least one of Memory Type, Namespace ID, Session ID, Text, Topics or User ID',
					);
				}
				const updated = await this.request<IDataObject>({
					method: 'PATCH',
					path: `/long-term-memory/${encodeURIComponent(memoryId)}`,
					body: changes,
				});
				return this.memory(updated);
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
				const namespaceId = this.required('namespaceId', 'Namespace');
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
				const session = await this.request<SessionResponse>({
					method: 'GET',
					path: `/session-memory/${encodeURIComponent(sessionId)}`,
					...(options.includeSummarisedEvents ? { qs: { includeSummarisedEvents: true } } : {}),
				});
				return this.simple ? simplifySession(session ?? {}) : (session ?? {});
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
							// The API needs a filter or an explicit `includeAll`.
							qs: {
								limit: pageSize,
								...(ownerId ? { filterOwnerId: ownerId } : { includeAll: true }),
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
				const createdAtMs = createdAt ? Date.parse(createdAt) : Date.now();
				if (Number.isNaN(createdAtMs)) {
					this.refuse(
						`'Created At' is not a date: "${createdAt}"`,
						'Use an ISO 8601 timestamp, for example 2024-03-15T10:00:00Z',
					);
				}
				const namespaceId = optional(additionalFields.namespaceId);
				const result = await this.request<{ event: IDataObject }>({
					method: 'POST',
					path: '/session-memory/events',
					body: {
						sessionId,
						actorId,
						role,
						content: [{ text }],
						createdAt: new Date(createdAtMs).toISOString(),
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
				if (!parentId && scope === 'PERSONAL' && !ownerId) {
					this.refuse(
						'A personal namespace needs a User ID',
						'Set User ID under Additional Fields, or choose the Shared scope',
					);
				}
				// A child inherits scope and owner from its parent; the server
				// refuses a child that names either.
				const created = await this.request<NamespaceResponse>({
					method: 'POST',
					path: '/namespaces',
					body: parentId ? { name, parentId } : { name, scope, ...(ownerId ? { ownerId } : {}) },
				});
				return this.namespaceRecord(created);
			}
			case 'get': {
				const namespaceId = this.required('namespaceId', 'Namespace');
				const fetched = await this.request<NamespaceResponse>({
					method: 'GET',
					path: `/namespaces/${encodeURIComponent(namespaceId)}`,
				});
				return this.namespaceRecord(fetched);
			}
			case 'getAll': {
				const { pageSize, max } = this.paging();
				const namespaces = await collectPages<IDataObject>(
					async (pageToken) =>
						await this.request<Page<IDataObject>>({
							method: 'GET',
							path: '/namespaces',
							qs: { limit: pageSize, ...(pageToken ? { pageToken } : {}) },
						}),
					max,
				);
				return this.simple ? namespaces.map(simplifyNamespace) : namespaces;
			}
			case 'update': {
				const namespaceId = this.required('namespaceId', 'Namespace');
				const updateFields = this.param<{ name?: string; archive?: boolean }>('updateFields', {});
				const name = optional(updateFields.name);
				// The API only archives; it never makes a namespace active again.
				const changes: IDataObject = {
					...(name ? { name } : {}),
					...(updateFields.archive ? { state: 'ARCHIVED' } : {}),
				};
				if (Object.keys(changes).length === 0) {
					this.refuse("'Update Fields' is empty", 'Add a Name, or switch Archive on');
				}
				const updated = await this.request<NamespaceResponse>({
					method: 'PATCH',
					path: `/namespaces/${encodeURIComponent(namespaceId)}`,
					body: changes,
				});
				return this.namespaceRecord(updated);
			}
			case 'delete': {
				const namespaceId = this.required('namespaceId', 'Namespace');
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
