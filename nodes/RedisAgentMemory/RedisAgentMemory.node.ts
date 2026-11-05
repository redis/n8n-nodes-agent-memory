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
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';
import {
	AGENT_MEMORY_CREDENTIAL,
	createAgentMemoryRequest,
	newIdempotencyKey,
	type AgentMemoryRequest,
} from '../shared/agentMemoryRequest';
import {
	longTermMemoryFields,
	longTermMemoryOperations,
} from './descriptions/LongTermMemoryDescription';
import { namespaceFields, namespaceOperations } from './descriptions/NamespaceDescription';
import { sessionFields, sessionOperations } from './descriptions/SessionDescription';
import { summaryViewFields, summaryViewOperations } from './descriptions/SummaryViewDescription';

/** Largest page the search endpoint serves. */
const MAX_PAGE_SIZE = 100;

/**
 * How many pages a list search reads for one filter string. The API has no
 * name search, so the node matches names itself.
 */
const MAX_SEARCH_PAGES = 10;

/** How often Wait For Result asks for a summary view result. */
const RESULT_POLL_INTERVAL_MS = 2_000;

/** The result statuses that end a Wait For Result poll. */
const SETTLED_RESULT_STATUSES = new Set(['READY', 'EMPTY', 'FAILED']);

interface Page<T> {
	items: T[];
	nextCursor?: string;
}

/** The namespace endpoints wrap their record. */
interface NamespaceResponse {
	namespace: IDataObject;
}

/** A session as `GET /sessions/{id}` returns it, as far as Simplify reads it. */
interface SessionResponse extends IDataObject {
	events?: Array<IDataObject & { content?: Array<{ text?: string }> }>;
	summary?: { text?: string };
	namespaceId?: string;
}

/** Response of the bulk delete and move endpoints; a failed ID comes with its own Problem Details. */
interface BulkResult {
	deleted?: string[];
	moved?: string[];
	errors?: Array<{ memoryId: string; title?: string; detail?: string; status?: number }>;
}

/** Response of `PUT /memories/{memoryId}`. */
interface UpsertResult {
	memoryId: string;
	created: boolean;
}

/** A summary view as the API returns it, as far as Simplify reads it. */
interface SummaryViewResponse extends IDataObject {
	output?: { format?: string };
	refreshPolicy?: { mode?: string };
}

/** One partition's result from `GET /summary-views/{viewId}/result`. */
interface SummaryViewResult extends IDataObject {
	status?: string;
	value?: { text?: string; data?: IDataObject };
}

/** One evidence entry of a source: document chunks (`evidence`) or session events (`sessionEvidence`). */
interface SourceEvidence extends IDataObject {
	capturedAt?: string;
	eventIds?: string[];
}

/** Where a memory came from, as `GET /memories/{memoryId}/sources` returns it. */
interface MemorySourceLink extends IDataObject {
	sourceId?: string;
	kind?: string;
	identity?: { documentId?: string; revision?: string };
	session?: { sessionId?: string; ownerId?: string };
	evidence?: SourceEvidence[];
	sessionEvidence?: SourceEvidence[];
	evidenceNextCursor?: string;
}

/** The keys that select one partition of a summary view. */
interface ScopeFields {
	ownerId?: string;
	sessionId?: string;
	namespaceId?: string;
	memoryType?: string;
}

