import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { createWorkflow, deleteWorkflow, type CreatedWorkflow } from '../n8n-api';
import {
	fromBody,
	LongTermMemoryStore,
	pairsWorkflow,
	runPair,
	type StoredMemory,
} from './action-node-support';

/**
 * The action node's Long-Term Memory resource inside a real n8n: Create,
 * Get, Update, Delete and Move, each with its parameters resolved from the
 * webhook body. The search and list operations, and the behaviour with
 * several input items, are in long-term-memory-search.test.ts.
 *
 * The suite tests the node, not the server: how an option becomes a request,
 * what comes back as items, and one user-visible error per status class.
 */

const NOT_FOUND = {
	type: 'NodeApiError',
	httpCode: '404',
	message: 'The requested memory was not found',
	description: 'Memory Not Found (HTTP 404)',
};

const INVALID = {
	type: 'NodeApiError',
	httpCode: '400',
	description: 'Invalid Request (HTTP 400)',
};

/** A 404 from the gateway's router has no body, so n8n's own text stays. */
const GATEWAY_NOT_FOUND = {
	type: 'NodeApiError',
	httpCode: '404',
	message: 'The resource you are requesting could not be found',
	description: 'Request failed with status code 404',
};

const recordsWorkflow = pairsWorkflow('E2E LTM: records', [
	{
		key: 'Create',
		parameters: {
			resource: 'longTermMemory',
			operation: 'create',
			text: fromBody('text'),
			ownerId: fromBody('userId'),
			additionalFields: {
				id: fromBody('id'),
				memoryType: fromBody('memoryType'),
				namespaceId: fromBody('namespaceId'),
				sessionId: fromBody('sessionId'),
				topics: fromBody('topics'),
			},
		},
	},
	{
		key: 'Get',
		parameters: { resource: 'longTermMemory', operation: 'get', memoryId: fromBody('memoryId') },
	},
	{
		key: 'Update',
		parameters: {
			resource: 'longTermMemory',
			operation: 'update',
			memoryId: fromBody('memoryId'),
			updateFields: {
				text: fromBody('text'),
				ownerId: fromBody('userId'),
				memoryType: fromBody('memoryType'),
				namespaceId: fromBody('namespaceId'),
				sessionId: fromBody('sessionId'),
				topics: fromBody('topics'),
			},
		},
	},
	{
		key: 'Update nothing',
		parameters: {
			resource: 'longTermMemory',
			operation: 'update',
			memoryId: fromBody('memoryId'),
			updateFields: {},
		},
	},
	{
		key: 'Delete',
		parameters: {
			resource: 'longTermMemory',
			operation: 'delete',
			memoryId: fromBody('memoryId'),
		},
	},
	{
		key: 'Move',
		parameters: {
			resource: 'longTermMemory',
			operation: 'move',
			memoryId: fromBody('memoryId'),
			namespaceId: fromBody('namespaceId'),
		},
	},
]);

