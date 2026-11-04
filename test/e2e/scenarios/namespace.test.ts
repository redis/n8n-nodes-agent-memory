import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { createWorkflow, deleteWorkflow, type CreatedWorkflow } from '../n8n-api';
import { NOT_FOUND_BODY, pairsWorkflow, runPair } from './action-node-support';

/**
 * The action node's Namespace resource inside a real n8n, against the hosted
 * store. Every namespace the file creates is deleted in `afterAll`.
 */

const WORKFLOW = pairsWorkflow('E2E scenario: namespace', [
	{
		key: 'Create namespace',
		parameters: {
			resource: 'namespace',
			operation: 'create',
			name: '={{ $json.body.name }}',
			scope: "={{ $json.body.scope || 'SHARED' }}",
			additionalFields: {
				parentId: '={{ $json.body.parentId }}',
				ownerId: '={{ $json.body.userId }}',
			},
		},
	},
	{
		// Scope left at its default, as a user who only types a name leaves it.
		key: 'Create namespace with defaults',
		parameters: {
			resource: 'namespace',
			operation: 'create',
			name: '={{ $json.body.name }}',
			additionalFields: {},
		},
	},
	{
		key: 'Get namespace',
		parameters: {
			resource: 'namespace',
			operation: 'get',
			namespaceId: '={{ $json.body.namespaceId }}',
		},
	},
	{
		key: 'Get many namespaces',
		parameters: {
			resource: 'namespace',
			operation: 'getAll',
			returnAll: false,
			limit: '={{ $json.body.limit || 50 }}',
		},
	},
	{
		key: 'Get all namespaces',
		parameters: { resource: 'namespace', operation: 'getAll', returnAll: true },
	},
	{
		// Update Fields through expressions: a field the body leaves out resolves
		// to nothing, which the node drops, the same as a field never added.
		key: 'Update namespace',
		parameters: {
			resource: 'namespace',
			operation: 'update',
			namespaceId: '={{ $json.body.namespaceId }}',
			updateFields: {
				name: '={{ $json.body.name }}',
				state: '={{ $json.body.state }}',
			},
		},
	},
	{
		key: 'Delete namespace',
		parameters: {
			resource: 'namespace',
			operation: 'delete',
			namespaceId: '={{ $json.body.namespaceId }}',
		},
	},
]);

