import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { createWorkflow, deleteWorkflow, type CreatedWorkflow } from '../n8n-api';
import {
	fromBody,
	fromItem,
	LongTermMemoryStore,
	pairsWorkflow,
	rawOutput,
	runPair,
	splitItems,
} from './action-node-support';

/**
 * The action node's Long-Term Memory resource inside a real n8n: Search and
 * Get Many, and how the node behaves when one of several input items fails.
 * The single-record operations are in long-term-memory.test.ts.
 */

const searchParameters = {
	resource: 'longTermMemory',
	operation: 'search',
	query: fromBody('query'),
	ownerId: fromBody('userId'),
	maxResults: fromBody('max', '10'),
	options: {
		// Search no longer offers Filter Match. A workflow saved before the
		// option went away still carries `filterOp`; this is how such a stale
		// value reaches the node.
		filterOp: fromBody('filterOp', "'all'"),
		memoryType: fromBody('memoryType'),
		namespaceId: fromBody('namespaceId'),
		sessionId: fromBody('sessionId'),
		similarityThreshold: fromBody('threshold', '0'),
		topics: fromBody('topics'),
	},
};

const listFilters = {
	ownerId: fromBody('userId'),
	memoryType: fromBody('memoryType'),
	namespaceId: fromBody('namespaceId'),
	sessionId: fromBody('sessionId'),
	topics: fromBody('topics'),
};

const listsWorkflow = pairsWorkflow('E2E LTM: lists', [
	{ key: 'Search', parameters: searchParameters },
	{
		key: 'Search always output',
		parameters: searchParameters,
		settings: { alwaysOutputData: true },
	},
	{
		key: 'Get Many',
		parameters: {
			resource: 'longTermMemory',
			operation: 'getAll',
			returnAll: fromBody('returnAll', 'false'),
			limit: fromBody('limit', '50'),
			filters: listFilters,
		},
	},
	{
		key: 'Get Many defaults',
		parameters: { resource: 'longTermMemory', operation: 'getAll', filters: listFilters },
	},
	{
		key: 'Get Many unfiltered',
		parameters: { resource: 'longTermMemory', operation: 'getAll', limit: 100, filters: {} },
	},
]);

/** Webhook → Split Out over `body.items` → the node, with the given error setting. */
function itemsPair(key: string, parameters: Record<string, unknown>, onError?: string) {
	return {
		key,
		parameters,
		settings: onError ? { onError } : undefined,
		through: [splitItems(`${key} split`)],
	};
}

const createItems = {
	resource: 'longTermMemory',
	operation: 'create',
	text: fromItem('text'),
	ownerId: fromItem('userId'),
	additionalFields: { id: fromItem('id') },
};

const itemsWorkflow = pairsWorkflow('E2E LTM: items', [
	itemsPair('Create items', createItems),
	itemsPair('Create items continue', createItems, 'continueRegularOutput'),
	itemsPair('Create items error output', createItems, 'continueErrorOutput'),
	itemsPair(
		'Get items continue',
		{ resource: 'longTermMemory', operation: 'get', memoryId: fromItem('memoryId') },
		'continueRegularOutput',
	),
]);

