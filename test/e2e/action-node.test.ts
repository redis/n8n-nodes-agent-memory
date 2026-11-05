import { afterAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../support/env';
import {
	ACTION_NODE_WORKFLOW,
	callWebhookAndWait,
	executionError,
	N8N_URL,
	postJson,
	restData,
	type ExecutionError,
} from './harness';

/** An event as Session → Get returns it with Simplify on. */
interface SimpleEvent {
	eventId: string;
	actorId: string;
	role: string;
	text: string;
}

/** An event as the API returns it, which Simplify off passes through. */
interface StoredEvent {
	eventId: string;
	actorId: string;
	content: Array<{ text: string }>;
}

interface Memory {
	memoryId: string;
	text: string;
	ownerId: string;
}

/**
 * Posts to a webhook whose last node is the action node, and returns its
 * output items. n8n answers with one object for one item, an array for
 * several, and an empty body for none.
 */
async function callAction<T>(path: string, body: object): Promise<T[]> {
	const response = await fetch(`${N8N_URL}/webhook/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	// With "Respond: When Last Node Finishes", n8n answers 500 when the node
	// returned no items, which is the normal result of a search with no hits.
	if (response.status === 500 && text.includes('No item to return was found')) return [];
	if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${text}`);
	if (!text.trim()) return [];
	const data = JSON.parse(text) as T | T[];
	return Array.isArray(data) ? data : [data];
}

/**
 * Posts to a webhook whose run is expected to fail, and returns the error
 * the editor shows on the node. The webhook itself answers only
 * `500 Error in workflow`.
 */
async function failingAction(path: string, body: object): Promise<ExecutionError> {
	const { response, execution } = await callWebhookAndWait(ACTION_NODE_WORKFLOW, path, body);
	expect(response.status, response.body).toBe(500);
	const error = executionError(execution);
	if (!error) throw new Error(`The execution of ${path} saved no error`);
	return error;
}

describe.skipIf(!agentMemoryConfig)(
	`Redis Agent Memory action node inside n8n ${skipReason}`,
	() => {
		const client = new AgentMemoryTestClient(agentMemoryConfig!);
		/** Namespaces created here, oldest first; deleted newest first, after the memories. */
		const namespaceIds: string[] = [];
		/** Summary views created here. */
		const viewIds: string[] = [];

		/** A user ID inside this run's prefix, registered for cleanup. */
		function newUser(label: string): string {
			const userId = `${runPrefix}-action-${label}`;
			client.track(`${runPrefix}-action-no-session`, userId);
			return userId;
		}

		/** Creates memories straight on the store, so a test has data without the node. */
		async function createMemories(memories: Array<Memory & { topics?: string[] }>): Promise<void> {
			await client.request({ method: 'POST', path: '/memories', body: { memories } });
		}

		async function getMemory(memoryId: string): Promise<Memory | undefined> {
			return await client.request<Memory>({
				method: 'GET',
				path: `/memories/${encodeURIComponent(memoryId)}`,
				allowNotFound: true,
			});
		}

		/** Creates a namespace straight on the store and registers it for cleanup. */
		async function createNamespace(label: string): Promise<string> {
			const created = await client.request<{ namespace: { namespaceId: string } }>({
				method: 'POST',
				path: '/namespaces',
				body: { name: `${runPrefix}-action-${label}`, scope: 'SHARED' },
			});
			const namespaceId = created!.namespace.namespaceId;
			namespaceIds.push(namespaceId);
			return namespaceId;
		}

		async function getNamespace(namespaceId: string): Promise<{ name: string; state: string }> {
			const fetched = await client.request<{ namespace: { name: string; state: string } }>({
				method: 'GET',
				path: `/namespaces/${encodeURIComponent(namespaceId)}`,
			});
			return fetched!.namespace;
		}

		afterAll(async () => {
			await client.cleanup();
			for (const viewId of viewIds) {
				await client
					.request({ method: 'DELETE', path: `/summary-views/${viewId}`, allowNotFound: true })
					.catch(() => undefined);
			}
			for (const namespaceId of [...namespaceIds].reverse()) {
				await client.request({
					method: 'DELETE',
					path: `/namespaces/${encodeURIComponent(namespaceId)}`,
					allowNotFound: true,
				});
			}
		});

		it('trims a session with Delete Event, through the Memory Manager and the action node', async () => {
			const sessionId = `${runPrefix}-e2e-action-session`;
			const userId = `${runPrefix}-action-user-1`;
			client.track(sessionId, userId);
			await postJson('/webhook/e2e-memory-insert', {
				sessionId,
				userId,
				user: 'First',
				ai: 'Second',
			});

			const [session] = await callAction<{ ownerId: string; events: SimpleEvent[] }>(
				'e2e-action-session-get',
				{ sessionId },
			);
			expect(session.ownerId).toBe(userId);
			expect(session.events.map((e) => e.text)).toEqual(['First', 'Second']);

			const [deleted] = await callAction<{ deleted: boolean; eventId: string }>(
				'e2e-action-event-delete',
				{ sessionId, eventId: session.events[0].eventId },
			);
			expect(deleted).toEqual({ deleted: true, sessionId, eventId: session.events[0].eventId });

			const [after] = await callAction<{ events: SimpleEvent[] }>('e2e-action-session-get', {
				sessionId,
			});
			expect(after.events.map((e) => e.text)).toEqual(['Second']);

			// With Simplify off, the events keep the API's content parts.
			const [raw] = await callAction<{ events: StoredEvent[] }>('e2e-action-session-get', {
				sessionId,
				simple: false,
			});
			expect(raw.events.map((e) => e.content)).toEqual([[{ text: 'Second' }]]);
		});

		it('creates a memory, finds it for its user only, then deletes it', async () => {
			const userId = `${runPrefix}-action-user-2`;
			const otherUserId = `${runPrefix}-action-user-3`;
			client.track(`${runPrefix}-unused`, userId);

			const [created] = await callAction<Memory>('e2e-action-memory-create', {
				userId,
				text: 'The user is allergic to peanuts',
			});
			expect(created).toMatchObject({ text: 'The user is allergic to peanuts', ownerId: userId });
			expect(created.memoryId).toMatch(/^n8n-/);

			const found = await callAction<Memory>('e2e-action-memory-search', {
				userId,
				query: 'Does the user have any allergies?',
			});
			expect(found.map((m) => m.memoryId)).toContain(created.memoryId);

			const foundForOther = await callAction<Memory>('e2e-action-memory-search', {
				userId: otherUserId,
				query: 'Does the user have any allergies?',
			});
			expect(foundForOther).toEqual([]);

			const [deleted] = await callAction<{ deleted: boolean; memoryId: string }>(
				'e2e-action-memory-delete',
				{ memoryId: created.memoryId },
			);
			expect(deleted).toEqual({ deleted: true, memoryId: created.memoryId });
			const afterDelete = await callAction<Memory>('e2e-action-memory-search', {
				userId,
				query: 'Does the user have any allergies?',
			});
			expect(afterDelete.map((m) => m.memoryId)).not.toContain(created.memoryId);
		});

		it('returns simplified records by default and the raw API objects with Simplify off', async () => {
			const userId = newUser('simplify');
			const namespaceId = await createNamespace('simplify');
			const targetId = await createNamespace('simplify-target');

			const [created] = await callAction<Record<string, unknown>>('e2e-action-memory-create', {
				userId,
				text: 'The user drinks oat milk',
				namespaceId,
			});
			expect(created).toEqual({
				memoryId: expect.stringMatching(/^n8n-/),
				text: 'The user drinks oat milk',
				ownerId: userId,
				namespaceId,
			});

			// With Simplify off, the API's record comes through: the same flat
			// `namespaceId`, plus the bookkeeping fields Simplify drops.
			const [raw] = await callAction<Record<string, unknown>>('e2e-action-memory-get', {
				memoryId: created.memoryId,
				simple: false,
			});
			expect(raw).toMatchObject({
				memoryId: created.memoryId,
				namespaceId,
				revision: expect.any(String),
				updatedAt: expect.any(String),
			});

			// The Namespace locator in ID mode, fed by an expression.
			const [moved] = await callAction<Record<string, unknown>>('e2e-action-memory-move', {
				memoryId: created.memoryId,
				namespaceId: targetId,
			});
			expect(moved).toEqual({ moved: true, memoryId: created.memoryId, namespaceId: targetId });
			const [afterMove] = await callAction<Record<string, unknown>>('e2e-action-memory-get', {
				memoryId: created.memoryId,
			});
			expect(afterMove).toMatchObject({ memoryId: created.memoryId, namespaceId: targetId });

			const [namespace] = await callAction<Record<string, unknown>>('e2e-action-namespace-get', {
				namespaceId,
			});
			expect(namespace).toEqual({
				namespaceId,
				name: `${runPrefix}-action-simplify`,
				scope: 'SHARED',
				state: 'ACTIVE',
			});
			const [rawNamespace] = await callAction<Record<string, unknown>>('e2e-action-namespace-get', {
				namespaceId,
				simple: false,
			});
			expect(rawNamespace).toMatchObject({ namespaceId, path: expect.any(String) });
			expect(rawNamespace).toHaveProperty('createdAt');
		});

		// The editor fills the Namespace locator's "From List" mode through this
		// endpoint, which runs the node's `searchNamespaces` with the credential.
		it("lists the store's namespaces for the Namespace locator", async () => {
			const page = await restData<{ results: Array<{ name: string; value: string }> }>(
				'/dynamic-node-parameters/resource-locator-results',
				{
					path: 'parameters.namespaceId',
					methodName: 'searchNamespaces',
					nodeTypeAndVersion: {
						name: '@redis/n8n-nodes-agent-memory.redisAgentMemory',
						version: 1,
					},
					currentNodeParameters: { resource: 'namespace', operation: 'get' },
					credentials: {
						redisAgentMemoryApi: { id: 'e2eAgentMemory01', name: 'Agent Memory (e2e)' },
					},
				},
			);

			expect(page.results.length).toBeGreaterThan(0);
			for (const item of page.results) {
				expect(item).toEqual({ name: expect.any(String), value: expect.any(String) });
			}
		});

		// Each test here pins a fix to a defect the first end-to-end run of the
		// node surfaced (docs/testing.md, "How the design was verified"). The webhook answers a
		// failed run with `500 Error in workflow` only, so the error assertions
		// read the saved execution: the message, description and status the
		// editor shows on the red node.
		describe('summary views', () => {
			/** A view grouped by user, computed only on Refresh, created straight on the store. */
			async function createView(label: string): Promise<{ viewId: string; name: string }> {
				const name = `${runPrefix}-action-${label}`;
				const created = await client.request<{ viewId: string }>({
					method: 'POST',
					path: '/summary-views',
					body: {
						name,
						source: 'LONG_TERM',
						groupBy: ['ownerId'],
						output: { format: 'TEXT' },
						refreshPolicy: { mode: 'MANUAL' },
					},
				});
				viewIds.push(created!.viewId);
				return { viewId: created!.viewId, name };
			}

			it("reads a view and a user's result, simplified by default and raw with Simplify off", async () => {
				const { viewId, name } = await createView('view');
				const userId = newUser('view-user');

				const [view] = await callAction<Record<string, unknown>>('e2e-action-view-get', { viewId });
				expect(view).toEqual({
					viewId,
					name,
					visibility: 'PRIVATE',
					groupBy: ['ownerId'],
					state: 'ACTIVE',
					format: 'TEXT',
					refreshMode: 'MANUAL',
					updatedAt: expect.any(String),
				});

				// Nothing has been computed for this user, so the partition is COLD.
				const [result] = await callAction<Record<string, unknown>>('e2e-action-view-result', {
					viewId,
					userId,
				});
				expect(result).toEqual({
					viewId,
					status: 'COLD',
					stale: false,
					sourceMemoryCount: 0,
					summarizedMemoryCount: 0,
					truncated: false,
				});

				const [raw] = await callAction<Record<string, unknown>>('e2e-action-view-result', {
					viewId,
					userId,
					simple: false,
				});
				expect(raw).toMatchObject({
					viewId,
					scope: { ownerId: userId },
					status: 'COLD',
					format: 'TEXT',
					definitionVersion: 1,
				});
			});

			it('shows the server reason when the view does not exist', async () => {
				const error = await failingAction('e2e-action-view-result', {
					viewId: 'sv_00000000000000000000000000000000',
					userId: newUser('no-view'),
				});
				expect(error).toMatchObject({
					nodeName: 'Action: view-result',
					type: 'NodeApiError',
					httpCode: '404',
					message: 'The requested Summary View or exact result was not found.',
					description: 'Summary View Not Found (HTTP 404)',
				});
			});
		});

		describe('fixes verified inside n8n', () => {
			// The editor showed n8n's generic status text; the server's reason stayed hidden.
			it('shows the server reason for a missing memory and for a refused session ID', async () => {
				const missing = await failingAction('e2e-action-memory-get', {
					memoryId: `${runPrefix}-action-missing`,
				});
				expect(missing).toMatchObject({
					nodeName: 'Action: memory-get',
					type: 'NodeApiError',
					httpCode: '404',
					message: 'The requested memory was not found',
					description: 'Memory Not Found (HTTP 404)',
				});

				// Not tracked: the server never creates it.
				const refused = await failingAction('e2e-action-event-add', {
					sessionId: `${runPrefix}-action-a b`,
					userId: newUser('refused-id'),
					text: 'rejected id',
				});
				expect(refused).toMatchObject({
					nodeName: 'Action: event-add',
					type: 'NodeApiError',
					httpCode: '400',
					// The server's own wording; it names the allowed characters, which
					// have changed once already (underscores were added on the Iris API).
					message: expect.stringMatching(
						/^SessionID: must contain only alphanumeric characters \(A-Z, a-z, 0-9\).*hyphens \(-\)\.$/,
					) as string,
					description: 'Invalid Request (HTTP 400)',
				});
			});

			// "Filter Match: Any" put the User ID on a par with the other filters,
			// so a shared topic leaked another user's memory. The option is gone;
			// a workflow saved with it still carries `filterOp`, which the node ignores.
			it("never returns another user's memory, even with a stale Filter Match = Any", async () => {
				const userId = newUser('filter-user');
				const otherUserId = newUser('filter-other');
				const own = `${runPrefix}-action-filter-own`;
				const theirs = `${runPrefix}-action-filter-theirs`;
				await createMemories([
					{ memoryId: own, ownerId: userId, text: 'The user drinks tea', topics: ['drinks'] },
					{
						memoryId: theirs,
						ownerId: otherUserId,
						text: 'The user drinks coffee',
						topics: ['drinks'],
					},
				]);

				const found = await callAction<Memory>('e2e-action-memory-search', {
					userId,
					query: 'What does the user drink?',
					filterOp: 'any',
					topics: 'drinks',
				});

				expect(found.map((m) => m.memoryId)).toContain(own);
				expect(found.map((m) => m.memoryId)).not.toContain(theirs);
				expect(found.every((m) => m.ownerId === userId)).toBe(true);
			});

			// Create sent scope and owner along with Parent ID, which the server refused.
			it('nests a namespace under the parent given', async () => {
				const parentId = await createNamespace('parent');
				const name = `${runPrefix}-action-child`;

				const [child] = await callAction<{ namespaceId: string; parentId: string; name: string }>(
					'e2e-action-namespace-create',
					{ name, parentId },
				);
				namespaceIds.push(child.namespaceId);

				expect(child).toEqual({
					namespaceId: child.namespaceId,
					name,
					scope: 'SHARED',
					state: 'ACTIVE',
					parentId,
				});
			});

			// Get Many with no User ID sent no filter, which the server refused;
			// it now asks the server for every session.
			it('lists sessions when Get Many has no User ID', async () => {
				const sessionId = `${runPrefix}-action-listed`;
				const userId = newUser('listed');
				client.track(sessionId, userId);
				await callAction('e2e-action-event-add', { sessionId, userId, text: 'listed' });

				const sessions = await callAction<{ sessionId: string }>('e2e-action-session-list', {});

				expect(sessions.map((s) => s.sessionId)).toContain(sessionId);
			});

			// Four requests the server refused with a 400 that named no parameter;
			// the node now refuses them itself, before any request.
			it('refuses an empty filter, empty update fields and a personal namespace without a user', async () => {
				const memoryId = `${runPrefix}-action-unchanged`;
				await createMemories([{ memoryId, ownerId: newUser('unchanged'), text: 'Likes tea' }]);
				const namespaceId = await createNamespace('unchanged');

				const noFilter = await failingAction('e2e-action-memory-list', {});
				expect(noFilter).toMatchObject({
					nodeName: 'Action: memory-list',
					type: 'NodeOperationError',
					message: 'Add at least one filter',
				});

				const emptyMemoryUpdate = await failingAction('e2e-action-memory-update', { memoryId });
				expect(emptyMemoryUpdate).toMatchObject({
					nodeName: 'Action: memory-update',
					type: 'NodeOperationError',
					message: "'Update Fields' is empty",
				});
				expect(await getMemory(memoryId)).toMatchObject({ text: 'Likes tea' });

				const emptyNamespaceUpdate = await failingAction('e2e-action-namespace-update', {
					namespaceId,
				});
				expect(emptyNamespaceUpdate).toMatchObject({
					nodeName: 'Action: namespace-update',
					type: 'NodeOperationError',
					message: "'Update Fields' is empty",
				});
				expect(await getNamespace(namespaceId)).toMatchObject({
					name: `${runPrefix}-action-unchanged`,
					state: 'ACTIVE',
				});

				const personal = await failingAction('e2e-action-namespace-create', {
					name: `${runPrefix}-action-personal`,
					scope: 'PERSONAL',
				});
				expect(personal).toMatchObject({
					nodeName: 'Action: namespace-create',
					type: 'NodeOperationError',
					message: 'A personal namespace needs a User ID',
				});
			});

			// A Created At that is not a date became "Invalid Date" on the wire.
			it("names 'Created At' when its value is not a date", async () => {
				const sessionId = `${runPrefix}-action-undated`;
				client.track(sessionId, newUser('undated'));

				const error = await failingAction('e2e-action-event-add', {
					sessionId,
					userId: `${runPrefix}-action-undated`,
					text: 'dated',
					createdAt: 'yesterday',
				});

				expect(error).toMatchObject({
					nodeName: 'Action: event-add',
					type: 'NodeOperationError',
					message: `'Created At' is not a date: "yesterday"`,
				});
				expect(await client.getSession(sessionId)).toBeUndefined();
			});

			// Update offered a State dropdown whose values the server ignored.
			it('archives a namespace with the Archive switch', async () => {
				const namespaceId = await createNamespace('archive');

				const [updated] = await callAction<{ namespaceId: string; state: string }>(
					'e2e-action-namespace-update',
					{ namespaceId, archive: true },
				);

				expect(updated).toMatchObject({ namespaceId, state: 'ARCHIVED' });
				expect((await getNamespace(namespaceId)).state).toBe('ARCHIVED');
			});

			// The editor caps Max Results at 100; an expression bypassed the cap
			// and the server's 400 named no parameter.
			it('names Max Results when an expression sets it above 100', async () => {
				const error = await failingAction('e2e-action-memory-search', {
					userId: newUser('max-results'),
					query: 'tea',
					maxResults: 500,
				});

				expect(error).toMatchObject({
					nodeName: 'Action: memory-search',
					type: 'NodeOperationError',
					message: "'Max Results' must be a whole number from 1 to 100",
				});
			});
		});
	},
);
