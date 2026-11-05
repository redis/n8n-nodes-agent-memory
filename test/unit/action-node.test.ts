import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { RedisAgentMemory } from '../../nodes/RedisAgentMemory/RedisAgentMemory.node';

interface Setup {
	parameters: Record<string, unknown>;
	respond?: (options: IHttpRequestOptions, callIndex: number) => unknown;
	continueOnFail?: boolean;
	items?: number;
	/** The node n8n reports; the tool face has a type that ends in `Tool`. */
	node?: INode;
}

const NODE: INode = {
	id: 'action-node',
	name: 'Redis Agent Memory',
	type: '@redis/n8n-nodes-agent-memory.redisAgentMemory',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** The same node, as the AI Agent runs it: n8n appends `Tool` to the type. */
const TOOL_NODE: INode = { ...NODE, type: `${NODE.type}Tool` };

const BASE = 'https://memory.example.com/iris/data/v1/agent-memory/stores/store-1';

/** Every write carries a fresh idempotency key; the tests only check that one is there. */
const ANY_KEY = expect.any(String) as string;

function httpError(status: number, message = `Request failed with status code ${status}`) {
	return Object.assign(new Error(message), { httpCode: String(status), response: { status } });
}

/**
 * Runs `execute` with fixed parameters for every item and records the HTTP
 * calls. The stub's `getNodeParameter` ignores the options argument, so a
 * test gives a Namespace locator as the plain string n8n would extract from
 * it with `extractValue`, and a missing `simple` falls back to true, as in n8n.
 */
async function run({
	parameters,
	respond = () => ({}),
	continueOnFail = false,
	items = 1,
	node = NODE,
}: Setup) {
	const requests: IHttpRequestOptions[] = [];
	const ctx = {
		getNode: () => node,
		getInputData: () => Array.from({ length: items }, (_, i) => ({ json: { i } })),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in parameters ? parameters[name] : fallback,
		getCredentials: async () => ({
			serverUrl: 'https://memory.example.com/',
			storeId: 'store-1',
			apiKey: 'secret',
		}),
		continueOnFail: () => continueOnFail,
		helpers: {
			async httpRequestWithAuthentication(_credentialType: string, options: IHttpRequestOptions) {
				requests.push(options);
				return await respond(options, requests.length - 1);
			},
		},
	} as unknown as IExecuteFunctions;

	const [output] = await new RedisAgentMemory().execute.call(ctx);
	return {
		output: output.map((item) => item.json),
		paired: output.map((i) => i.pairedItem),
		requests,
	};
}

const record = (memoryId: string, text: string) => ({
	memoryId,
	text,
	ownerId: 'user-1',
	createdAt: 'x',
	updatedAt: 'x',
});

/** A memory as the API returns it, with the fields Simplify drops. */
const fullRecord = {
	memoryId: 'm1',
	text: 'Likes spicy food',
	ownerId: 'user-1',
	memoryType: 'semantic',
	topics: ['food'],
	namespaceId: 'ns-1',
	sessionId: 's1',
	createdAt: '2026-11-04T10:00:00Z',
	updatedAt: '2026-11-04T10:00:00Z',
	revision: '64ce1ff4a9d94cb58df95b4abf014396',
};

/** The same memory with Simplify on. */
const simpleRecord = {
	memoryId: 'm1',
	text: 'Likes spicy food',
	ownerId: 'user-1',
	memoryType: 'semantic',
	topics: ['food'],
	namespaceId: 'ns-1',
	sessionId: 's1',
	createdAt: '2026-11-04T10:00:00Z',
};

describe('RedisAgentMemory: Long-Term Memory', () => {
	it('searches by meaning, scoped to the user, and returns one item per memory', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'search',
				query: 'What food does the user like?',
				ownerId: 'user-1',
				maxResults: 3,
				options: {
					namespaceId: 'ns-1',
					topics: 'food, travel',
					similarityThreshold: 0.4,
				},
			},
			respond: () => ({ items: [record('m1', 'Likes spicy food'), record('m2', 'Vegetarian')] }),
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/memories/search`,
			body: {
				query: 'What food does the user like?',
				limit: 3,
				minScore: 0.4,
				filter: {
					ownerId: { eq: 'user-1' },
					namespaceId: { eq: 'ns-1' },
					topics: { in: ['food', 'travel'] },
				},
			},
		});
		expect(output.map((m) => m.text)).toEqual(['Likes spicy food', 'Vegetarian']);
	});

	it('simplifies search results by default and returns the raw records with Simplify off', async () => {
		const search = {
			resource: 'longTermMemory',
			operation: 'search',
			query: 'q',
			ownerId: 'user-1',
		};

		const simplified = await run({
			parameters: search,
			respond: () => ({ items: [fullRecord] }),
		});
		expect(simplified.output).toEqual([simpleRecord]);

		const raw = await run({
			parameters: { ...search, simple: false },
			respond: () => ({ items: [fullRecord] }),
		});
		expect(raw.output).toEqual([fullRecord]);
	});

	// Older workflows may still carry a Filter Match option. The API applies one
	// conjunction to every filter, so "any" would OR the User ID away; the node
	// never sends it.
	it('ignores a Filter Match left in an older workflow and a zero threshold', async () => {
		const { requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'search',
				query: 'q',
				ownerId: 'user-1',
				options: { filterOp: 'any', similarityThreshold: 0 },
			},
			respond: () => ({ items: [] }),
		});

		expect(requests[0].body).toEqual({
			query: 'q',
			limit: 10,
			filter: { ownerId: { eq: 'user-1' } },
		});
	});

	it('refuses to pass on a search result that belongs to another user', async () => {
		const call = run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'search',
				query: 'q',
				ownerId: 'user-1',
			},
			respond: () => ({
				items: [record('m1', 'Mine'), { ...record('m2', 'Theirs'), ownerId: 'user-2' }],
			}),
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: expect.stringContaining('user-2'),
		});
	});

	it('refuses to search without a user', async () => {
		await expect(
			run({
				parameters: { resource: 'longTermMemory', operation: 'search', query: 'q', ownerId: ' ' },
			}),
		).rejects.toThrow("'User ID' is empty");
	});

	// The editor caps Max Results at 100; an expression bypasses the cap.
	it.each([500, 0, 2.5, 'ten'])('refuses Max Results of %s before calling the API', async (max) => {
		const call = run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'search',
				query: 'q',
				ownerId: 'user-1',
				maxResults: max,
			},
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: "'Max Results' must be a whole number from 1 to 100",
			context: { itemIndex: 0 },
		});
	});

	it('as a tool, outputs one item that says nothing matched when a search finds nothing', async () => {
		const { output } = await run({
			node: TOOL_NODE,
			parameters: { resource: 'longTermMemory', operation: 'search', query: 'q', ownerId: 'u' },
			respond: () => ({ items: [] }),
		});

		expect(output).toEqual([{ message: 'No memories matched' }]);
	});

	it('as an action node, outputs no items when a search finds nothing', async () => {
		const { output } = await run({
			parameters: { resource: 'longTermMemory', operation: 'search', query: 'q', ownerId: 'u' },
			respond: () => ({ items: [] }),
		});

		expect(output).toEqual([]);
	});

	it('as a tool, outputs one item that says nothing matched when Get Many finds nothing', async () => {
		const { output } = await run({
			node: TOOL_NODE,
			parameters: { resource: 'longTermMemory', operation: 'getAll', filters: { ownerId: 'u' } },
			respond: () => ({ items: [] }),
		});

		expect(output).toEqual([{ message: 'No memories matched' }]);
	});

	it('refuses Get Many without a filter before calling the API', async () => {
		const call = run({
			parameters: { resource: 'longTermMemory', operation: 'getAll', filters: { topics: ' , ' } },
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: 'Add at least one filter',
			description:
				'The API lists memories only by User ID, Memory Type, Namespace ID, Session ID or Topics',
			context: { itemIndex: 0 },
		});
	});

	it('refuses a Limit below 1 before calling the API', async () => {
		const call = run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'getAll',
				returnAll: false,
				limit: 0,
				filters: { ownerId: 'user-1' },
			},
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: "'Limit' must be 1 or more",
			context: { itemIndex: 0 },
		});
	});

	it('gets many by following cursors until the limit', async () => {
		const pages = [
			{ items: [record('m1', 'a'), record('m2', 'b')], nextCursor: 'p2' },
			{ items: [record('m3', 'c'), record('m4', 'd')], nextCursor: 'p3' },
		];
		const { output, requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'getAll',
				returnAll: false,
				limit: 3,
				filters: { ownerId: 'user-1', memoryType: 'preference' },
			},
			respond: (_options, call) => pages[call],
		});

		expect(requests.map((r) => r.body)).toEqual([
			{ filter: { ownerId: { eq: 'user-1' }, memoryType: { eq: 'preference' } }, limit: 3 },
			{
				filter: { ownerId: { eq: 'user-1' }, memoryType: { eq: 'preference' } },
				limit: 3,
				cursor: 'p2',
			},
		]);
		expect(requests.map((r) => r.url)).toEqual([
			`${BASE}/memories/search`,
			`${BASE}/memories/search`,
		]);
		expect(output.map((m) => m.memoryId)).toEqual(['m1', 'm2', 'm3']);
	});

	it('gets all pages when Return All is on', async () => {
		const pages = [
			{ items: [record('m1', 'a')], nextCursor: 'p2' },
			{ items: [record('m2', 'b')] },
		];
		const { output, requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'getAll',
				returnAll: true,
				filters: { ownerId: 'user-1' },
			},
			respond: (_options, call) => pages[call],
		});

		expect(requests.map((r) => (r.body as { limit: number }).limit)).toEqual([100, 100]);
		expect(output.map((m) => m.memoryId)).toEqual(['m1', 'm2']);
	});

	/** The memory ID at the end of an upsert URL. */
	const idInUrl = (url: string | undefined) =>
		decodeURIComponent(String(url).split('/').pop() ?? '');

	it('creates a memory with a generated ID through the upsert and returns what it stored', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'create',
				text: 'The user is vegetarian',
				ownerId: 'user-1',
				additionalFields: { memoryType: 'preference', topics: 'food', namespaceId: 'ns-1' },
			},
			respond: (options) => ({ memoryId: idInUrl(options.url), created: true }),
		});

		const memoryId = idInUrl(requests[0].url);
		expect(memoryId).toMatch(/^n8n-[a-z0-9]+-[a-z0-9]+$/);
		expect(requests[0]).toMatchObject({
			method: 'PUT',
			url: `${BASE}/memories/${memoryId}`,
			body: {
				idempotencyKey: ANY_KEY,
				text: 'The user is vegetarian',
				ownerId: 'user-1',
				memoryType: 'preference',
				topics: ['food'],
				namespaceId: 'ns-1',
			},
		});
		// Create echoes what it sent through the same mapper as Get, so the two
		// agree; there is no `createdAt` and no idempotency key in the output.
		expect(output[0]).toEqual({
			memoryId,
			text: 'The user is vegetarian',
			ownerId: 'user-1',
			memoryType: 'preference',
			topics: ['food'],
			namespaceId: 'ns-1',
		});
	});

	it('returns the record as sent from Create with Simplify off', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'create',
				text: 'x',
				ownerId: 'user-1',
				simple: false,
				additionalFields: { id: 'mem 1', namespaceId: 'ns-1' },
			},
			respond: () => ({ memoryId: 'mem 1', created: false }),
		});

		expect(requests[0]).toMatchObject({ method: 'PUT', url: `${BASE}/memories/mem%201` });
		expect(output[0]).toEqual({
			memoryId: 'mem 1',
			text: 'x',
			ownerId: 'user-1',
			namespaceId: 'ns-1',
		});
	});

	it('fails when the upsert response names another memory', async () => {
		await expect(
			run({
				parameters: {
					resource: 'longTermMemory',
					operation: 'create',
					text: 'x',
					ownerId: 'user-1',
					additionalFields: { id: 'mem-1' },
				},
				respond: () => ({ memoryId: 'mem-2', created: true }),
			}),
		).rejects.toThrow('Memory "mem-1" was not created');
	});

	it('gets, updates, deletes and moves one memory by ID', async () => {
		const get = await run({
			parameters: { resource: 'longTermMemory', operation: 'get', memoryId: 'm 1' },
			respond: () => fullRecord,
		});
		expect(get.requests[0]).toMatchObject({ method: 'GET', url: `${BASE}/memories/m%201` });
		expect(get.output).toEqual([simpleRecord]);

		const rawGet = await run({
			parameters: { resource: 'longTermMemory', operation: 'get', memoryId: 'm1', simple: false },
			respond: () => fullRecord,
		});
		expect(rawGet.output).toEqual([fullRecord]);

		const update = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'update',
				memoryId: 'm1',
				updateFields: { text: 'b', topics: 'x, y', ownerId: 'user-2' },
			},
			respond: () => ({ ...fullRecord, text: 'b' }),
		});
		expect(update.requests[0]).toMatchObject({
			method: 'PATCH',
			url: `${BASE}/memories/m1`,
			body: { idempotencyKey: ANY_KEY, text: 'b', topics: ['x', 'y'], ownerId: 'user-2' },
		});
		expect(update.output).toEqual([{ ...simpleRecord, text: 'b' }]);

		const del = await run({
			parameters: { resource: 'longTermMemory', operation: 'delete', memoryId: 'm1' },
			respond: () => ({ deleted: ['m1'] }),
		});
		expect(del.requests[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/memories/bulk-delete`,
			body: { memoryIds: ['m1'] },
		});
		expect(del.output).toEqual([{ deleted: true, memoryId: 'm1' }]);

		// `namespaceId` is a Namespace locator; the stub hands over its extracted value.
		const move = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'move',
				memoryId: 'm1',
				namespaceId: 'ns-2',
			},
			respond: () => ({ moved: ['m1'] }),
		});
		expect(move.requests[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/memories/move`,
			body: { memoryIds: ['m1'], namespaceId: 'ns-2' },
		});
		expect(move.output).toEqual([{ moved: true, memoryId: 'm1', namespaceId: 'ns-2' }]);
	});

	it('fails when the bulk response does not list the ID', async () => {
		await expect(
			run({
				parameters: { resource: 'longTermMemory', operation: 'delete', memoryId: 'm1' },
				respond: () => ({ deleted: [] }),
			}),
		).rejects.toThrow('Memory "m1" was not deleted');
	});

	it("quotes the bulk response's own reason when it names the ID as failed", async () => {
		const call = run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'move',
				memoryId: 'm1',
				namespaceId: 'ns-2',
			},
			respond: () => ({
				moved: [],
				errors: [
					{
						memoryId: 'm1',
						type: '/errors/conflict',
						title: 'Namespace Conflict',
						status: 409,
						detail: 'The destination namespace is archived',
					},
				],
			}),
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: 'Memory "m1" was not moved: The destination namespace is archived',
			description: 'Namespace Conflict (HTTP 409)',
			context: { itemIndex: 0 },
		});
	});

	it('refuses an update with no Update Fields before calling the API', async () => {
		const call = run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'update',
				memoryId: 'm1',
				updateFields: { text: '  ', topics: ', ' },
			},
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: "'Update Fields' is empty",
			description:
				'Add at least one of Memory Type, Namespace ID, Session ID, Text, Topics or User ID',
			context: { itemIndex: 0 },
		});
	});

	it('tells the user that creating the same Memory ID again replaces the memory', () => {
		const { properties } = new RedisAgentMemory().description;
		const additionalFields = properties.find(
			(property) =>
				property.name === 'additionalFields' &&
				property.displayOptions?.show?.operation?.includes('create') &&
				property.displayOptions?.show?.resource?.includes('longTermMemory'),
		);
		const memoryId = additionalFields?.options?.find((option) => option.name === 'id');

		expect(memoryId).toMatchObject({ description: expect.stringContaining('replaces') });
	});
});

/** A session as the API returns it: content parts, a summary object and a namespace binding. */
const fullSession = {
	sessionId: 's1',
	ownerId: 'user-1',
	namespaceId: 'ns-1',
	summary: {
		text: 'The user likes tea.',
		summarizedUpToEventId: 'e0',
		summarizedEvents: 12,
		createdAt: 'x',
		updatedAt: 'x',
	},
	events: [
		{
			eventId: 'e1',
			actorId: 'user-1',
			sessionId: 's1',
			role: 'USER',
			content: [{ text: 'Hello' }, { text: 'again' }],
			createdAt: '2026-11-04T10:00:00Z',
			systemTimestamp: '2026-11-04T10:00:01Z',
		},
	],
};

describe('RedisAgentMemory: Session', () => {
	it('gets a session, with summarized events on request', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'session',
				operation: 'get',
				sessionId: 's/1',
				options: { includeSummarisedEvents: true },
			},
			respond: () => ({ sessionId: 's/1', ownerId: 'user-1', events: [] }),
		});

		expect(requests[0]).toMatchObject({
			method: 'GET',
			url: `${BASE}/sessions/s%2F1`,
			qs: { includeSummarisedEvents: true },
		});
		expect(output[0]).toEqual({ sessionId: 's/1', ownerId: 'user-1', events: [] });
	});

	it('simplifies a session to its summary text and one text per event', async () => {
		const simplified = await run({
			parameters: { resource: 'session', operation: 'get', sessionId: 's1' },
			respond: () => fullSession,
		});
		expect(simplified.output).toEqual([
			{
				sessionId: 's1',
				ownerId: 'user-1',
				namespaceId: 'ns-1',
				summary: 'The user likes tea.',
				events: [
					{
						eventId: 'e1',
						actorId: 'user-1',
						role: 'USER',
						text: 'Hello\nagain',
						createdAt: '2026-11-04T10:00:00Z',
					},
				],
			},
		]);

		const raw = await run({
			parameters: { resource: 'session', operation: 'get', sessionId: 's1', simple: false },
			respond: () => fullSession,
		});
		expect(raw.output).toEqual([fullSession]);
	});

	it('leaves the summary out of a simplified session that has none', async () => {
		const { output } = await run({
			parameters: { resource: 'session', operation: 'get', sessionId: 's1' },
			respond: () => ({ sessionId: 's1', ownerId: 'user-1', events: [] }),
		});

		expect(output[0]).not.toHaveProperty('summary');
		expect(output[0]).not.toHaveProperty('namespaceId');
	});

	it('lists the sessions of a user as one item each, with what the server knows about them', async () => {
		const sessions = [
			{ sessionId: 's1', ownerId: 'user-1', createdAt: 'x', updatedAt: 'y', namespaceId: 'ns-1' },
			{ sessionId: 's2', ownerId: 'user-1' },
			{ sessionId: 's3' },
		];
		const { output, requests } = await run({
			parameters: {
				resource: 'session',
				operation: 'getAll',
				returnAll: false,
				limit: 2,
				filters: { ownerId: 'user-1' },
			},
			respond: () => ({ items: sessions }),
		});

		expect(requests[0]).toMatchObject({
			method: 'GET',
			url: `${BASE}/sessions`,
			qs: { limit: 2, ownerId: 'user-1' },
		});
		expect(output).toEqual(sessions.slice(0, 2));
		expect(requests[0].qs).not.toHaveProperty('includeAll');
	});

	it('lists every session with includeAll when no user is given', async () => {
		const { requests } = await run({
			parameters: { resource: 'session', operation: 'getAll', returnAll: true, filters: {} },
			respond: () => ({ items: [{ sessionId: 's1' }] }),
		});

		expect(requests[0].qs).toEqual({ limit: 100, includeAll: true });
	});

	it('adds an event and returns it', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'session',
				operation: 'addEvent',
				sessionId: 's1',
				actorId: 'user-1',
				role: 'ASSISTANT',
				text: 'Hello',
				additionalFields: { namespaceId: 'ns-1', createdAt: '2026-11-02T10:00:00.000Z' },
			},
			respond: () => ({ event: { eventId: 'e1', role: 'ASSISTANT' } }),
		});

		expect(requests[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/sessions/s1/events`,
			body: {
				idempotencyKey: ANY_KEY,
				actorId: 'user-1',
				role: 'ASSISTANT',
				content: [{ text: 'Hello' }],
				createdAt: '2026-11-02T10:00:00.000Z',
				namespaceId: 'ns-1',
			},
		});
		expect(requests[0].body).not.toHaveProperty('sessionId');
		expect(output).toEqual([{ eventId: 'e1', role: 'ASSISTANT' }]);
	});

	it("names 'Created At' when the value is not a date", async () => {
		const call = run({
			parameters: {
				resource: 'session',
				operation: 'addEvent',
				sessionId: 's1',
				actorId: 'user-1',
				text: 'Hello',
				additionalFields: { createdAt: 'yesterday' },
			},
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: `'Created At' is not a date: "yesterday"`,
			description: 'Use an ISO 8601 timestamp, for example 2024-03-15T10:00:00Z',
			context: { itemIndex: 0 },
		});
	});

	it('deletes a session and a single event', async () => {
		const session = await run({
			parameters: { resource: 'session', operation: 'delete', sessionId: 's1' },
			respond: () => undefined,
		});
		expect(session.requests[0]).toMatchObject({
			method: 'DELETE',
			url: `${BASE}/sessions/s1`,
		});
		expect(session.output).toEqual([{ deleted: true, sessionId: 's1' }]);

		const event = await run({
			parameters: {
				resource: 'session',
				operation: 'deleteEvent',
				sessionId: 's1',
				eventId: 'e 1',
			},
			respond: () => undefined,
		});
		expect(event.requests[0]).toMatchObject({
			method: 'DELETE',
			url: `${BASE}/sessions/s1/events/e%201`,
		});
		expect(event.output).toEqual([{ deleted: true, sessionId: 's1', eventId: 'e 1' }]);
	});
});