describe.skipIf(!agentMemoryConfig)(`Long-Term Memory lists inside n8n ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const store = new LongTermMemoryStore(client);
	let lists: CreatedWorkflow;
	let items: CreatedWorkflow;

	beforeAll(async () => {
		lists = await createWorkflow(listsWorkflow);
		items = await createWorkflow(itemsWorkflow);
	});

	afterAll(async () => {
		if (lists) await deleteWorkflow(lists.id);
		if (items) await deleteWorkflow(items.id);
		await store.cleanup();
	});

	describe('Search', () => {
		const owner = store.owner('search-fixture');
		const otherOwner = store.owner('search-other');
		const sessionId = `${runPrefix}-ltm-search-session`;
		let namespaceId: string;
		let tea: string;
		let coffee: string;
		let dog: string;
		let othersTea: string;

		beforeAll(async () => {
			client.track(sessionId, owner);
			namespaceId = await store.createNamespace('search');
			[tea, coffee, dog] = await store.create([
				{
					id: store.memoryId('search-tea'),
					text: 'The user likes green tea',
					ownerId: owner,
					memoryType: 'episodic',
					topics: ['tea-topic-a'],
					sessionId,
					namespaceRef: { namespaceId },
				},
				{
					id: store.memoryId('search-coffee'),
					text: 'The user likes black coffee',
					ownerId: owner,
					topics: ['tea-topic-b'],
				},
				{ id: store.memoryId('search-dog'), text: 'The user has a dog named Rex', ownerId: owner },
			]);
			[othersTea] = await store.create([
				{
					id: store.memoryId('search-others-tea'),
					text: 'The user likes green tea',
					ownerId: otherOwner,
					topics: ['tea-topic-a'],
				},
			]);
		});

		const ids = (found: Array<Record<string, unknown>>) => found.map((memory) => memory.id).sort();

		it('finds a memory for its user and nothing for another user', async () => {
			const hit = await runPair(lists, 'Search', {
				userId: owner,
				query: 'What does the user drink?',
			});
			expect(hit.error).toBeUndefined();
			expect(ids(hit.items)).toEqual([coffee, dog, tea].sort());
			expect(hit.items.map((memory) => memory.id)).toContain(tea);

			const miss = await runPair(lists, 'Search', {
				userId: store.owner('search-nobody'),
				query: 'What does the user drink?',
			});
			expect(miss.error).toBeUndefined();
			expect(miss.execution.status).toBe('success');
			expect(miss.items).toEqual([]);
			// With "Respond: When Last Node Finishes" an empty output is a 500 to the caller.
			expect(miss.response.status).toBe(500);
			expect(miss.response.json).toMatchObject({ message: 'No item to return was found' });
		});

		it('with Always Output Data, no hits become one empty item and a 200', async () => {
			const {
				response,
				items: found,
				error,
			} = await runPair(lists, 'Search always output', {
				userId: store.owner('search-nobody'),
				query: 'What does the user drink?',
			});

			expect(error).toBeUndefined();
			expect(found).toEqual([{}]);
			expect(response.status).toBe(200);
			expect(response.json).toEqual({});
		});

		it('returns at most Max Results memories', async () => {
			const userId = store.owner('search-max');
			await store.create(
				['one', 'two', 'three', 'four', 'five', 'six'].map((word) => ({
					id: store.memoryId(`search-max-${word}`),
					text: `The user likes tea number ${word}`,
					ownerId: userId,
				})),
			);

			const { items: found } = await runPair(lists, 'Search', {
				userId,
				query: 'tea',
				max: 3,
			});

			expect(found).toHaveLength(3);
		});

		// The fixture IDs are set in beforeAll, so each case reads them through a function.
		it.each([
			['memory type', () => ({ memoryType: 'episodic' }), () => [tea]],
			['namespace', () => ({ namespaceId }), () => [tea]],
			['session', () => ({ sessionId }), () => [tea]],
			[
				'topics, where any listed topic matches',
				() => ({ topics: 'tea-topic-a, tea-topic-b' }),
				() => [coffee, tea],
			],
		])('filters by %s', async (_name, filter, expected) => {
			const { items: found, error } = await runPair(lists, 'Search', {
				userId: owner,
				query: 'What does the user drink?',
				...filter(),
			});

			expect(error).toBeUndefined();
			expect(ids(found)).toEqual(expected().sort());
		});

		it('drops far matches with a high Similarity Threshold and keeps them at 0', async () => {
			const query = 'quarterly tax filing deadlines';

			const strict = await runPair(lists, 'Search', { userId: owner, query, threshold: 0.99 });
			const loose = await runPair(lists, 'Search', { userId: owner, query, threshold: 0 });

			expect(strict.error).toBeUndefined();
			expect(strict.items).toEqual([]);
			expect(loose.items).toHaveLength(3);
		});

		it('needs every filter, and ignores a Filter Match left in an older workflow', async () => {
			// A topic that matches and a session that does not: no memory satisfies
			// both. A stale `filterOp: 'any'` must not loosen that to "either".
			const filters = { topics: 'tea-topic-a', sessionId: `${runPrefix}-ltm-no-such-session` };

			const plain = await runPair(lists, 'Search', {
				userId: owner,
				query: 'What does the user drink?',
				...filters,
			});
			const stale = await runPair(lists, 'Search', {
				userId: owner,
				query: 'What does the user drink?',
				filterOp: 'any',
				...filters,
			});

			expect(plain.error).toBeUndefined();
			expect(plain.items).toEqual([]);
			expect(stale.error).toBeUndefined();
			expect(stale.items).toEqual([]);
		});

		it("never returns another user's memories, even with Filter Match = Any", async () => {
			// Before the option was removed, "Any Filter" put the User ID on a par
			// with the other filters and a shared topic leaked another user's
			// memory. The node now never sends `filterOp`, ignores a stale value
			// and refuses to pass on a result whose owner is not the User ID.
			const { items: found } = await runPair(lists, 'Search', {
				userId: owner,
				query: 'What does the user drink?',
				filterOp: 'any',
				topics: 'tea-topic-a',
			});

			expect(ids(found)).not.toContain(othersTea);
			expect(found.every((memory) => memory.ownerId === owner)).toBe(true);
		});

		it('refuses a whitespace-only query before calling the API', async () => {
			const { error } = await runPair(lists, 'Search', { userId: owner, query: ' \t ' });

			expect(error).toMatchObject({
				nodeName: 'Search',
				type: 'NodeOperationError',
				message: "'Query' is empty",
				itemIndex: 0,
			});
		});

		it('names Max Results when an expression sets it above 100', async () => {
			// The editor caps typed values at 100; an expression bypasses the cap,
			// so the node checks the value itself before calling the API.
			const {
				response,
				items: found,
				error,
			} = await runPair(lists, 'Search', {
				userId: owner,
				query: 'tea',
				max: 500,
			});

			expect(response.status).toBe(500);
			expect(found).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Search',
				type: 'NodeOperationError',
				message: "'Max Results' must be a whole number from 1 to 100",
				itemIndex: 0,
			});
		});
	});

	describe('Get Many', () => {
		const owner = store.owner('list-fixture');
		const sessionId = `${runPrefix}-ltm-list-session`;
		let namespaceId: string;
		let fixture: string[];

		beforeAll(async () => {
			client.track(sessionId, owner);
			namespaceId = await store.createNamespace('list');
			fixture = await store.create([
				{ id: store.memoryId('list-1'), text: 'Likes tea', ownerId: owner, memoryType: 'episodic' },
				{
					id: store.memoryId('list-2'),
					text: 'Likes coffee',
					ownerId: owner,
					memoryType: 'episodic',
				},
				{
					id: store.memoryId('list-3'),
					text: 'Likes milk',
					ownerId: owner,
					namespaceRef: { namespaceId },
				},
				{ id: store.memoryId('list-4'), text: 'Likes water', ownerId: owner, sessionId },
				{
					id: store.memoryId('list-5'),
					text: 'Likes juice',
					ownerId: owner,
					topics: ['list-topic'],
				},
				{
					id: store.memoryId('list-6'),
					text: 'Likes cocoa',
					ownerId: owner,
					topics: ['list-topic'],
				},
				{ id: store.memoryId('list-7'), text: 'Likes soda', ownerId: owner },
				{ id: store.memoryId('list-8'), text: 'Likes beer', ownerId: owner },
			]);
		});

		const ids = (found: Array<Record<string, unknown>>) => found.map((memory) => memory.id).sort();

		it('lists every memory of a user', async () => {
			const { items: found, error } = await runPair(lists, 'Get Many', { userId: owner });

			expect(error).toBeUndefined();
			expect(ids(found)).toEqual([...fixture].sort());
		});

		// The fixture IDs are set in beforeAll, so each case reads them through a function.
		it.each([
			['memory type', () => ({ memoryType: 'episodic' }), () => [fixture[0], fixture[1]]],
			['namespace', () => ({ namespaceId }), () => [fixture[2]]],
			['session', () => ({ sessionId }), () => [fixture[3]]],
			['topics', () => ({ topics: 'list-topic' }), () => [fixture[4], fixture[5]]],
		])('filters by %s', async (_name, filter, expected) => {
			const { items: found, error } = await runPair(lists, 'Get Many', {
				userId: owner,
				...filter(),
			});

			expect(error).toBeUndefined();
			expect(ids(found)).toEqual(expected().sort());
		});

		it('filters by session alone, without a user', async () => {
			const { items: found } = await runPair(lists, 'Get Many', { sessionId });
			expect(ids(found)).toEqual([fixture[3]]);
		});

		it('stops at the limit', async () => {
			const { items: found } = await runPair(lists, 'Get Many', { userId: owner, limit: 5 });
			expect(found).toHaveLength(5);
		});

		describe('with 105 memories of one user', () => {
			const bulkOwner = store.owner('list-bulk');

			beforeAll(async () => {
				// The endpoint takes at most 100 records per request, so this is two.
				await store.create(
					Array.from({ length: 105 }, (_, index) => ({
						id: store.memoryId(`list-bulk-${index}`),
						text: `The user likes drink number ${index}`,
						ownerId: bulkOwner,
					})),
				);
			});

			it('returns 50 by default', async () => {
				const { items: found, error } = await runPair(lists, 'Get Many defaults', {
					userId: bulkOwner,
				});
				expect(error).toBeUndefined();
				expect(found).toHaveLength(50);
			});

			it('returns all 105 with Return All', async () => {
				const { items: found, error } = await runPair(lists, 'Get Many', {
					userId: bulkOwner,
					returnAll: true,
				});
				expect(error).toBeUndefined();
				expect(found).toHaveLength(105);
				expect(new Set(found.map((memory) => memory.id)).size).toBe(105);
			});

			it('returns exactly 100 with limit 100 and 101 with limit 101', async () => {
				const hundred = await runPair(lists, 'Get Many', { userId: bulkOwner, limit: 100 });
				expect(hundred.items).toHaveLength(100);

				// Above the page size the node fetches a second page and cuts the list.
				const more = await runPair(lists, 'Get Many', { userId: bulkOwner, limit: 101 });
				expect(more.error).toBeUndefined();
				expect(more.items).toHaveLength(101);
			});
		});

		it('with no filter at all asks for a filter before calling the API', async () => {
			// The search endpoint has no wildcard: it needs a text or at least one
			// filter field. The node says so instead of sending an empty filter.
			const { response, items: found, error } = await runPair(lists, 'Get Many unfiltered', {});

			expect(response.status).toBe(500);
			expect(found).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Get Many unfiltered',
				type: 'NodeOperationError',
				message: 'Add at least one filter',
				description:
					'The API lists memories only by User ID, Memory Type, Namespace ID, Session ID or Topics',
				itemIndex: 0,
			});
		});
	});

	describe('Several input items', () => {
		const owner = store.owner('items');

		function threeCreates(name: string) {
			return {
				items: [
					{ userId: owner, text: 'The first fact', id: store.memoryId(`${name}-1`) },
					{ userId: owner, text: '   ' },
					{ userId: owner, text: 'The third fact', id: store.memoryId(`${name}-3`) },
				],
			};
		}

		it('stops at the item that fails and keeps what came before it', async () => {
			const body = threeCreates('stop');

			const { response, execution, error } = await runPair(items, 'Create items', body);

			expect(response.status).toBe(500);
			expect(execution.status).toBe('error');
			expect(error).toMatchObject({
				nodeName: 'Create items',
				type: 'NodeOperationError',
				message: "'Text' is empty",
				itemIndex: 1,
			});
			expect(await store.get(body.items[0].id!)).toMatchObject({ text: 'The first fact' });
			expect(await store.get(body.items[2].id!)).toBeUndefined();
		});

		it('with On Error = Continue, puts an error item in place of the failed one', async () => {
			const body = threeCreates('continue');

			const {
				response,
				execution,
				items: out,
				error,
			} = await runPair(items, 'Create items continue', body);

			expect(error).toBeUndefined();
			expect(execution.status).toBe('success');
			expect(out).toHaveLength(3);
			expect(out[0]).toMatchObject({ id: body.items[0].id, text: 'The first fact' });
			expect(out[1]).toEqual({ error: "'Text' is empty" });
			expect(out[2]).toMatchObject({ id: body.items[2].id, text: 'The third fact' });
			expect(rawOutput(execution, 'Create items continue').map((item) => item.pairedItem)).toEqual([
				{ item: 0 },
				{ item: 1 },
				{ item: 2 },
			]);
			// The webhook's default "Response Data" is the first entry only.
			expect(response.status).toBe(200);
			expect(response.json).toMatchObject({ id: body.items[0].id, text: 'The first fact' });
			expect(await store.get(body.items[2].id!)).toMatchObject({ text: 'The third fact' });
		});

		it('with On Error = Continue (using error output), routes the failed item to the error output', async () => {
			const body = threeCreates('error-output');

			const { execution, error } = await runPair(items, 'Create items error output', body);

			expect(error).toBeUndefined();
			expect(execution.status).toBe('success');
			const success = rawOutput(execution, 'Create items error output', 0);
			const failed = rawOutput(execution, 'Create items error output', 1);
			expect(success.map((item) => item.json.text)).toEqual(['The first fact', 'The third fact']);
			// On the error output n8n keeps the input item and adds `error` to it.
			expect(failed.map((item) => item.json)).toEqual([
				{ error: "'Text' is empty", text: '   ', userId: owner },
			]);
			expect(failed.map((item) => item.pairedItem)).toEqual([{ item: 1 }]);
		});

		it('with On Error = Continue, an API failure becomes an error item with only the message', async () => {
			const [first, third] = await store.create([
				{ id: store.memoryId('items-get-1'), text: 'The first fact', ownerId: owner },
				{ id: store.memoryId('items-get-3'), text: 'The third fact', ownerId: owner },
			]);
			const missing = `${runPrefix}-ltm-items-get-missing`;

			const { items: out, error } = await runPair(items, 'Get items continue', {
				items: [{ memoryId: first }, { memoryId: missing }, { memoryId: third }],
			});

			expect(error).toBeUndefined();
			expect(out[0]).toMatchObject({ id: first });
			// The item says neither which ID failed nor what the server said.
			expect(out[1]).toEqual({ error: 'The requested memory was not found' });
			expect(out[2]).toMatchObject({ id: third });
		});
	});
});
