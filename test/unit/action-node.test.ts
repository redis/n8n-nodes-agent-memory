import { describe, expect, it } from 'vitest';
import type { IExecuteFunctions, IHttpRequestOptions, INode } from 'n8n-workflow';
import { RedisAgentMemory } from '../../nodes/RedisAgentMemory/RedisAgentMemory.node';

interface Setup {
	parameters: Record<string, unknown>;
	respond?: (options: IHttpRequestOptions, callIndex: number) => unknown;
	continueOnFail?: boolean;
	items?: number;
}

const NODE: INode = {
	id: 'action-node',
	name: 'Redis Agent Memory',
	type: '@redis/n8n-nodes-agent-memory.redisAgentMemory',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const BASE = 'https://memory.example.com/v1/stores/store-1';

function httpError(status: number, message = `Request failed with status code ${status}`) {
	return Object.assign(new Error(message), { httpCode: String(status), response: { status } });
}

/** Runs `execute` with fixed parameters for every item and records the HTTP calls. */
async function run({ parameters, respond = () => ({}), continueOnFail = false, items = 1 }: Setup) {
	const requests: IHttpRequestOptions[] = [];
	const ctx = {
		getNode: () => NODE,
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

const record = (id: string, text: string) => ({
	id,
	text,
	ownerId: 'user-1',
	createdAt: 'x',
	updatedAt: 'x',
});

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
					filterOp: 'any',
					similarityThreshold: 0.4,
				},
			},
			respond: () => ({ items: [record('m1', 'Likes spicy food'), record('m2', 'Vegetarian')] }),
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/long-term-memory/search`,
			body: {
				text: 'What food does the user like?',
				limit: 3,
				filterOp: 'any',
				similarityThreshold: 0.4,
				filter: {
					ownerId: { eq: 'user-1' },
					namespaceRef: { eq: 'ns-1' },
					topics: { in: ['food', 'travel'] },
				},
			},
		});
		expect(output.map((m) => m.text)).toEqual(['Likes spicy food', 'Vegetarian']);
	});

	it('leaves the default filter match and a zero threshold out of the request', async () => {
		const { requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'search',
				query: 'q',
				ownerId: 'user-1',
				options: { filterOp: 'all', similarityThreshold: 0 },
			},
			respond: () => ({ items: [] }),
		});

		expect(requests[0].body).toEqual({
			text: 'q',
			limit: 10,
			filter: { ownerId: { eq: 'user-1' } },
		});
	});

	it('refuses to search without a user', async () => {
		await expect(
			run({
				parameters: { resource: 'longTermMemory', operation: 'search', query: 'q', ownerId: ' ' },
			}),
		).rejects.toThrow("'User ID' is empty");
	});

	it('gets many by following page tokens until the limit', async () => {
		const pages = [
			{ items: [record('m1', 'a'), record('m2', 'b')], nextPageToken: 'p2' },
			{ items: [record('m3', 'c'), record('m4', 'd')], nextPageToken: 'p3' },
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
				pageToken: 'p2',
			},
		]);
		expect(output.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
	});

	it('gets all pages when Return All is on', async () => {
		const pages = [
			{ items: [record('m1', 'a')], nextPageToken: 'p2' },
			{ items: [record('m2', 'b')] },
		];
		const { output, requests } = await run({
			parameters: { resource: 'longTermMemory', operation: 'getAll', returnAll: true, filters: {} },
			respond: (_options, call) => pages[call],
		});

		expect(requests.map((r) => (r.body as { limit: number }).limit)).toEqual([100, 100]);
		expect(output.map((m) => m.id)).toEqual(['m1', 'm2']);
	});

	it('creates a memory with a generated ID and returns what it stored', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'create',
				text: 'The user is vegetarian',
				ownerId: 'user-1',
				additionalFields: { memoryType: 'preference', topics: 'food', namespaceId: 'ns-1' },
			},
			respond: (options) => {
				const [memory] = (options.body as { memories: Array<{ id: string }> }).memories;
				return { created: [memory.id] };
			},
		});

		const [memory] = (requests[0].body as { memories: Array<Record<string, unknown>> }).memories;
		expect(requests[0]).toMatchObject({ method: 'POST', url: `${BASE}/long-term-memory` });
		expect(memory.id).toMatch(/^n8n-[a-z0-9]+-[a-z0-9]+$/);
		expect(memory).toMatchObject({
			text: 'The user is vegetarian',
			ownerId: 'user-1',
			memoryType: 'preference',
			topics: ['food'],
			namespaceRef: { namespaceId: 'ns-1' },
		});
		expect(output[0]).toEqual(memory);
	});

	it('uses the given memory ID and reports a per-record error', async () => {
		await expect(
			run({
				parameters: {
					resource: 'longTermMemory',
					operation: 'create',
					text: 'x',
					ownerId: 'user-1',
					additionalFields: { id: 'mem-1' },
				},
				respond: () => ({ created: [], errors: [{ id: 'mem-1', error: 'duplicate' }] }),
			}),
		).rejects.toThrow('Memory "mem-1" was not created: duplicate');
	});

	it('gets, updates, deletes and moves one memory by ID', async () => {
		const get = await run({
			parameters: { resource: 'longTermMemory', operation: 'get', memoryId: 'm 1' },
			respond: () => record('m 1', 'a'),
		});
		expect(get.requests[0]).toMatchObject({ method: 'GET', url: `${BASE}/long-term-memory/m%201` });
		expect(get.output[0].text).toBe('a');

		const update = await run({
			parameters: {
				resource: 'longTermMemory',
				operation: 'update',
				memoryId: 'm1',
				updateFields: { text: 'b', topics: 'x, y', ownerId: 'user-2' },
			},
			respond: () => record('m1', 'b'),
		});
		expect(update.requests[0]).toMatchObject({
			method: 'PATCH',
			url: `${BASE}/long-term-memory/m1`,
			body: { text: 'b', topics: ['x', 'y'], ownerId: 'user-2' },
		});

		const del = await run({
			parameters: { resource: 'longTermMemory', operation: 'delete', memoryId: 'm1' },
			respond: () => ({ deleted: ['m1'] }),
		});
		expect(del.requests[0]).toMatchObject({
			method: 'DELETE',
			url: `${BASE}/long-term-memory`,
			body: { memoryIds: ['m1'] },
		});
		expect(del.output).toEqual([{ deleted: true, id: 'm1' }]);

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
			url: `${BASE}/long-term-memory/move`,
			body: { memoryIds: ['m1'], namespaceRef: { namespaceId: 'ns-2' } },
		});
		expect(move.output).toEqual([{ moved: true, id: 'm1', namespaceId: 'ns-2' }]);
	});

	it('fails when the bulk response does not list the ID', async () => {
		await expect(
			run({
				parameters: { resource: 'longTermMemory', operation: 'delete', memoryId: 'm1' },
				respond: () => ({ deleted: [] }),
			}),
		).rejects.toThrow('Memory "m1" was not deleted');
	});
});

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
			url: `${BASE}/session-memory/s%2F1`,
			qs: { includeSummarisedEvents: true },
		});
		expect(output[0]).toMatchObject({ ownerId: 'user-1' });
	});

	it('lists session IDs for a user as one item each', async () => {
		const { output, requests } = await run({
			parameters: {
				resource: 'session',
				operation: 'getAll',
				returnAll: false,
				limit: 2,
				filters: { ownerId: 'user-1' },
			},
			respond: () => ({ items: ['s1', 's2', 's3'], total: 3 }),
		});

		expect(requests[0]).toMatchObject({
			method: 'GET',
			url: `${BASE}/session-memory`,
			qs: { limit: 2, filterOwnerId: 'user-1' },
		});
		expect(output).toEqual([{ sessionId: 's1' }, { sessionId: 's2' }]);
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
			url: `${BASE}/session-memory/events`,
			body: {
				sessionId: 's1',
				actorId: 'user-1',
				role: 'ASSISTANT',
				content: [{ text: 'Hello' }],
				createdAt: '2026-11-02T10:00:00.000Z',
				namespaceRef: { namespaceId: 'ns-1' },
			},
		});
		expect(output).toEqual([{ eventId: 'e1', role: 'ASSISTANT' }]);
	});

	it('deletes a session and a single event', async () => {
		const session = await run({
			parameters: { resource: 'session', operation: 'delete', sessionId: 's1' },
			respond: () => undefined,
		});
		expect(session.requests[0]).toMatchObject({
			method: 'DELETE',
			url: `${BASE}/session-memory/s1`,
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
			url: `${BASE}/session-memory/s1/events/e%201`,
		});
		expect(event.output).toEqual([{ deleted: true, sessionId: 's1', eventId: 'e 1' }]);
	});
});

describe('RedisAgentMemory: Namespace', () => {
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
			respond: () => ({ items: [{ namespaceId: 'ns-1' }, { namespaceId: 'ns-2' }] }),
		});
		expect(list.requests[0]).toMatchObject({
			method: 'GET',
			url: `${BASE}/namespaces`,
			qs: { limit: 100 },
		});
		expect(list.output.map((n) => n.namespaceId)).toEqual(['ns-1', 'ns-2']);

		const update = await run({
			parameters: {
				resource: 'namespace',
				operation: 'update',
				namespaceId: 'ns-1',
				updateFields: { state: 'ARCHIVED' },
			},
			respond: () => ({ namespace: { namespaceId: 'ns-1', state: 'ARCHIVED' } }),
		});
		expect(update.output).toEqual([{ namespaceId: 'ns-1', state: 'ARCHIVED' }]);
		expect(update.requests[0]).toMatchObject({
			method: 'PATCH',
			url: `${BASE}/namespaces/ns-1`,
			body: { state: 'ARCHIVED' },
		});

		const del = await run({
			parameters: { resource: 'namespace', operation: 'delete', namespaceId: 'ns-1' },
			respond: () => undefined,
		});
		expect(del.output).toEqual([{ deleted: true, namespaceId: 'ns-1' }]);
	});
});

describe('RedisAgentMemory: errors and items', () => {
	it('pairs each output with its input item', async () => {
		const { paired } = await run({
			parameters: { resource: 'session', operation: 'getAll', returnAll: true, filters: {} },
			respond: () => ({ items: ['a', 'b'], total: 2 }),
			items: 2,
		});

		expect(paired).toEqual([{ item: 0 }, { item: 0 }, { item: 1 }, { item: 1 }]);
	});

	it('fails the run on an API error', async () => {
		await expect(
			run({
				parameters: { resource: 'longTermMemory', operation: 'get', memoryId: 'm1' },
				respond: () => {
					throw httpError(404);
				},
			}),
		).rejects.toThrow();
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