/** The definition fields of a summary view, as Create and Update collect them. */
interface SummaryViewFields extends MemoryFields {
	name?: string;
	description?: string;
	visibility?: string;
	groupBy?: string[];
	outputFormat?: string;
	instructions?: string;
	schema?: unknown;
	refreshMode?: string;
	debounceSeconds?: number;
	reconcileIntervalSeconds?: number;
	maxPartitions?: number;
	timeWindowSeconds?: number;
	state?: string;
	clearFilter?: boolean;
	clearTimeWindow?: boolean;
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
	if (namespaceId) filter.namespaceId = { eq: namespaceId };
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
	if (namespaceId) record.namespaceId = namespaceId;
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

/** A positive whole number, or undefined: the editor's 0 means "not set". */
function positive(value: unknown): number | undefined {
	const number = wholeNumber(value);
	return number !== undefined && number > 0 ? number : undefined;
}

/** The scope keys that are set, as the result and refresh endpoints take them. */
function scopeKeys(scope: ScopeFields): IDataObject {
	return compact({
		ownerId: optional(scope.ownerId),
		sessionId: optional(scope.sessionId),
		namespaceId: optional(scope.namespaceId),
		memoryType: optional(scope.memoryType),
	});
}

/**
 * A source with its session or document at the top level and the event IDs
 * of all its session evidence in one list.
 */
function simplifySource(link: MemorySourceLink): IDataObject {
	const evidence = [...(link.sessionEvidence ?? []), ...(link.evidence ?? [])];
	const eventIds = (link.sessionEvidence ?? []).flatMap((entry) => entry.eventIds ?? []);
	return compact({
		sourceId: link.sourceId,
		kind: link.kind,
		sessionId: link.session?.sessionId,
		documentId: link.identity?.documentId,
		revision: link.identity?.revision,
		eventIds: eventIds.length > 0 ? eventIds : undefined,
		evidenceCount: evidence.length,
		capturedAt: evidence.find((entry) => entry.capturedAt)?.capturedAt,
	});
}

/** The short form of a source that Include Sources keeps on a memory. */
function sourceReference(link: MemorySourceLink): IDataObject {
	const { sourceId, kind, sessionId, documentId, eventIds } = simplifySource(link);
	return compact({ sourceId, kind, sessionId, documentId, eventIds });
}

/**
 * The fields of a memory most workflows read. Create's echo of its request
 * body has the same keys, so Create and Get agree. With `includeSources`, the
 * sources the record carries are kept in short form.
 */
function simplifyMemory(memory: IDataObject, includeSources = false): IDataObject {
	const sources = memory.sources as MemorySourceLink[] | undefined;
	return compact({
		memoryId: memory.memoryId,
		text: memory.text,
		ownerId: memory.ownerId,
		memoryType: memory.memoryType,
		topics: memory.topics,
		namespaceId: memory.namespaceId,
		sessionId: memory.sessionId,
		createdAt: memory.createdAt,
		sources: includeSources ? (sources ?? []).map(sourceReference) : undefined,
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

/** The fields of a summary view most workflows read. */
function simplifySummaryView(view: SummaryViewResponse): IDataObject {
	return compact({
		viewId: view.viewId,
		name: view.name,
		visibility: view.visibility,
		groupBy: view.groupBy,
		state: view.state,
		format: view.output?.format,
		refreshMode: view.refreshPolicy?.mode,
		updatedAt: view.updatedAt,
	});
}

/** A summary view result with the summary itself at the top level. */
function simplifySummaryResult(result: SummaryViewResult): IDataObject {
	return compact({
		viewId: result.viewId,
		status: result.status,
		stale: result.stale,
		text: result.value?.text,
		data: result.value?.data,
		computedAt: result.computedAt,
		sourceMemoryCount: result.sourceMemoryCount,
		summarizedMemoryCount: result.summarizedMemoryCount,
		truncated: result.truncated,
		sourceMemoryIds: result.sourceMemoryIds,
		errorCode: result.errorCode,
	});
}

/** A session with the summary text and one line of text per event. */
function simplifySession(session: SessionResponse): IDataObject {
	return compact({
		sessionId: session.sessionId,
		ownerId: session.ownerId,
		namespaceId: session.namespaceId,
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

/** Follows `nextCursor` until the pages run out or `max` items are collected. */
async function collectPages<T>(
	fetchPage: (cursor: string | undefined) => Promise<Page<T> | undefined>,
	max: number | undefined,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await fetchPage(cursor);
		items.push(...(page?.items ?? []));
		cursor = page?.nextCursor;
	} while (cursor && (max === undefined || items.length < max));
	return max === undefined ? items : items.slice(0, max);
}

/** Fails when a bulk endpoint did not apply the operation to `memoryId`. */
function assertBulkApplied(
	node: INode,
	itemIndex: number,
	result: BulkResult | undefined,
	key: 'deleted' | 'moved',
	memoryId: string,
): void {
	const failure = result?.errors?.find((error) => error.memoryId === memoryId);
	if (failure) {
		const reason = failure.detail ?? failure.title ?? 'the server gave no reason';
		throw new NodeOperationError(node, `Memory "${memoryId}" was not ${key}: ${reason}`, {
			itemIndex,
			...(failure.title && failure.detail
				? { description: `${failure.title}${failure.status ? ` (HTTP ${failure.status})` : ''}` }
				: {}),
		});
	}
	if (!result?.[key]?.includes(memoryId)) {
		throw new NodeOperationError(node, `Memory "${memoryId}" was not ${key}`, {
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
					{ name: 'Summary View', value: 'summaryView' },
				],
				default: 'longTermMemory',
			},
			...longTermMemoryOperations,
			...longTermMemoryFields,
			...namespaceOperations,
			...namespaceFields,
			...sessionOperations,
			...sessionFields,
			...summaryViewOperations,
			...summaryViewFields,
		],
	};

	methods = {
		listSearch: {
			searchNamespaces,
			searchSummaryViews,
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
	if (resource === 'summaryView') return await run.summaryView(operation);
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
	return await searchRecords(this, '/namespaces', 'namespaceId', filter, paginationToken);
}

/** The store's summary views for the View locator's "From List" mode; see `searchNamespaces`. */
async function searchSummaryViews(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await searchRecords(this, '/summary-views', 'viewId', filter, paginationToken);
}

/**
 * One list-search page of the records at `path`, each shown by its `name`
 * and valued by its `idKey`. With a filter string, it reads up to
 * `MAX_SEARCH_PAGES` pages and keeps the records whose name contains the
 * string, in any case.
 */
async function searchRecords(
	context: ILoadOptionsFunctions,
	path: string,
	idKey: string,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const request = await createAgentMemoryRequest(context, 0);
	const needle = (filter ?? '').trim().toLowerCase();
	const results: INodeListSearchResult['results'] = [];
	let cursor = paginationToken;
	for (let pages = 0; pages < (needle ? MAX_SEARCH_PAGES : 1); pages++) {
		const page = await request<Page<IDataObject>>({
			method: 'GET',
			path,
			qs: { limit: MAX_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
		});
		for (const item of page?.items ?? []) {
			const name = String(item.name ?? item[idKey] ?? '');
			if (needle && !name.toLowerCase().includes(needle)) continue;
			results.push({ name, value: String(item[idKey]) });
		}
		cursor = page?.nextCursor;
		if (!cursor) break;
	}
	return { results, ...(cursor ? { paginationToken: cursor } : {}) };
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
	 * The items found (memories or sources), or, as a tool, one item that says nothing matched.
	 * The Agent turns zero items into the string `""`; one item becomes a JSON
	 * array the model can read. As an action node no items stay no items,
	 * n8n's convention ("Always Output Data" exists for the other case).
	 */
	private found(items: IDataObject[], message = 'No memories matched'): IDataObject[] {
		if (items.length === 0 && this.runsAsTool) return [{ message }];
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

	/** The memories as Simplify and Include Sources want them. */
	private memories(items: IDataObject[]): IDataObject[] {
		if (!this.simple) return items;
		const includeSources = this.param<boolean>('includeSources', false);
		return items.map((item) => simplifyMemory(item, includeSources));
	}

	/**
	 * The source with all its evidence. The list returns the first page of
	 * evidence inline; when `evidenceNextCursor` is set, the rest comes from
	 * the source's evidence endpoint.
	 */
	private async withAllEvidence(
		sourcesPath: string,
		link: MemorySourceLink,
	): Promise<MemorySourceLink> {
		if (!link.evidenceNextCursor || !link.sourceId) return link;
		const evidence = [...(link.evidence ?? [])];
		const sessionEvidence = [...(link.sessionEvidence ?? [])];
		let cursor: string | undefined = link.evidenceNextCursor;
		while (cursor) {
			const page: { source?: MemorySourceLink } | undefined = await this.request({
				method: 'GET',
				path: `${sourcesPath}/${encodeURIComponent(link.sourceId)}/evidence`,
				qs: { limit: MAX_PAGE_SIZE, cursor },
			});
			evidence.push(...(page?.source?.evidence ?? []));
			sessionEvidence.push(...(page?.source?.sessionEvidence ?? []));
			cursor = page?.source?.evidenceNextCursor;
		}
		// Every page has been read, so the cursor is dropped.
		return compact({
			...link,
			evidenceNextCursor: undefined,
			evidence: evidence.length > 0 ? evidence : undefined,
			sessionEvidence: sessionEvidence.length > 0 ? sessionEvidence : undefined,
		}) as MemorySourceLink;
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
	 * memories. Search therefore sends no `filter.op`, and this check refuses to
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
					query,
					limit: maxResults,
					filter: memoryFilter({ ...options, ownerId }),
				};
				if (options.similarityThreshold) body.minScore = options.similarityThreshold;
				const page = await this.request<Page<IDataObject>>({
					method: 'POST',
					path: '/memories/search',
					body,
				});
				return this.found(this.memories(this.ownedBy(page?.items ?? [], ownerId)));
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
					async (cursor) =>
						await this.request<Page<IDataObject>>({
							method: 'POST',
							path: '/memories/search',
							body: { filter, limit: pageSize, ...(cursor ? { cursor } : {}) },
						}),
					max,
				);
				return this.found(this.memories(memories));
			}
			case 'create': {
				const text = this.required('text', 'Text');
				const ownerId = this.required('ownerId', 'User ID');
				const additionalFields = this.param<MemoryFields>('additionalFields', {});
				const memoryId = optional(additionalFields.id) ?? generateMemoryId();
				const fields = memoryRecordFields({ ...additionalFields, text, ownerId });
				// The upsert creates the memory or, when the ID exists, replaces it,
				// which is what the Memory ID field promises. The bulk endpoint would
				// refuse an existing ID instead.
				const result = await this.request<UpsertResult>({
					method: 'PUT',
					path: `/memories/${encodeURIComponent(memoryId)}`,
					body: { idempotencyKey: newIdempotencyKey(), ...fields },
				});
				if (result?.memoryId !== memoryId) {
					throw new NodeOperationError(this.node, `Memory "${memoryId}" was not created`, {
						itemIndex: this.itemIndex,
						description: 'The server accepted the request, but its response does not name the ID',
					});
				}
				return this.memory({ memoryId, ...fields });
			}
			case 'get': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const memory = await this.request<IDataObject>({
					method: 'GET',
					path: `/memories/${encodeURIComponent(memoryId)}`,
				});
				return this.memory(memory);
			}
			case 'getSources': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const sourcesPath = `/memories/${encodeURIComponent(memoryId)}/sources`;
				const { pageSize, max } = this.paging();
				const links = await collectPages<MemorySourceLink>(
					async (cursor) =>
						await this.request<Page<MemorySourceLink>>({
							method: 'GET',
							path: sourcesPath,
							qs: { limit: pageSize, ...(cursor ? { cursor } : {}) },
						}),
					max,
				);
				const sources: MemorySourceLink[] = [];
				for (const link of links) sources.push(await this.withAllEvidence(sourcesPath, link));
				return this.found(
					this.simple ? sources.map(simplifySource) : sources,
					'The memory has no sources',
				);
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
					path: `/memories/${encodeURIComponent(memoryId)}`,
					body: { idempotencyKey: newIdempotencyKey(), ...changes },
				});
				return this.memory(updated);
			}
			case 'delete': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const result = await this.request<BulkResult>({
					method: 'POST',
					path: '/memories/bulk-delete',
					body: { memoryIds: [memoryId] },
				});
				assertBulkApplied(this.node, this.itemIndex, result, 'deleted', memoryId);
				return { deleted: true, memoryId };
			}
			case 'move': {
				const memoryId = this.required('memoryId', 'Memory ID');
				const namespaceId = this.required('namespaceId', 'Namespace');
				const result = await this.request<BulkResult>({
					method: 'POST',
					path: '/memories/move',
					body: { memoryIds: [memoryId], namespaceId },
				});
				assertBulkApplied(this.node, this.itemIndex, result, 'moved', memoryId);
				return { moved: true, memoryId, namespaceId };
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
					path: `/sessions/${encodeURIComponent(sessionId)}`,
					...(options.includeSummarisedEvents ? { qs: { includeSummarisedEvents: true } } : {}),
				});
				return this.simple ? simplifySession(session ?? {}) : (session ?? {});
			}
			case 'getAll': {
				const filters = this.param<{ ownerId?: string }>('filters', {});
				const ownerId = optional(filters.ownerId);
				const { pageSize, max } = this.paging();
				// Each item is `{ sessionId, ownerId?, namespaceId?, createdAt?, updatedAt? }`.
				return await collectPages<IDataObject>(
					async (cursor) =>
						await this.request<Page<IDataObject>>({
							method: 'GET',
							path: '/sessions',
							// The API needs a filter or an explicit `includeAll`.
							qs: {
								limit: pageSize,
								...(ownerId ? { ownerId } : { includeAll: true }),
								...(cursor ? { cursor } : {}),
							},
						}),
					max,
				);
			}
			case 'delete': {
				const sessionId = this.required('sessionId', 'Session ID');
				await this.request({
					method: 'DELETE',
					path: `/sessions/${encodeURIComponent(sessionId)}`,
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
				// The server creates the session on its first event.
				const result = await this.request<{ event: IDataObject }>({
					method: 'POST',
					path: `/sessions/${encodeURIComponent(sessionId)}/events`,
					body: {
						idempotencyKey: newIdempotencyKey(),
						actorId,
						role,
						content: [{ text }],
						createdAt: new Date(createdAtMs).toISOString(),
						...(namespaceId ? { namespaceId } : {}),
					},
				});
				return result?.event ?? {};
			}
			case 'deleteEvent': {
				const sessionId = this.required('sessionId', 'Session ID');
				const eventId = this.required('eventId', 'Event ID');
				await this.request({
					method: 'DELETE',
					path: `/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}`,
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
					async (cursor) =>
						await this.request<Page<IDataObject>>({
							method: 'GET',
							path: '/namespaces',
							qs: { limit: pageSize, ...(cursor ? { cursor } : {}) },
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
	/** The summary view as Simplify wants it. */
	private summaryViewRecord(view: SummaryViewResponse | undefined): IDataObject {
		return this.simple ? simplifySummaryView(view ?? {}) : (view ?? {});
	}

	/** The result as Simplify wants it. */
	private summaryResultRecord(result: SummaryViewResult | undefined): IDataObject {
		return this.simple ? simplifySummaryResult(result ?? {}) : (result ?? {});
	}

	/** The value of a Schema field as an object: the editor gives a string, an expression may give the object. */
	private schemaObject(value: unknown): IDataObject | undefined {
		if (typeof value === 'object' && value !== null) return value as IDataObject;
		const text = optional(value);
		if (!text) return undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null) return parsed as IDataObject;
		} catch {
			// Reported below.
		}
		this.refuse("'Schema' is not a JSON object", 'Give the schema as { "fields": [...] }');
	}

	/**
	 * The create or update body from the definition fields. Nested objects
	 * (`output`, `refreshPolicy`, `evictionPolicy`, `filter`) are sent only
	 * when one of their fields is set, so an update changes nothing else.
	 */
	private summaryViewBody(fields: SummaryViewFields): IDataObject {
		const output = compact({
			format: optional(fields.outputFormat),
			instructions: optional(fields.instructions),
			schema: this.schemaObject(fields.schema),
		});
		const refreshPolicy = compact({
			mode: optional(fields.refreshMode),
			debounceSeconds: positive(fields.debounceSeconds),
			reconcileIntervalSeconds: positive(fields.reconcileIntervalSeconds),
		});
		const maxPartitions = positive(fields.maxPartitions);
		const filter = memoryFilter(fields);
		return compact({
			name: optional(fields.name),
			description: optional(fields.description),
			visibility: optional(fields.visibility),
			groupBy: fields.groupBy && fields.groupBy.length > 0 ? fields.groupBy : undefined,
			output: Object.keys(output).length > 0 ? output : undefined,
			refreshPolicy: Object.keys(refreshPolicy).length > 0 ? refreshPolicy : undefined,
			evictionPolicy: maxPartitions ? { maxPartitions } : undefined,
			timeWindowSeconds: positive(fields.timeWindowSeconds),
			filter: Object.keys(filter).length > 0 ? filter : undefined,
			state: optional(fields.state),
			clearFilter: fields.clearFilter ? true : undefined,
			clearTimeWindow: fields.clearTimeWindow ? true : undefined,
		});
	}

	/**
	 * One partition's result. With Wait For Result on, asks again every two
	 * seconds until the status is READY, EMPTY or FAILED, and fails once Max
	 * Wait has passed. A FAILED result is returned as an item: the workflow
	 * decides what to do with it.
	 */
	private async summaryResult(viewId: string, scope: IDataObject): Promise<IDataObject> {
		const options = this.param<{ includeSourceMemoryIds?: boolean }>('options', {});
		const qs = {
			...scope,
			...(options.includeSourceMemoryIds ? { includeSourceMemoryIds: true } : {}),
		} as Record<string, string | boolean>;
		const fetchResult = async () =>
			await this.request<SummaryViewResult>({
				method: 'GET',
				path: `/summary-views/${encodeURIComponent(viewId)}/result`,
				qs,
			});
		if (!this.param<boolean>('waitForResult', false)) {
			return this.summaryResultRecord(await fetchResult());
		}
		const maxWait = wholeNumber(this.param<unknown>('maxWait', 60));
		if (maxWait === undefined || maxWait < 1) {
			this.refuse("'Max Wait' must be 1 or more", 'The number of seconds to wait for the result');
		}
		const deadline = Date.now() + maxWait * 1000;
		for (;;) {
			const result = await fetchResult();
			if (SETTLED_RESULT_STATUSES.has(result?.status ?? '')) {
				return this.summaryResultRecord(result);
			}
			if (Date.now() + RESULT_POLL_INTERVAL_MS > deadline) {
				throw new NodeOperationError(
					this.node,
					`The summary was not ready after ${maxWait} seconds (status ${result?.status ?? 'unknown'})`,
					{
						itemIndex: this.itemIndex,
						description:
							'A manual-refresh view computes a summary only after Refresh. Run Refresh first, or raise Max Wait.',
					},
				);
			}
			await sleep(RESULT_POLL_INTERVAL_MS);
		}
	}

	async summaryView(operation: string): Promise<IDataObject | IDataObject[]> {
		switch (operation) {
			case 'getResult': {
				const viewId = this.required('viewId', 'View');
				const scope = scopeKeys(this.param<ScopeFields>('scope', {}));
				return await this.summaryResult(viewId, scope);
			}
			case 'refresh': {
				const viewId = this.required('viewId', 'View');
				const target = this.param<string>('target', 'PARTITION');
				const scope = target === 'PARTITION' ? scopeKeys(this.param<ScopeFields>('scope', {})) : {};
				const accepted = await this.request<IDataObject>({
					method: 'POST',
					path: `/summary-views/${encodeURIComponent(viewId)}/refresh`,
					body: { target, ...(Object.keys(scope).length > 0 ? { scope } : {}) },
				});
				if (this.param<boolean>('waitForResult', false)) {
					return await this.summaryResult(viewId, scope);
				}
				return accepted ?? { viewId, target, accepted: true };
			}
			case 'get': {
				const viewId = this.required('viewId', 'View');
				const view = await this.request<SummaryViewResponse>({
					method: 'GET',
					path: `/summary-views/${encodeURIComponent(viewId)}`,
				});
				return this.summaryViewRecord(view);
			}
			case 'getAll': {
				const { pageSize, max } = this.paging();
				const views = await collectPages<SummaryViewResponse>(
					async (cursor) =>
						await this.request<Page<SummaryViewResponse>>({
							method: 'GET',
							path: '/summary-views',
							qs: { limit: pageSize, ...(cursor ? { cursor } : {}) },
						}),
					max,
				);
				return views.map((view) => this.summaryViewRecord(view));
			}
			case 'create': {
				const name = this.required('name', 'Name');
				const groupBy = this.param<string[]>('groupBy', []);
				if (!Array.isArray(groupBy) || groupBy.length === 0) {
					this.refuse("'Group By' is empty", 'Choose at least one key to group the summaries by');
				}
				const body = this.summaryViewBody({
					...this.param<SummaryViewFields>('additionalFields', {}),
					name,
					groupBy,
					outputFormat: this.param<string>('outputFormat', 'TEXT'),
					instructions: this.param<string>('instructions', ''),
					refreshMode: this.param<string>('refreshMode', 'MANUAL'),
				});
				const created = await this.request<SummaryViewResponse>({
					method: 'POST',
					path: '/summary-views',
					body: { source: 'LONG_TERM', ...body },
				});
				return this.summaryViewRecord(created);
			}
			case 'update': {
				const viewId = this.required('viewId', 'View');
				const changes = this.summaryViewBody(this.param<SummaryViewFields>('updateFields', {}));
				if (Object.keys(changes).length === 0) {
					this.refuse("'Update Fields' is empty", 'Add at least one field to change');
				}
				const updated = await this.request<SummaryViewResponse>({
					method: 'PATCH',
					path: `/summary-views/${encodeURIComponent(viewId)}`,
					body: changes,
				});
				return this.summaryViewRecord(updated);
			}
			case 'delete': {
				const viewId = this.required('viewId', 'View');
				// The server answers 202: the view goes to DELETING and disappears shortly after.
				await this.request({
					method: 'DELETE',
					path: `/summary-views/${encodeURIComponent(viewId)}`,
				});
				return { deleted: true, viewId };
			}
			default:
				return this.unknownOperation('summaryView', operation);
		}
	}
}