describe.skipIf(!agentMemoryConfig)(`E2E scenario: Namespace resource ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const owner = `${runPrefix}-namespace-owner`;
	/** Every namespace created here, oldest first; deleted newest first. */
	const created: string[] = [];
	let workflow: CreatedWorkflow;

	function nameFor(label: string): string {
		return `${runPrefix}-namespace-${label}`;
	}

	/** Creates a namespace through the node and registers it for cleanup. */
	async function createNamespace(body: Record<string, unknown>) {
		const run = await runPair(workflow, 'Create namespace', body);
		const namespaceId = run.items[0]?.namespaceId;
		if (typeof namespaceId === 'string') created.push(namespaceId);
		return run;
	}

	/** Creates a namespace straight on the store, for tests that need one to exist. */
	async function existingNamespace(label: string): Promise<string> {
		const response = await client.request<{ namespace: { namespaceId: string } }>({
			method: 'POST',
			path: '/namespaces',
			body: { name: nameFor(label), scope: 'SHARED' },
		});
		const namespaceId = response!.namespace.namespaceId;
		created.push(namespaceId);
		return namespaceId;
	}

	async function getNamespace(namespaceId: unknown) {
		return await runPair(workflow, 'Get namespace', { namespaceId });
	}

	beforeAll(async () => {
		workflow = await createWorkflow(WORKFLOW);
	});

	afterAll(async () => {
		if (workflow) await deleteWorkflow(workflow.id);
		// Memories first: a namespace that still holds one may refuse to go.
		await client.cleanup();
		for (const namespaceId of [...created].reverse()) {
			await client.request({
				method: 'DELETE',
				path: `/namespaces/${encodeURIComponent(namespaceId)}`,
				allowNotFound: true,
			});
		}
	});

	describe('Create', () => {
		it('creates a SHARED namespace when Scope is left at its default', async () => {
			const name = nameFor('default-scope');

			const { response, items, error } = await runPair(workflow, 'Create namespace with defaults', {
				name,
			});
			if (typeof items[0]?.namespaceId === 'string') created.push(items[0].namespaceId);

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ name, scope: 'SHARED' });
			expect(items[0].namespaceId).toEqual(expect.any(String));
		});

		it('creates a PERSONAL namespace for the user given', async () => {
			const name = nameFor('personal');

			const { items, error } = await createNamespace({ name, scope: 'PERSONAL', userId: owner });

			expect(error).toBeUndefined();
			expect(items[0]).toMatchObject({ name, scope: 'PERSONAL', ownerId: owner });
		});

		it("surfaces the server's 400 for PERSONAL without a User ID", async () => {
			const name = nameFor('personal-no-user');

			const { response, items, error } = await createNamespace({ name, scope: 'PERSONAL' });

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Create namespace',
				type: 'NodeApiError',
				httpCode: '400',
				message: 'cannot be blank',
				description: 'Invalid Request (HTTP 400)',
			});
			expect(error?.context?.data).toEqual({
				type: '/errors/invalid-data',
				title: 'Invalid Request',
				status: 400,
				detail: 'cannot be blank',
			});
		});

		// Today the user sees the server's reason, "cannot be blank", which does not
		// say what is blank; the node must check this itself (report, fix 6).
		it.fails('tells the user that a PERSONAL namespace needs a User ID', async () => {
			const { error } = await createNamespace({
				name: nameFor('personal-no-user-reason'),
				scope: 'PERSONAL',
			});

			expect(`${error?.message} ${error?.description}`).toContain('User ID');
		});

		// Today the node always sends `scope` (its default is SHARED), and the
		// server answers 400 "a child cannot specify scope or ownerId". So no
		// namespace can be nested through the node. Without `scope` the same
		// request succeeds and the child inherits the parent's scope.
		it.fails('nests a namespace under the parent given', async () => {
			const parentId = await existingNamespace('parent');
			const name = nameFor('child');

			const { items, error } = await createNamespace({ name, parentId });

			expect(error).toBeUndefined();
			expect(items[0]).toMatchObject({ name, parentId, scope: 'SHARED' });
		});

		it("surfaces the server's 400 when Parent ID is given (pins today's behaviour)", async () => {
			const parentId = await existingNamespace('parent-today');

			const { response, items, error } = await createNamespace({
				name: nameFor('child-today'),
				parentId,
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Create namespace',
				httpCode: '400',
				message: 'a child cannot specify scope or ownerId',
			});
			expect(error?.context?.data).toMatchObject({
				type: '/errors/invalid-data',
				detail: 'a child cannot specify scope or ownerId',
			});
		});

		// Today the scope error above comes first. Sent without `scope`, the
		// server answers 404 "Namespace Not Found" for the parent.
		it.fails("surfaces the API's not-found for a parent that does not exist", async () => {
			const { error } = await createNamespace({
				name: nameFor('orphan'),
				parentId: `${runPrefix}-no-such-parent`,
			});

			expect(error).toMatchObject({ nodeName: 'Create namespace', httpCode: '404' });
			expect(error?.context?.data).toMatchObject({
				...NOT_FOUND_BODY,
				title: 'Namespace Not Found',
			});
		});

		it("rejects an empty name with 'Name' is empty", async () => {
			const { response, items, error } = await createNamespace({ name: '  ' });

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Create namespace',
				type: 'NodeOperationError',
				message: "'Name' is empty",
				itemIndex: 0,
			});
		});

		// The suite's one 409 example: the node shows the server's title and
		// detail, and keeps the body in the context data.
		it("surfaces the server's 409 for the same name twice", async () => {
			const name = nameFor('twice');
			const first = await createNamespace({ name });
			expect(first.error).toBeUndefined();

			const second = await createNamespace({ name });

			expect(second.response.status).toBe(500);
			expect(second.items).toEqual([]);
			expect(second.error).toMatchObject({
				nodeName: 'Create namespace',
				type: 'NodeApiError',
				httpCode: '409',
				message: 'An exact root or sibling namespace already exists',
				description: 'Namespace Already Exists (HTTP 409)',
			});
			expect(second.error?.context?.data).toEqual({
				type: '/errors/conflict',
				title: 'Namespace Already Exists',
				status: 409,
				detail: 'An exact root or sibling namespace already exists',
			});
		});
	});

	describe('Get', () => {
		it('returns the namespace with its id, name, scope and state', async () => {
			const name = nameFor('get');
			const { items: createdItems } = await createNamespace({ name });
			const namespaceId = createdItems[0].namespaceId;

			const { response, items, error } = await getNamespace(namespaceId);

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ namespaceId, name, scope: 'SHARED', state: 'ACTIVE' });
		});

		it("surfaces the API's not-found for a namespace that does not exist", async () => {
			const { response, error } = await getNamespace(`${runPrefix}-namespace-missing`);

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Get namespace',
				type: 'NodeApiError',
				httpCode: '404',
				message: 'The requested namespace was not found',
				description: 'Namespace Not Found (HTTP 404)',
			});
			expect(error?.context?.data).toMatchObject({
				...NOT_FOUND_BODY,
				title: 'Namespace Not Found',
			});
		});
	});

	describe('Get Many', () => {
		it('returns at most 2 items with a limit of 2', async () => {
			await existingNamespace('list-1');
			await existingNamespace('list-2');

			const { response, items, error } = await runPair(workflow, 'Get many namespaces', {
				limit: 2,
			});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items).toHaveLength(2);
			for (const item of items) {
				expect(item).toMatchObject({ namespaceId: expect.any(String), name: expect.any(String) });
			}
		});

		it('returns every namespace, including all of this run, with Return All', async () => {
			const mine = [
				await existingNamespace('all-1'),
				await existingNamespace('all-2'),
				await existingNamespace('all-3'),
			];

			const { items, error } = await runPair(workflow, 'Get all namespaces', {});

			expect(error).toBeUndefined();
			expect(items.map((item) => item.namespaceId)).toEqual(expect.arrayContaining(mine));
		});
	});

	describe('Update', () => {
		it('renames a namespace and leaves its state alone', async () => {
			const namespaceId = await existingNamespace('rename');
			const name = nameFor('renamed');

			const { response, items, error } = await runPair(workflow, 'Update namespace', {
				namespaceId,
				name,
			});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items[0]).toMatchObject({ namespaceId, name, state: 'ACTIVE' });
			const fetched = await getNamespace(namespaceId);
			expect(fetched.items[0]).toMatchObject({ name, state: 'ACTIVE' });
		});

		it('archives a namespace', async () => {
			const namespaceId = await existingNamespace('archive');

			const { response, items, error } = await runPair(workflow, 'Update namespace', {
				namespaceId,
				state: 'ARCHIVED',
			});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items[0]).toMatchObject({ namespaceId, state: 'ARCHIVED' });
			expect((await getNamespace(namespaceId)).items[0].state).toBe('ARCHIVED');
		});

		// The State field offers Active and Archived, but the server only
		// archives: "state can only be ARCHIVED". Choosing Active always fails.
		it("surfaces the server's refusal to make an archived namespace active again", async () => {
			const namespaceId = await existingNamespace('reactivate');
			await runPair(workflow, 'Update namespace', { namespaceId, state: 'ARCHIVED' });

			const { response, items, error } = await runPair(workflow, 'Update namespace', {
				namespaceId,
				state: 'ACTIVE',
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Update namespace',
				type: 'NodeApiError',
				httpCode: '400',
				message: 'state can only be ARCHIVED',
			});
			expect(error?.context?.data).toMatchObject({
				type: '/errors/invalid-data',
				detail: 'state can only be ARCHIVED',
			});
			expect((await getNamespace(namespaceId)).items[0].state).toBe('ARCHIVED');
		});

		// With no Update Fields the node sends `{}`, which reaches the server as
		// no body at all, and the server answers 400.
		it("surfaces the server's 400 for an update with no fields", async () => {
			const namespaceId = await existingNamespace('no-fields');

			const { response, items, error } = await runPair(workflow, 'Update namespace', {
				namespaceId,
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Update namespace',
				type: 'NodeApiError',
				httpCode: '400',
				message: 'Request body is required but was empty or missing.',
			});
			expect(error?.context?.data).toMatchObject({
				type: '/errors/invalid-data',
				detail: 'Request body is required but was empty or missing.',
			});
		});

		// Today the request goes out and fails as above; the user is not told
		// that the node needs at least one Update Field.
		it.fails('tells the user that an update needs at least one field', async () => {
			const namespaceId = await existingNamespace('no-fields-reason');

			const { error } = await runPair(workflow, 'Update namespace', { namespaceId });

			expect(error?.type).toBe('NodeOperationError');
			expect(`${error?.message} ${error?.description}`).toContain('Update Fields');
		});
	});

	describe('Delete', () => {
		it('deletes an empty namespace, after which Get reports not found', async () => {
			const namespaceId = await existingNamespace('delete');

			const { response, items, error } = await runPair(workflow, 'Delete namespace', {
				namespaceId,
			});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items).toEqual([{ deleted: true, namespaceId }]);
			const fetched = await getNamespace(namespaceId);
			expect(fetched.error).toMatchObject({ httpCode: '404' });
			expect(fetched.error?.context?.data).toMatchObject(NOT_FOUND_BODY);
		});

		// The server refuses with 409 and keeps the memory.
		it("surfaces the server's 409 for a namespace that still holds a memory", async () => {
			const namespaceId = await existingNamespace('with-memory');
			// A session is needed to register the owner; cleanup deletes the owner's memories.
			client.track(`${runPrefix}-namespace-memory-session`, owner);
			const memoryId = `${runPrefix}-namespace-memory`;
			const stored = await client.request<{ created?: string[] }>({
				method: 'POST',
				path: '/long-term-memory',
				body: {
					memories: [
						{
							id: memoryId,
							text: 'lives in a namespace',
							ownerId: owner,
							namespaceRef: { namespaceId },
						},
					],
				},
			});
			expect(stored?.created).toContain(memoryId);

			const { response, items, error } = await runPair(workflow, 'Delete namespace', {
				namespaceId,
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Delete namespace',
				type: 'NodeApiError',
				httpCode: '409',
				message: 'A namespace with children or placed memories cannot be deleted',
				description: 'Namespace Is Not Empty (HTTP 409)',
			});
			expect(error?.context?.data).toEqual({
				type: '/errors/conflict',
				title: 'Namespace Is Not Empty',
				status: 409,
				detail: 'A namespace with children or placed memories cannot be deleted',
			});
			const after = await client.request({
				method: 'GET',
				path: `/long-term-memory/${encodeURIComponent(memoryId)}`,
				allowNotFound: true,
			});
			expect(after).toBeDefined();
			expect((await getNamespace(namespaceId)).items[0]).toMatchObject({ namespaceId });
		});
	});
});