describe.skipIf(!agentMemoryConfig)(`Long-Term Memory records inside n8n ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const store = new LongTermMemoryStore(client);
	let workflow: CreatedWorkflow;

	beforeAll(async () => {
		workflow = await createWorkflow(recordsWorkflow);
	});

	afterAll(async () => {
		if (workflow) await deleteWorkflow(workflow.id);
		await store.cleanup();
	});

	/** Creates through the node and returns the stored record as the node reported it. */
	async function createThroughNode(body: Record<string, unknown>): Promise<StoredMemory> {
		const { error, items } = await runPair(workflow, 'Create', body);
		expect(error).toBeUndefined();
		expect(items).toHaveLength(1);
		return items[0] as unknown as StoredMemory;
	}

	/** Creates a plain memory straight on the store, for the tests that only read, change or delete. */
	async function seed(name: string, text = 'The user likes tea'): Promise<string> {
		const [id] = await store.create([
			{ id: store.memoryId(name), text, ownerId: store.owner(name) },
		]);
		return id;
	}

	/** The IDs of every memory the store holds for one owner. */
	async function idsOwnedBy(ownerId: string): Promise<string[]> {
		const page = await client.request<{ items: StoredMemory[] }>({
			method: 'POST',
			path: '/long-term-memory/search',
			body: { filter: { ownerId: { eq: ownerId } }, limit: 10 },
		});
		return page?.items.map((memory) => memory.id) ?? [];
	}

	describe('Create', () => {
		it('stores text for a user and generates an n8n- ID', async () => {
			const userId = store.owner('create-plain');

			const created = await createThroughNode({ userId, text: 'The user likes tea' });

			expect(created).toMatchObject({ text: 'The user likes tea', ownerId: userId });
			expect(created.id).toMatch(/^n8n-[a-z0-9]+-[a-z0-9]+$/);
			expect(await store.get(created.id)).toMatchObject({
				id: created.id,
				text: 'The user likes tea',
				ownerId: userId,
				memoryType: 'semantic',
			});
		});

		it('creating the same Memory ID again replaces the record and makes no duplicate', async () => {
			// The server upserts by ID: the text, type and topics of the second
			// create replace the first, and createdAt is reset.
			const userId = store.owner('create-again');
			const id = store.memoryId('create-again');

			const first = await createThroughNode({
				userId,
				text: 'The user likes tea',
				id,
				topics: 'drinks',
			});
			const second = await createThroughNode({ userId, text: 'The user likes coffee', id });

			expect(first.id).toBe(id);
			expect(second.id).toBe(id);
			expect(await store.get(id)).toMatchObject({ text: 'The user likes coffee', topics: [] });
			expect(await idsOwnedBy(userId)).toEqual([id]);
		});

		it('accepts the built-in types semantic and episodic', async () => {
			const userId = store.owner('create-types');

			const semantic = await createThroughNode({
				userId,
				text: 'The user likes tea',
				memoryType: 'semantic',
			});
			const episodic = await createThroughNode({
				userId,
				text: 'The user visited Paris in May',
				memoryType: 'episodic',
			});

			expect(await store.get(semantic.id)).toMatchObject({ memoryType: 'semantic' });
			expect(await store.get(episodic.id)).toMatchObject({ memoryType: 'episodic' });
		});

		it('shows the server reason for a memory type the store does not know', async () => {
			// Built-in types are lower case; "SEMANTIC" counts as unregistered.
			const userId = store.owner('create-bad-type');

			const { error } = await runPair(workflow, 'Create', {
				userId,
				text: 'The user likes tea',
				memoryType: 'SEMANTIC',
			});

			expect(error).toMatchObject({ ...INVALID, nodeName: 'Create', itemIndex: 0 });
			expect(error?.message).toContain('not registered on this store');
			expect(error?.context?.data).toMatchObject({
				type: '/errors/invalid-data',
				detail: 'memories[0]: memory type "SEMANTIC" is not registered on this store',
			});
		});

		it('places the memory in a namespace', async () => {
			const userId = store.owner('create-namespace');
			const namespaceId = await store.createNamespace('create-namespace');

			const created = await createThroughNode({ userId, text: 'The user likes tea', namespaceId });

			expect(created.namespaceRef).toEqual({ namespaceId });
			const { items } = await runPair(workflow, 'Get', { memoryId: created.id });
			expect(items[0]).toMatchObject({ namespaceRef: { namespaceId } });
		});

		it('records the session the memory came from', async () => {
			const userId = store.owner('create-session');
			const sessionId = `${runPrefix}-ltm-create-session`;
			client.track(sessionId, userId);

			const created = await createThroughNode({ userId, text: 'The user likes tea', sessionId });

			expect(created.sessionId).toBe(sessionId);
			expect(await store.get(created.id)).toMatchObject({ sessionId });
		});

		it('splits topics on commas, trims them and drops blanks, but keeps duplicates', async () => {
			const userId = store.owner('create-topics');

			const created = await createThroughNode({
				userId,
				text: 'The user likes tea',
				topics: ' food , ,travel,food',
			});

			expect(created.topics).toEqual(['food', 'travel', 'food']);
			// The server stores the list as sent, duplicate included.
			expect(await store.get(created.id)).toMatchObject({ topics: ['food', 'travel', 'food'] });
		});

		it('stores all additional fields together', async () => {
			const userId = store.owner('create-all');
			const id = store.memoryId('create-all');
			const namespaceId = await store.createNamespace('create-all');
			const sessionId = `${runPrefix}-ltm-create-all-session`;
			client.track(sessionId, userId);

			const created = await createThroughNode({
				userId,
				text: 'The user visited Paris in May',
				id,
				memoryType: 'episodic',
				namespaceId,
				sessionId,
				topics: 'travel, france',
			});

			expect(created).toEqual({
				id,
				text: 'The user visited Paris in May',
				ownerId: userId,
				memoryType: 'episodic',
				namespaceRef: { namespaceId },
				sessionId,
				topics: ['travel', 'france'],
			});
			expect(await store.get(id)).toMatchObject({
				id,
				text: 'The user visited Paris in May',
				ownerId: userId,
				memoryType: 'episodic',
				namespaceRef: { namespaceId },
				sessionId,
				topics: ['travel', 'france'],
			});
		});
	});

	describe('String data through Create and Get', () => {
		it.each([
			[
				'emoji, CJK, right-to-left text and combining marks',
				'Likes 🍵 and 日本茶; name: محمد; café (e\u0301)',
			],
			['line breaks, including CRLF', 'First line\r\nSecond line\nThird line'],
			// No trailing space: the node trims the ends, which the trim test covers.
			['an 8 KB text', 'The user likes tea. '.repeat(410).trim()],
			[
				'quotes, backslashes, markup and JSON',
				`He said "it's C:\\temp" <script>alert(1)</script> {"key": [1, 2, {"nested": true}]}`,
			],
		])('keeps %s exactly', async (name, text) => {
			const userId = store.owner(`text-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);

			const created = await createThroughNode({ userId, text });
			const { items, error } = await runPair(workflow, 'Get', { memoryId: created.id });

			expect(created.text).toBe(text);
			expect(error).toBeUndefined();
			expect(items[0].text).toBe(text);
		});

		it('trims the text and the user ID at both ends', async () => {
			const userId = store.owner('text-trim');

			const created = await createThroughNode({ userId: `  ${userId}  `, text: '  likes tea  ' });

			expect(created).toMatchObject({ text: 'likes tea', ownerId: userId });
			expect(await store.get(created.id)).toMatchObject({ text: 'likes tea', ownerId: userId });
		});

		it('refuses whitespace-only text before calling the API', async () => {
			const { response, error } = await runPair(workflow, 'Create', {
				userId: store.owner('text-blank'),
				text: ' \n\t ',
			});

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Create',
				type: 'NodeOperationError',
				message: "'Text' is empty",
				itemIndex: 0,
			});
		});

		it('turns a numeric user ID into the string "42"', async () => {
			// Owner "42" is outside the run prefix, so the memory carries a prefixed
			// ID and is deleted by that ID, never by owner.
			const id = store.memoryId('numeric-owner');

			const created = await createThroughNode({ userId: 42, text: 'The user likes tea', id });

			expect(created.ownerId).toBe('42');
			expect(await store.get(id)).toMatchObject({ ownerId: '42' });
			const { items } = await runPair(workflow, 'Delete', { memoryId: id });
			expect(items[0]).toEqual({ deleted: true, id });
		});
	});

	describe('Get', () => {
		it('returns the stored record', async () => {
			const id = await seed('get-existing');

			const { response, items, error } = await runPair(workflow, 'Get', { memoryId: id });

			expect(error).toBeUndefined();
			expect(response.status).toBe(200);
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({
				id,
				text: 'The user likes tea',
				ownerId: store.owner('get-existing'),
				memoryType: 'semantic',
			});
			expect(items[0].createdAt).toEqual(expect.any(String));
		});

		it('shows the server not-found error for a missing ID', async () => {
			const memoryId = `${runPrefix}-ltm-get-missing`;

			const { response, error } = await runPair(workflow, 'Get', { memoryId });

			expect(response.status).toBe(500);
			expect(error).toMatchObject({ ...NOT_FOUND, nodeName: 'Get', itemIndex: 0 });
			expect(error?.context?.data).toEqual({
				type: '/errors/resource-not-found',
				title: 'Memory Not Found',
				status: 404,
				detail: 'The requested memory was not found',
			});
		});

		it('encodes IDs that need it and still reaches the API', async () => {
			// The store allows only letters, digits and dashes in a memory ID, so
			// each of these is refused; what matters is that the refusal is the
			// API's own JSON, which proves the path was encoded and routed.
			for (const suffix of ['a b', 'a%2Fb', 'ünïcode']) {
				const memoryId = `${runPrefix}-${suffix}`;
				const { error } = await runPair(workflow, 'Get', { memoryId });
				expect(error, memoryId).toMatchObject({ ...INVALID, nodeName: 'Get' });
				expect(error?.context?.data, memoryId).toMatchObject({ type: '/errors/invalid-data' });
			}
		});

		it('gets a plain-text 404 from the server router for an ID with a slash', async () => {
			// The node sends `a%2Fb`; the server decodes it before routing and no
			// route matches `/long-term-memory/a/b`. A direct request does the
			// same, so this is the server's behaviour, not a misroute. The editor
			// shows the generic 404 text; the plain-text body is not kept.
			const memoryId = `${runPrefix}-a/b`;

			const { error } = await runPair(workflow, 'Get', { memoryId });

			expect(error).toMatchObject({ ...GATEWAY_NOT_FOUND, nodeName: 'Get' });
			expect(error?.context?.data).toBeUndefined();
		});

		it('refuses an empty Memory ID before calling the API', async () => {
			const { error } = await runPair(workflow, 'Get', {});

			expect(error).toMatchObject({
				nodeName: 'Get',
				type: 'NodeOperationError',
				message: "'Memory ID' is empty",
				itemIndex: 0,
			});
		});
	});

	describe('Update', () => {
		it('changes the text and leaves the rest', async () => {
			const id = await seed('update-text');

			const { items, error } = await runPair(workflow, 'Update', {
				memoryId: id,
				text: 'The user likes coffee',
			});

			expect(error).toBeUndefined();
			expect(items[0]).toMatchObject({
				id,
				text: 'The user likes coffee',
				ownerId: store.owner('update-text'),
				memoryType: 'semantic',
			});
		});

		it('changes the type, the session and the namespace one at a time', async () => {
			const id = await seed('update-fields');
			const namespaceId = await store.createNamespace('update-fields');
			const sessionId = `${runPrefix}-ltm-update-session`;

			const typed = await runPair(workflow, 'Update', { memoryId: id, memoryType: 'episodic' });
			expect(typed.items[0]).toMatchObject({ memoryType: 'episodic', text: 'The user likes tea' });

			const sessioned = await runPair(workflow, 'Update', { memoryId: id, sessionId });
			expect(sessioned.items[0]).toMatchObject({ memoryType: 'episodic', sessionId });

			const placed = await runPair(workflow, 'Update', { memoryId: id, namespaceId });
			expect(placed.items[0]).toMatchObject({
				memoryType: 'episodic',
				sessionId,
				namespaceRef: { namespaceId },
			});
			expect(await store.get(id)).toMatchObject({
				memoryType: 'episodic',
				sessionId,
				namespaceRef: { namespaceId },
				text: 'The user likes tea',
			});
		});

		it('replaces the topics instead of merging them', async () => {
			const id = await seed('update-topics');
			await runPair(workflow, 'Update', { memoryId: id, topics: 'food, drinks' });

			const { items } = await runPair(workflow, 'Update', { memoryId: id, topics: 'travel' });

			expect(items[0].topics).toEqual(['travel']);
			expect(await store.get(id)).toMatchObject({ topics: ['travel'] });
		});

		it('moves the memory to another user when the User ID changes', async () => {
			const id = await seed('update-owner');
			const oldOwner = store.owner('update-owner');
			const newOwner = store.owner('update-owner-new');

			const { items, error } = await runPair(workflow, 'Update', {
				memoryId: id,
				userId: newOwner,
			});

			expect(error).toBeUndefined();
			expect(items[0]).toMatchObject({ id, ownerId: newOwner });
			expect(await idsOwnedBy(newOwner)).toEqual([id]);
			expect(await idsOwnedBy(oldOwner)).toEqual([]);
		});

		it('with no Update Fields fails with a 400 from the server', async () => {
			// The node builds an empty body `{}`; n8n's HTTP helper sends no body
			// at all for an empty object, and the server refuses the request. A
			// direct PATCH with a literal `{}` is a 200 no-op, so the user sees a
			// server error for what is a missing node parameter.
			const id = await seed('update-nothing');

			const { error } = await runPair(workflow, 'Update nothing', { memoryId: id });

			expect(error).toMatchObject({
				...INVALID,
				nodeName: 'Update nothing',
				itemIndex: 0,
				message: 'Request body is required but was empty or missing.',
			});
			expect(error?.context?.data).toMatchObject({
				type: '/errors/invalid-data',
				detail: 'Request body is required but was empty or missing.',
			});
			expect(await store.get(id)).toMatchObject({ text: 'The user likes tea' });
		});

		it.fails(
			'with no Update Fields tells the user to add a field, or returns the record unchanged',
			async () => {
				// Today: NodeApiError 400 "Request body is required but was empty or missing.".
				const id = await seed('update-nothing-wanted');

				const { error, items } = await runPair(workflow, 'Update nothing', { memoryId: id });

				expect(error?.type ?? 'NodeOperationError').toBe('NodeOperationError');
				if (error) expect(error.message).toMatch(/Update Fields/);
				else expect(items[0]).toMatchObject({ id, text: 'The user likes tea' });
			},
		);
	});

	describe('Delete', () => {
		it('deletes an existing memory and reports its ID', async () => {
			const id = await seed('delete-existing');

			const { items, error } = await runPair(workflow, 'Delete', { memoryId: id });

			expect(error).toBeUndefined();
			expect(items).toEqual([{ deleted: true, id }]);
			expect(await store.get(id)).toBeUndefined();
		});

		it('reports success again for a memory that is already gone', async () => {
			// The bulk endpoint lists every requested ID under `deleted`, whether
			// or not it existed, so the node's "was not deleted" check never
			// fires here: deleting is idempotent and silent.
			const id = await seed('delete-twice');
			await runPair(workflow, 'Delete', { memoryId: id });

			const { items, error } = await runPair(workflow, 'Delete', { memoryId: id });

			expect(error).toBeUndefined();
			expect(items).toEqual([{ deleted: true, id }]);
		});
	});

	describe('Move', () => {
		it('moves a memory to a namespace', async () => {
			const id = await seed('move-existing');
			const namespaceId = await store.createNamespace('move-target');

			const { items, error } = await runPair(workflow, 'Move', { memoryId: id, namespaceId });

			expect(error).toBeUndefined();
			expect(items).toEqual([{ moved: true, id, namespaceId }]);
			const fetched = await runPair(workflow, 'Get', { memoryId: id });
			expect(fetched.items[0]).toMatchObject({ namespaceRef: { namespaceId } });
		});

		it('shows a not-found error for a namespace that does not exist', async () => {
			// A Move names two IDs; the server's Problem Details say which one is
			// missing, and the node now passes that on.
			const id = await seed('move-missing-ns');

			const { error } = await runPair(workflow, 'Move', {
				memoryId: id,
				namespaceId: `${runPrefix}-ltm-no-such-namespace`,
			});

			expect(error).toMatchObject({
				...NOT_FOUND,
				nodeName: 'Move',
				message: 'The requested namespace was not found',
				description: 'Namespace Not Found (HTTP 404)',
			});
			expect(error?.context?.data).toMatchObject({
				title: 'Namespace Not Found',
				detail: 'The requested namespace was not found',
			});
		});
	});
});