/** A namespace as the API returns it, with the bookkeeping fields Simplify drops. */
const fullNamespace = {
	namespaceId: 'ns-1',
	name: 'support',
	path: 'support',
	rootId: 'ns-1',
	scope: 'PERSONAL',
	state: 'ACTIVE',
	ownerId: 'user-1',
	revision: '1dbf7898d45a455abcb7002350d1f50a',
	createdAt: '2026-11-04T07:07:02.601Z',
	updatedAt: '2026-11-04T07:07:02.601Z',
};

/** The same namespace with Simplify on. */
const simpleNamespace = {
	namespaceId: 'ns-1',
	name: 'support',
	scope: 'PERSONAL',
	state: 'ACTIVE',
	ownerId: 'user-1',
};

describe('RedisAgentMemory: Namespace', () => {
	it('simplifies a namespace by default and returns the raw record with Simplify off', async () => {
		// `namespaceId` is a Namespace locator; the stub hands over its extracted value.
		const get = { resource: 'namespace', operation: 'get', namespaceId: 'ns-1' };

		const simplified = await run({
			parameters: get,
			respond: () => ({ namespace: fullNamespace }),
		});
		expect(simplified.output).toEqual([simpleNamespace]);

		const raw = await run({
			parameters: { ...get, simple: false },
			respond: () => ({ namespace: fullNamespace }),
		});
		expect(raw.output).toEqual([fullNamespace]);

		const child = await run({
			parameters: get,
			respond: () => ({ namespace: { ...fullNamespace, parentId: 'ns-0', ownerId: undefined } }),
		});
		expect(child.output).toEqual([{ ...simpleNamespace, parentId: 'ns-0', ownerId: undefined }]);
		expect(child.output[0]).not.toHaveProperty('ownerId');
	});

	it('creates, gets, lists, updates and deletes namespaces', async () => {
		const create = await run({
			parameters: {
				resource: 'namespace',
				operation: 'create',
				name: 'support',
				scope: 'PERSONAL',
				additionalFields: { ownerId: 'user-1' },
			},
			respond: () => ({ namespace: { namespaceId: 'ns-1', name: 'support' } }),
		});
		expect(create.requests[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/namespaces`,
			body: { name: 'support', scope: 'PERSONAL', ownerId: 'user-1' },
		});
		expect(create.output).toEqual([{ namespaceId: 'ns-1', name: 'support' }]);

		const get = await run({
			parameters: { resource: 'namespace', operation: 'get', namespaceId: 'ns-1' },
			respond: () => ({ namespace: { namespaceId: 'ns-1' } }),
		});
		expect(get.requests[0]).toMatchObject({ method: 'GET', url: `${BASE}/namespaces/ns-1` });
		expect(get.output).toEqual([{ namespaceId: 'ns-1' }]);

		const list = await run({
			parameters: { resource: 'namespace', operation: 'getAll', returnAll: true },
			respond: () => ({ items: [fullNamespace, { ...fullNamespace, namespaceId: 'ns-2' }] }),
		});
		expect(list.requests[0]).toMatchObject({
			method: 'GET',
			url: `${BASE}/namespaces`,
			qs: { limit: 100 },
		});
		expect(list.output).toEqual([simpleNamespace, { ...simpleNamespace, namespaceId: 'ns-2' }]);

		const update = await run({
			parameters: {
				resource: 'namespace',
				operation: 'update',
				namespaceId: 'ns-1',
				updateFields: { archive: true },
			},
			respond: () => ({ namespace: { namespaceId: 'ns-1', state: 'ARCHIVED' } }),
		});
		expect(update.output).toEqual([{ namespaceId: 'ns-1', state: 'ARCHIVED' }]);
		expect(update.requests[0]).toMatchObject({
			method: 'PATCH',
			url: `${BASE}/namespaces/ns-1`,
			body: { state: 'ARCHIVED' },
		});

		const rename = await run({
			parameters: {
				resource: 'namespace',
				operation: 'update',
				namespaceId: 'ns-1',
				updateFields: { name: 'billing', archive: false },
			},
			respond: () => ({ namespace: { namespaceId: 'ns-1', name: 'billing' } }),
		});
		expect(rename.requests[0].body).toEqual({ name: 'billing' });

		const del = await run({
			parameters: { resource: 'namespace', operation: 'delete', namespaceId: 'ns-1' },
			respond: () => undefined,
		});
		expect(del.output).toEqual([{ deleted: true, namespaceId: 'ns-1' }]);
	});

	it('creates a child namespace with only its name and parent', async () => {
		// The server refuses a child that names a scope or an owner; the child
		// inherits both from its parent.
		const { requests } = await run({
			parameters: {
				resource: 'namespace',
				operation: 'create',
				name: 'child',
				scope: 'PERSONAL',
				additionalFields: { parentId: 'ns-parent', ownerId: 'user-1' },
			},
			respond: () => ({ namespace: { namespaceId: 'ns-child' } }),
		});

		expect(requests[0].body).toEqual({ name: 'child', parentId: 'ns-parent' });
	});

	it('refuses a personal namespace without a User ID before calling the API', async () => {
		const call = run({
			parameters: {
				resource: 'namespace',
				operation: 'create',
				name: 'mine',
				scope: 'PERSONAL',
				additionalFields: { ownerId: ' ' },
			},
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: 'A personal namespace needs a User ID',
			description: 'Set User ID under Additional Fields, or choose the Shared scope',
			context: { itemIndex: 0 },
		});
	});

	it('refuses a namespace update with no Update Fields before calling the API', async () => {
		const call = run({
			parameters: {
				resource: 'namespace',
				operation: 'update',
				namespaceId: 'ns-1',
				updateFields: { name: ' ', archive: false },
			},
		});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: "'Update Fields' is empty",
			description: 'Add a Name, or switch Archive on',
			context: { itemIndex: 0 },
		});
	});
});

describe('RedisAgentMemory: Namespace locator', () => {
	it('offers the namespaces of Get, Update, Delete and Move from a list or as an ID', () => {
		const { properties } = new RedisAgentMemory().description;
		const locators = properties.filter(
			(property) => property.name === 'namespaceId' && property.type === 'resourceLocator',
		);

		expect(locators.map((p) => p.displayOptions?.show)).toEqual([
			{ resource: ['longTermMemory'], operation: ['move'] },
			{ resource: ['namespace'], operation: ['get', 'update', 'delete'] },
		]);
		for (const locator of locators) {
			expect(locator).toMatchObject({
				displayName: 'Namespace',
				required: true,
				default: { mode: 'list', value: '' },
				modes: [
					{
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchNamespaces', searchable: true },
					},
					{ name: 'id', type: 'string' },
				],
			});
			// No `__regex` or `extractValue`: the server's ID format may change.
			expect(locator.modes?.every((mode) => !mode.validation && !mode.extractValue)).toBe(true);
		}
	});

	/** Calls the list-search method with a fake `ILoadOptionsFunctions` and records the calls. */
	async function search(
		pages: Array<{ items: Array<{ namespaceId: string; name: string }>; nextCursor?: string }>,
		filter?: string,
		paginationToken?: string,
	) {
		const requests: IHttpRequestOptions[] = [];
		const ctx = {
			getNode: () => NODE,
			getCredentials: async () => ({
				serverUrl: 'https://memory.example.com',
				storeId: 'store-1',
				apiKey: 'secret',
			}),
			helpers: {
				async httpRequestWithAuthentication(_credentialType: string, options: IHttpRequestOptions) {
					requests.push(options);
					const index = pages.findIndex(
						(_, i) => (i === 0 ? undefined : `p${i}`) === options.qs?.cursor,
					);
					return pages[index];
				},
			},
		} as unknown as ILoadOptionsFunctions;
		const { searchNamespaces } = new RedisAgentMemory().methods.listSearch;
		const result = await searchNamespaces.call(ctx, filter, paginationToken);
		return { result, requests };
	}

	const namespace = (n: number) => ({ namespaceId: `id-${n}`, name: `Namespace ${n}` });

	it('lists one page of namespaces with the token for the next', async () => {
		const { result, requests } = await search([
			{ items: [namespace(1), namespace(2)], nextCursor: 'p1' },
			{ items: [namespace(3)] },
		]);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: 'GET',
			url: `${BASE}/namespaces`,
			qs: { limit: 100 },
		});
		expect(result).toEqual({
			results: [
				{ name: 'Namespace 1', value: 'id-1' },
				{ name: 'Namespace 2', value: 'id-2' },
			],
			paginationToken: 'p1',
		});
	});

	it('continues from the pagination token and ends without one on the last page', async () => {
		const { result, requests } = await search(
			[{ items: [namespace(1)], nextCursor: 'p1' }, { items: [namespace(3)] }],
			undefined,
			'p1',
		);

		expect(requests[0].qs).toEqual({ limit: 100, cursor: 'p1' });
		expect(result).toEqual({ results: [{ name: 'Namespace 3', value: 'id-3' }] });
	});

	it('matches a filter against the name, in any case, across pages', async () => {
		const { result, requests } = await search(
			[
				{ items: [namespace(1), { namespaceId: 'id-s', name: 'Support' }], nextCursor: 'p1' },
				{
					items: [{ namespaceId: 'id-b', name: 'billing-support' }, namespace(2)],
					nextCursor: 'p2',
				},
				{ items: [namespace(3)] },
			],
			'SUPP',
		);

		expect(requests.map((r) => r.qs?.cursor)).toEqual([undefined, 'p1', 'p2']);
		expect(result).toEqual({
			results: [
				{ name: 'Support', value: 'id-s' },
				{ name: 'billing-support', value: 'id-b' },
			],
		});
	});

	it('stops a filtered search after ten pages and hands back the token', async () => {
		const pages = Array.from({ length: 12 }, (_, i) => ({
			items: [namespace(i)],
			nextCursor: `p${i + 1}`,
		}));

		const { result, requests } = await search(pages, 'no such name');

		expect(requests).toHaveLength(10);
		expect(result).toEqual({ results: [], paginationToken: 'p10' });
	});
});

describe('RedisAgentMemory: Summary View', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A result as the API returns it for a partition that was computed. */
	const readyResult = {
		viewId: 'sv-1',
		scope: { ownerId: 'user-1' },
		status: 'READY',
		stale: false,
		format: 'TEXT',
		value: { text: 'Likes spicy food; lives in Sofia.' },
		sourceMemoryCount: 2,
		summarizedMemoryCount: 2,
		truncated: false,
		sourcesOmitted: false,
		sourceContentTruncated: false,
		sourceMemoryIds: ['m1', 'm2'],
		computedAt: '2026-11-05T10:00:00Z',
		definitionVersion: 1,
	};

	/** A view as the API returns it. */
	const fullView = {
		viewId: 'sv-1',
		name: 'customer-briefing',
		ownerId: '',
		source: 'LONG_TERM',
		groupBy: ['ownerId'],
		visibility: 'PRIVATE',
		output: { format: 'TEXT', instructions: 'Focus on preferences' },
		refreshPolicy: { mode: 'MANUAL' },
		evictionPolicy: { maxPartitions: 100 },
		state: 'ACTIVE',
		definitionVersion: 1,
		createdAt: '2026-11-05T09:00:00Z',
		updatedAt: '2026-11-05T09:30:00Z',
	};

	const simpleView = {
		viewId: 'sv-1',
		name: 'customer-briefing',
		visibility: 'PRIVATE',
		groupBy: ['ownerId'],
		state: 'ACTIVE',
		format: 'TEXT',
		refreshMode: 'MANUAL',
		updatedAt: '2026-11-05T09:30:00Z',
	};

	const getResult = {
		resource: 'summaryView',
		operation: 'getResult',
		viewId: 'sv-1',
		scope: { ownerId: 'user-1' },
	};

	it('offers the view of every operation but Create and Get Many from a list or as an ID', () => {
		const { properties } = new RedisAgentMemory().description;
		const locators = properties.filter((property) => property.name === 'viewId');

		expect(locators).toHaveLength(1);
		expect(locators[0]).toMatchObject({
			displayName: 'View',
			type: 'resourceLocator',
			required: true,
			displayOptions: {
				show: {
					resource: ['summaryView'],
					operation: ['get', 'getResult', 'refresh', 'update', 'delete'],
				},
			},
			modes: [
				{
					name: 'list',
					type: 'list',
					typeOptions: { searchListMethod: 'searchSummaryViews', searchable: true },
				},
				{ name: 'id', type: 'string' },
			],
		});
	});

	it("reads one partition's result with the scope as the query, and simplifies it", async () => {
		const { output, requests } = await run({
			parameters: {
				...getResult,
				scope: { ownerId: 'user-1', namespaceId: 'ns-1', sessionId: '', memoryType: ' ' },
				options: { includeSourceMemoryIds: true },
			},
			respond: () => readyResult,
		});

		expect(requests).toEqual([
			expect.objectContaining({
				method: 'GET',
				url: `${BASE}/summary-views/sv-1/result`,
				qs: { ownerId: 'user-1', namespaceId: 'ns-1', includeSourceMemoryIds: true },
			}),
		]);
		expect(output).toEqual([
			{
				viewId: 'sv-1',
				status: 'READY',
				stale: false,
				text: 'Likes spicy food; lives in Sofia.',
				computedAt: '2026-11-05T10:00:00Z',
				sourceMemoryCount: 2,
				summarizedMemoryCount: 2,
				truncated: false,
				sourceMemoryIds: ['m1', 'm2'],
			},
		]);
	});

	it('returns the raw result with Simplify off, and a structured value as data', async () => {
		const structured = { ...readyResult, format: 'STRUCTURED', value: { data: { city: 'Sofia' } } };
		const raw = await run({
			parameters: { ...getResult, simple: false },
			respond: () => structured,
		});
		expect(raw.output).toEqual([structured]);

		const simple = await run({ parameters: getResult, respond: () => structured });
		expect(simple.output[0]).toMatchObject({ status: 'READY', data: { city: 'Sofia' } });
		expect(simple.output[0]).not.toHaveProperty('text');
	});

	it('returns a cold or failed result as an item, not an error', async () => {
		const cold = await run({
			parameters: getResult,
			respond: () => ({ viewId: 'sv-1', status: 'COLD', stale: false, sourceMemoryCount: 0 }),
		});
		expect(cold.output).toEqual([
			{ viewId: 'sv-1', status: 'COLD', stale: false, sourceMemoryCount: 0 },
		]);

		const failed = await run({
			parameters: getResult,
			respond: () => ({ viewId: 'sv-1', status: 'FAILED', errorCode: 'GENERATION_FAILED' }),
		});
		expect(failed.output).toEqual([
			{ viewId: 'sv-1', status: 'FAILED', errorCode: 'GENERATION_FAILED' },
		]);
	});

	it('with Wait For Result, asks every two seconds until the status settles', async () => {
		vi.useFakeTimers();
		const statuses = ['COLD', 'REFRESHING', 'READY'];
		const askedAt: number[] = [];
		const pending = run({
			parameters: { ...getResult, waitForResult: true, maxWait: 60 },
			respond: (_options, call) => {
				askedAt.push(Date.now());
				return statuses[call] === 'READY'
					? readyResult
					: { viewId: 'sv-1', status: statuses[call], stale: false };
			},
		});
		await vi.runAllTimersAsync();

		const { output, requests } = await pending;
		expect(requests).toHaveLength(3);
		expect(askedAt.map((t) => t - askedAt[0])).toEqual([0, 2_000, 4_000]);
		expect(output[0]).toMatchObject({ status: 'READY', text: readyResult.value.text });
	});

	it('with Wait For Result, stops at EMPTY and at FAILED', async () => {
		for (const status of ['EMPTY', 'FAILED']) {
			vi.useFakeTimers();
			const pending = run({
				parameters: { ...getResult, waitForResult: true },
				respond: (_options, call) => ({ viewId: 'sv-1', status: call === 0 ? 'PENDING' : status }),
			});
			await vi.runAllTimersAsync();
			const { output, requests } = await pending;
			expect(requests).toHaveLength(2);
			expect(output).toEqual([{ viewId: 'sv-1', status }]);
			vi.useRealTimers();
		}
	});

	it('fails with the last status when Max Wait passes before the result settles', async () => {
		vi.useFakeTimers();
		const pending = run({
			parameters: { ...getResult, waitForResult: true, maxWait: 5 },
			respond: () => ({ viewId: 'sv-1', status: 'PENDING' }),
		});
		pending.catch(() => undefined);
		await vi.runAllTimersAsync();

		await expect(pending).rejects.toMatchObject({
			message: 'The summary was not ready after 5 seconds (status PENDING)',
			description:
				'A manual-refresh view computes a summary only after Refresh. Run Refresh first, or raise Max Wait.',
		});
	});

	it('refuses a Max Wait below 1 before calling the API', async () => {
		const requests = await run({
			parameters: { ...getResult, waitForResult: true, maxWait: 0 },
		}).then(
			(r) => r.requests,
			(error: Error) => {
				expect(error.message).toBe("'Max Wait' must be 1 or more");
				return [];
			},
		);
		expect(requests).toEqual([]);
	});

	it('refreshes a partition, or the whole view, and returns the accepted body', async () => {
		const accepted = { viewId: 'sv-1', target: 'PARTITION', accepted: true };
		const partition = await run({
			parameters: {
				resource: 'summaryView',
				operation: 'refresh',
				viewId: 'sv-1',
				target: 'PARTITION',
				scope: { ownerId: 'user-1' },
			},
			respond: () => accepted,
		});
		expect(partition.requests).toEqual([
			expect.objectContaining({
				method: 'POST',
				url: `${BASE}/summary-views/sv-1/refresh`,
				body: { target: 'PARTITION', scope: { ownerId: 'user-1' } },
			}),
		]);
		expect(partition.output).toEqual([accepted]);

		const full = await run({
			parameters: {
				resource: 'summaryView',
				operation: 'refresh',
				viewId: 'sv-1',
				target: 'FULL',
				scope: { ownerId: 'user-1' },
			},
			respond: () => ({ ...accepted, target: 'FULL' }),
		});
		expect(full.requests[0].body).toEqual({ target: 'FULL' });
	});

	it('with Wait For Result, Refresh returns the result it waited for', async () => {
		vi.useFakeTimers();
		const pending = run({
			parameters: {
				resource: 'summaryView',
				operation: 'refresh',
				viewId: 'sv-1',
				target: 'PARTITION',
				scope: { ownerId: 'user-1' },
				waitForResult: true,
			},
			respond: (options, call) => {
				if (options.method === 'POST')
					return { viewId: 'sv-1', target: 'PARTITION', accepted: true };
				return call === 1 ? { viewId: 'sv-1', status: 'REFRESHING' } : readyResult;
			},
		});
		await vi.runAllTimersAsync();

		const { output, requests } = await pending;
		expect(requests.map((r) => `${r.method} ${r.url.slice(BASE.length)}`)).toEqual([
			'POST /summary-views/sv-1/refresh',
			'GET /summary-views/sv-1/result',
			'GET /summary-views/sv-1/result',
		]);
		expect(requests[1].qs).toEqual({ ownerId: 'user-1' });
		expect(output[0]).toMatchObject({ status: 'READY', text: readyResult.value.text });
	});

	it('creates a view from the top-level fields and Additional Fields', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'summaryView',
				operation: 'create',
				name: 'customer-briefing',
				groupBy: ['ownerId', 'namespaceId'],
				outputFormat: 'STRUCTURED',
				instructions: 'Focus on preferences',
				refreshMode: 'CONTINUOUS',
				additionalFields: {
					description: 'Per-customer briefing',
					visibility: 'SHARED',
					debounceSeconds: 30,
					reconcileIntervalSeconds: 0,
					maxPartitions: 500,
					timeWindowSeconds: 86400,
					schema: '{"fields":[{"name":"city","type":"string"}]}',
					ownerId: '',
					memoryType: 'semantic',
					topics: 'food, travel',
				},
			},
			respond: () => fullView,
		});

		expect(requests).toEqual([
			expect.objectContaining({
				method: 'POST',
				url: `${BASE}/summary-views`,
				body: {
					source: 'LONG_TERM',
					name: 'customer-briefing',
					description: 'Per-customer briefing',
					visibility: 'SHARED',
					groupBy: ['ownerId', 'namespaceId'],
					output: {
						format: 'STRUCTURED',
						instructions: 'Focus on preferences',
						schema: { fields: [{ name: 'city', type: 'string' }] },
					},
					refreshPolicy: { mode: 'CONTINUOUS', debounceSeconds: 30 },
					evictionPolicy: { maxPartitions: 500 },
					timeWindowSeconds: 86400,
					filter: { memoryType: { eq: 'semantic' }, topics: { in: ['food', 'travel'] } },
				},
			}),
		]);
		expect(output).toEqual([simpleView]);
	});

	it('sends only the required fields for a plain text view, and the raw record with Simplify off', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'summaryView',
				operation: 'create',
				name: 'briefing',
				groupBy: ['ownerId'],
				outputFormat: 'TEXT',
				instructions: '',
				refreshMode: 'MANUAL',
				additionalFields: {},
				simple: false,
			},
			respond: () => fullView,
		});
		expect(requests[0].body).toEqual({
			source: 'LONG_TERM',
			name: 'briefing',
			groupBy: ['ownerId'],
			output: { format: 'TEXT' },
			refreshPolicy: { mode: 'MANUAL' },
		});
		expect(output).toEqual([fullView]);
	});

	it('refuses a Schema that is not a JSON object, and an empty Group By, before calling the API', async () => {
		const create = {
			resource: 'summaryView',
			operation: 'create',
			name: 'briefing',
			groupBy: ['ownerId'],
		};
		for (const [parameters, message] of [
			[{ ...create, additionalFields: { schema: '[not json' } }, "'Schema' is not a JSON object"],
			[{ ...create, additionalFields: { schema: '"text"' } }, "'Schema' is not a JSON object"],
			[{ ...create, groupBy: [] }, "'Group By' is empty"],
		] as const) {
			const requests = await run({ parameters }).then(
				(r) => r.requests,
				(error: Error) => {
					expect(error.message).toBe(message);
					return [];
				},
			);
			expect(requests).toEqual([]);
		}
	});

	it('gets, lists, updates and deletes views', async () => {
		const got = await run({
			parameters: { resource: 'summaryView', operation: 'get', viewId: 'sv-1' },
			respond: () => fullView,
		});
		expect(got.requests[0]).toMatchObject({ method: 'GET', url: `${BASE}/summary-views/sv-1` });
		expect(got.output).toEqual([simpleView]);

		const listed = await run({
			parameters: { resource: 'summaryView', operation: 'getAll', returnAll: false, limit: 3 },
			respond: (options) =>
				options.qs?.cursor
					? { items: [{ ...fullView, viewId: 'sv-3' }] }
					: { items: [fullView, { ...fullView, viewId: 'sv-2' }], nextCursor: 'p1' },
		});
		expect(listed.requests.map((r) => r.qs)).toEqual([{ limit: 3 }, { limit: 3, cursor: 'p1' }]);
		expect(listed.output.map((v) => v.viewId)).toEqual(['sv-1', 'sv-2', 'sv-3']);
		expect(listed.output[0]).toEqual(simpleView);

		const updated = await run({
			parameters: {
				resource: 'summaryView',
				operation: 'update',
				viewId: 'sv-1',
				updateFields: {
					name: 'renamed',
					state: 'DISABLED',
					clearFilter: true,
					clearTimeWindow: false,
					instructions: 'Shorter',
					refreshMode: 'MANUAL',
					maxPartitions: 0,
				},
			},
			respond: () => ({ ...fullView, name: 'renamed', state: 'DISABLED' }),
		});
		expect(updated.requests[0]).toMatchObject({
			method: 'PATCH',
			url: `${BASE}/summary-views/sv-1`,
			body: {
				name: 'renamed',
				state: 'DISABLED',
				clearFilter: true,
				output: { instructions: 'Shorter' },
				refreshPolicy: { mode: 'MANUAL' },
			},
		});
		expect(updated.output).toEqual([{ ...simpleView, name: 'renamed', state: 'DISABLED' }]);

		const deleted = await run({
			parameters: { resource: 'summaryView', operation: 'delete', viewId: 'sv-1' },
			respond: () => ({ viewId: 'sv-1', state: 'DELETING' }),
		});
		expect(deleted.requests[0]).toMatchObject({
			method: 'DELETE',
			url: `${BASE}/summary-views/sv-1`,
		});
		expect(deleted.output).toEqual([{ deleted: true, viewId: 'sv-1' }]);
	});

	it('refuses an update with no Update Fields before calling the API', async () => {
		const requests = await run({
			parameters: {
				resource: 'summaryView',
				operation: 'update',
				viewId: 'sv-1',
				updateFields: { name: '', clearFilter: false, maxPartitions: 0 },
			},
		}).then(
			(r) => r.requests,
			(error: Error) => {
				expect(error.message).toBe("'Update Fields' is empty");
				return [];
			},
		);
		expect(requests).toEqual([]);
	});

	it('lists views for the View locator by name, with the ID as the value', async () => {
		const requests: IHttpRequestOptions[] = [];
		const ctx = {
			getNode: () => NODE,
			getCredentials: async () => ({
				serverUrl: 'https://memory.example.com',
				storeId: 'store-1',
				apiKey: 'secret',
			}),
			helpers: {
				async httpRequestWithAuthentication(_credentialType: string, options: IHttpRequestOptions) {
					requests.push(options);
					if (options.qs?.cursor) return { items: [] };
					return {
						items: [fullView, { ...fullView, viewId: 'sv-2', name: 'weekly-digest' }],
						nextCursor: 'p1',
					};
				},
			},
		} as unknown as ILoadOptionsFunctions;
		const { searchSummaryViews } = new RedisAgentMemory().methods.listSearch;

		const all = await searchSummaryViews.call(ctx);
		expect(requests[0]).toMatchObject({ url: `${BASE}/summary-views`, qs: { limit: 100 } });
		expect(all).toEqual({
			results: [
				{ name: 'customer-briefing', value: 'sv-1' },
				{ name: 'weekly-digest', value: 'sv-2' },
			],
			paginationToken: 'p1',
		});

		const filtered = await searchSummaryViews.call(ctx, 'DIGEST');
		expect(filtered.results).toEqual([{ name: 'weekly-digest', value: 'sv-2' }]);
	});
});

describe('RedisAgentMemory: errors and items', () => {
	it('pairs each output with its input item', async () => {
		const { paired } = await run({
			parameters: { resource: 'session', operation: 'getAll', returnAll: true, filters: {} },
			respond: () => ({ items: [{ sessionId: 'a' }, { sessionId: 'b' }] }),
			items: 2,
		});

		expect(paired).toEqual([{ item: 0 }, { item: 0 }, { item: 1 }, { item: 1 }]);
	});

	it('fails the run with the API error and its status code', async () => {
		const call = run({
			parameters: { resource: 'longTermMemory', operation: 'get', memoryId: 'm1' },
			respond: () => {
				throw httpError(404);
			},
		});

		await expect(call).rejects.toBeInstanceOf(NodeApiError);
		await expect(call).rejects.toMatchObject({ httpCode: '404' });
	});

	it('returns the error as an item when Continue On Fail is on', async () => {
		const { output } = await run({
			parameters: { resource: 'longTermMemory', operation: 'get', memoryId: 'm1' },
			respond: () => {
				throw httpError(500);
			},
			continueOnFail: true,
		});

		expect(output).toHaveLength(1);
		expect(typeof output[0].error).toBe('string');
	});

	it('rejects an unknown operation', async () => {
		await expect(run({ parameters: { resource: 'session', operation: 'fly' } })).rejects.toThrow(
			'Unknown operation "fly"',
		);
	});
});
