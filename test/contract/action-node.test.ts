import { afterAll, describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INode } from 'n8n-workflow';
import { RedisAgentMemory } from '../../nodes/RedisAgentMemory/RedisAgentMemory.node';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import {
	agentMemoryConfig,
	extractionTests,
	runPrefix,
	skipReason,
	summaryViewTests,
} from '../support/env';

const NODE: INode = {
	id: 'action-node',
	name: 'Redis Agent Memory',
	type: '@redis/n8n-nodes-agent-memory.redisAgentMemory',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/**
 * Runs the action node's `execute` with the given parameters against the
 * hosted service: the n8n context is a stub, but the HTTP helper is real.
 * The stub returns the fallback for a missing parameter, so `simple` is true
 * unless a test sets it, and a Namespace locator is given as the plain string
 * n8n would extract from it.
 */
async function run(parameters: Record<string, unknown>): Promise<IDataObject[]> {
	const config = agentMemoryConfig!;
	const ctx = {
		getNode: () => NODE,
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in parameters ? parameters[name] : fallback,
		getCredentials: async () => ({ ...config }),
		continueOnFail: () => false,
		helpers: {
			async httpRequestWithAuthentication(_credentialType: string, options: IHttpRequestOptions) {
				const url = new URL(options.url);
				for (const [key, value] of Object.entries(options.qs ?? {})) {
					url.searchParams.set(key, String(value));
				}
				const response = await fetch(url, {
					method: options.method,
					headers: {
						Authorization: `Bearer ${config.apiKey}`,
						Accept: 'application/json',
						...(options.body ? { 'Content-Type': 'application/json' } : {}),
					},
					body: options.body ? JSON.stringify(options.body) : undefined,
				});
				const text = await response.text();
				if (!response.ok) {
					throw Object.assign(
						new Error(`${options.method} ${url.pathname} returned ${response.status}: ${text}`),
						{
							httpCode: String(response.status),
							response: { status: response.status, body: text },
						},
					);
				}
				return text ? JSON.parse(text) : undefined;
			},
		},
	} as unknown as IExecuteFunctions;

	const [output] = await new RedisAgentMemory().execute.call(ctx);
	return output.map((item) => item.json);
}

describe.skipIf(!agentMemoryConfig)(`Agent Memory action node contract ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const namespaceIds: string[] = [];

	afterAll(async () => {
		for (const namespaceId of namespaceIds) {
			await client
				.request({ method: 'DELETE', path: `/namespaces/${namespaceId}`, allowNotFound: true })
				.catch(() => undefined);
		}
		await client.cleanup();
	});

	it('creates, reads, lists, renames and deletes a namespace', async () => {
		const name = `${runPrefix}-ns`;

		const [created] = await run({
			resource: 'namespace',
			operation: 'create',
			name,
			additionalFields: {},
		});
		const namespaceId = created.namespaceId as string;
		expect(namespaceId).toBeTruthy();
		namespaceIds.push(namespaceId);

		const [fetched] = await run({ resource: 'namespace', operation: 'get', namespaceId });
		expect(fetched).toEqual({ namespaceId, name, scope: 'SHARED', state: 'ACTIVE' });

		const [raw] = await run({
			resource: 'namespace',
			operation: 'get',
			namespaceId,
			simple: false,
		});
		expect(raw).toMatchObject({ namespaceId, name, scope: 'SHARED', state: 'ACTIVE' });
		expect(raw).toHaveProperty('createdAt');
		expect(raw).toHaveProperty('path');

		const listed = await run({ resource: 'namespace', operation: 'getAll', returnAll: true });
		expect(listed.map((n) => n.namespaceId)).toContain(namespaceId);

		const [renamed] = await run({
			resource: 'namespace',
			operation: 'update',
			namespaceId,
			updateFields: { name: `${name}-renamed` },
		});
		expect(renamed).toMatchObject({ namespaceId, name: `${name}-renamed` });

		const [deleted] = await run({ resource: 'namespace', operation: 'delete', namespaceId });
		expect(deleted).toEqual({ deleted: true, namespaceId });
		await expect(
			run({ resource: 'namespace', operation: 'get', namespaceId }),
		).rejects.toMatchObject({ httpCode: '404' });
	});

	it('runs a long-term memory through its whole life', async () => {
		const ownerId = `${runPrefix}-owner-1`;
		const otherOwnerId = `${runPrefix}-owner-2`;
		client.track(`${runPrefix}-unused-session`, ownerId);

		const [created] = await run({
			resource: 'longTermMemory',
			operation: 'create',
			text: 'The user is vegetarian',
			ownerId,
			additionalFields: { topics: 'food, preferences' },
		});
		const memoryId = created.memoryId as string;
		expect(created).toEqual({
			memoryId,
			text: 'The user is vegetarian',
			ownerId,
			topics: ['food', 'preferences'],
		});

		const [fetched] = await run({ resource: 'longTermMemory', operation: 'get', memoryId });
		expect(fetched).toMatchObject({ memoryId, text: 'The user is vegetarian', ownerId });
		expect(fetched).toHaveProperty('createdAt');
		expect(fetched).not.toHaveProperty('updatedAt');

		const found = await run({
			resource: 'longTermMemory',
			operation: 'search',
			query: 'What does the user eat?',
			ownerId,
			maxResults: 5,
			options: {},
		});
		expect(found.map((m) => m.memoryId)).toContain(memoryId);

		const foundForOther = await run({
			resource: 'longTermMemory',
			operation: 'search',
			query: 'What does the user eat?',
			ownerId: otherOwnerId,
			maxResults: 5,
			options: {},
		});
		expect(foundForOther).toEqual([]);

		const listed = await run({
			resource: 'longTermMemory',
			operation: 'getAll',
			returnAll: false,
			limit: 10,
			filters: { ownerId, topics: 'food' },
		});
		expect(listed.map((m) => m.memoryId)).toContain(memoryId);

		const [updated] = await run({
			resource: 'longTermMemory',
			operation: 'update',
			memoryId,
			updateFields: { text: 'The user is vegan' },
		});
		expect(updated).toMatchObject({ memoryId, text: 'The user is vegan' });

		const [namespace] = await run({
			resource: 'namespace',
			operation: 'create',
			name: `${runPrefix}-move-target`,
			additionalFields: {},
		});
		const namespaceId = namespace.namespaceId as string;
		namespaceIds.push(namespaceId);
		const [moved] = await run({
			resource: 'longTermMemory',
			operation: 'move',
			memoryId,
			namespaceId,
		});
		expect(moved).toEqual({ moved: true, memoryId, namespaceId });
		const [afterMove] = await run({ resource: 'longTermMemory', operation: 'get', memoryId });
		expect(afterMove.namespaceId).toBe(namespaceId);
		const [rawAfterMove] = await run({
			resource: 'longTermMemory',
			operation: 'get',
			memoryId,
			simple: false,
		});
		// The API binds a memory with a flat `namespaceId` and versions it with `revision`.
		expect(rawAfterMove).toMatchObject({ memoryId, namespaceId, revision: expect.any(String) });
		expect(rawAfterMove).not.toHaveProperty('namespaceRef');

		const [deleted] = await run({ resource: 'longTermMemory', operation: 'delete', memoryId });
		expect(deleted).toEqual({ deleted: true, memoryId });
		await expect(
			run({ resource: 'longTermMemory', operation: 'get', memoryId }),
		).rejects.toMatchObject({ httpCode: '404' });
	});

	it('adds events to a session, lists it, trims it and deletes it', async () => {
		const sessionId = `${runPrefix}-action-session`;
		const actorId = `${runPrefix}-actor-1`;
		client.track(sessionId, actorId);

		const [first] = await run({
			resource: 'session',
			operation: 'addEvent',
			sessionId,
			actorId,
			role: 'USER',
			text: 'Hello',
			additionalFields: {},
		});
		const [second] = await run({
			resource: 'session',
			operation: 'addEvent',
			sessionId,
			actorId,
			role: 'ASSISTANT',
			text: 'Hi there',
			additionalFields: {},
		});
		expect(first).toMatchObject({ sessionId, actorId, role: 'USER' });
		expect(second).toMatchObject({ role: 'ASSISTANT' });

		const [session] = await run({ resource: 'session', operation: 'get', sessionId, options: {} });
		expect(session.ownerId).toBe(actorId);
		expect(session).not.toHaveProperty('summary');
		expect(session.events).toEqual([
			{
				eventId: first.eventId,
				actorId,
				role: 'USER',
				text: 'Hello',
				createdAt: expect.any(String),
			},
			{
				eventId: second.eventId,
				actorId,
				role: 'ASSISTANT',
				text: 'Hi there',
				createdAt: expect.any(String),
			},
		]);

		const [rawSession] = await run({
			resource: 'session',
			operation: 'get',
			sessionId,
			simple: false,
			options: {},
		});
		expect((rawSession.events as Array<{ content: unknown }>).map((e) => e.content)).toEqual([
			[{ text: 'Hello' }],
			[{ text: 'Hi there' }],
		]);

		const listed = await run({
			resource: 'session',
			operation: 'getAll',
			returnAll: true,
			filters: { ownerId: actorId },
		});
		// Each item carries what the server knows about the session.
		expect(listed).toContainEqual(expect.objectContaining({ sessionId, ownerId: actorId }));

		const [trimmed] = await run({
			resource: 'session',
			operation: 'deleteEvent',
			sessionId,
			eventId: first.eventId as string,
		});
		expect(trimmed).toEqual({ deleted: true, sessionId, eventId: first.eventId });
		const [afterTrim] = await run({
			resource: 'session',
			operation: 'get',
			sessionId,
			options: {},
		});
		expect((afterTrim.events as Array<{ eventId: string }>).map((e) => e.eventId)).toEqual([
			second.eventId,
		]);

		const [deleted] = await run({ resource: 'session', operation: 'delete', sessionId });
		expect(deleted).toEqual({ deleted: true, sessionId });
		await expect(
			run({ resource: 'session', operation: 'get', sessionId, options: {} }),
		).rejects.toMatchObject({ httpCode: '404' });
	});
	describe('memory sources', () => {
		it('lists no sources for a memory written directly, and the API not-found for a missing one', async () => {
			const ownerId = `${runPrefix}-src-owner`;
			client.track(`${runPrefix}-src-no-session`, ownerId);
			const [created] = await run({
				resource: 'longTermMemory',
				operation: 'create',
				text: 'The user prefers window seats',
				ownerId,
				additionalFields: {},
			});
			const memoryId = created.memoryId as string;

			const sources = await run({
				resource: 'longTermMemory',
				operation: 'getSources',
				memoryId,
				returnAll: true,
			});
			expect(sources).toEqual([]);

			const [withSources] = await run({
				resource: 'longTermMemory',
				operation: 'get',
				memoryId,
				includeSources: true,
			});
			expect(withSources).toMatchObject({ memoryId, sources: [] });

			const missingId = `${runPrefix}-src-missing`;
			await expect(
				run({
					resource: 'longTermMemory',
					operation: 'getSources',
					memoryId: missingId,
					returnAll: true,
				}),
			).rejects.toMatchObject({ httpCode: '404' });
			const missing = await client.probe('GET', `/memories/${missingId}/sources`);
			expect(missing.status).toBe(404);
			expect(JSON.parse(missing.body)).toMatchObject({
				type: '/errors/resource-not-found',
				status: 404,
				title: expect.stringMatching(/Not Found$/) as string,
			});
		});

		// Opt-in (AGENT_MEMORY_EXTRACTION_TESTS=true): extraction from session
		// events took from 17 seconds to over two minutes on the hosted store.
		describe.skipIf(!extractionTests)('extracted memories', () => {
			it('names the session and events a memory was extracted from', async () => {
				const sessionId = `${runPrefix}-src-session`;
				const ownerId = `${runPrefix}-src-extracted`;
				const eventIds = await client.addUserEvents(sessionId, ownerId, [
					'My name is Ana Petrova.',
					'I live in Lisbon, Portugal.',
					'I am allergic to peanuts.',
					'I work as a night-shift nurse.',
				]);
				const [extracted] = await client.waitForMemories(ownerId, 180_000);

				const sources = await run({
					resource: 'longTermMemory',
					operation: 'getSources',
					memoryId: extracted.memoryId,
					returnAll: true,
				});
				expect(sources).toEqual([
					{
						sourceId: expect.any(String),
						kind: 'SESSION',
						sessionId,
						eventIds: expect.any(Array),
						evidenceCount: expect.any(Number),
						capturedAt: expect.any(String),
					},
				]);
				const [source] = sources;
				expect(source.eventIds).not.toHaveLength(0);
				for (const eventId of source.eventIds as string[]) expect(eventIds).toContain(eventId);

				const [raw] = await run({
					resource: 'longTermMemory',
					operation: 'getSources',
					memoryId: extracted.memoryId,
					returnAll: true,
					simple: false,
				});
				expect(raw).toMatchObject({
					sourceId: source.sourceId,
					kind: 'SESSION',
					session: { sessionId, ownerId },
				});

				const found = await run({
					resource: 'longTermMemory',
					operation: 'search',
					query: 'What do we know about the user?',
					ownerId,
					maxResults: 100,
					includeSources: true,
					options: {},
				});
				const match = found.find((memory) => memory.memoryId === extracted.memoryId);
				expect(match?.sources).toEqual([
					{
						sourceId: source.sourceId,
						kind: 'SESSION',
						sessionId,
						eventIds: source.eventIds,
					},
				]);
			}, 240_000);
		});
	});

	describe('summary views', () => {
		const viewIds: string[] = [];

		afterAll(async () => {
			for (const viewId of viewIds) {
				await client
					.request({ method: 'DELETE', path: `/summary-views/${viewId}`, allowNotFound: true })
					.catch(() => undefined);
			}
		});

		/** A view grouped by user that computes only on Refresh, created through the node. */
		async function createView(label: string): Promise<IDataObject> {
			const [created] = await run({
				resource: 'summaryView',
				operation: 'create',
				name: `${runPrefix}-${label}`,
				groupBy: ['ownerId'],
				outputFormat: 'TEXT',
				instructions: 'List what is known about the user, one line per fact.',
				refreshMode: 'MANUAL',
				additionalFields: { description: 'Created by the n8n contract tests' },
			});
			viewIds.push(created.viewId as string);
			return created;
		}

		it('creates, reads, lists, refreshes, updates and deletes a view', async () => {
			const created = await createView('view');
			const viewId = created.viewId as string;
			const name = `${runPrefix}-view`;
			expect(created).toEqual({
				viewId,
				name,
				visibility: 'PRIVATE',
				groupBy: ['ownerId'],
				state: 'ACTIVE',
				format: 'TEXT',
				refreshMode: 'MANUAL',
				updatedAt: expect.any(String),
			});
			expect(viewId).toMatch(/^sv_[0-9a-f]{32}$/);

			const [raw] = await run({ resource: 'summaryView', operation: 'get', viewId, simple: false });
			expect(raw).toMatchObject({
				viewId,
				name,
				source: 'LONG_TERM',
				description: 'Created by the n8n contract tests',
				output: {
					format: 'TEXT',
					instructions: 'List what is known about the user, one line per fact.',
				},
				refreshPolicy: { mode: 'MANUAL' },
				definitionVersion: 1,
			});

			const listed = await run({ resource: 'summaryView', operation: 'getAll', returnAll: true });
			expect(listed).toContainEqual(expect.objectContaining({ viewId, name }));

			// A partition nobody has written to is COLD; the node returns it as an item.
			const ownerId = `${runPrefix}-nobody`;
			const [cold] = await run({
				resource: 'summaryView',
				operation: 'getResult',
				viewId,
				scope: { ownerId },
				options: {},
			});
			expect(cold).toEqual({
				viewId,
				status: 'COLD',
				stale: false,
				sourceMemoryCount: 0,
				summarizedMemoryCount: 0,
				truncated: false,
			});
			const [rawCold] = await run({
				resource: 'summaryView',
				operation: 'getResult',
				viewId,
				scope: { ownerId },
				options: {},
				simple: false,
			});
			expect(rawCold).toMatchObject({ viewId, scope: { ownerId }, format: 'TEXT', status: 'COLD' });

			const [accepted] = await run({
				resource: 'summaryView',
				operation: 'refresh',
				viewId,
				target: 'PARTITION',
				scope: { ownerId },
			});
			expect(accepted).toEqual({ viewId, target: 'PARTITION', accepted: true });

			const [updated] = await run({
				resource: 'summaryView',
				operation: 'update',
				viewId,
				updateFields: { name: `${name}-renamed`, state: 'DISABLED' },
			});
			expect(updated).toMatchObject({ viewId, name: `${name}-renamed`, state: 'DISABLED' });

			const [deleted] = await run({ resource: 'summaryView', operation: 'delete', viewId });
			expect(deleted).toEqual({ deleted: true, viewId });
			// Deletion is asynchronous: the view is DELETING until it is gone.
			const after = await client.request<{ state: string }>({
				method: 'GET',
				path: `/summary-views/${viewId}`,
				allowNotFound: true,
			});
			expect(after === undefined || after.state === 'DELETING').toBe(true);
		});

		it('answers Delete with 202 and the DELETING state, and a missing view with the API not-found', async () => {
			const view = await createView('delete-probe');
			const viewId = view.viewId as string;

			const probe = await client.probe('DELETE', `/summary-views/${viewId}`);
			expect(probe.status).toBe(202);
			expect(JSON.parse(probe.body)).toEqual({ viewId, state: 'DELETING' });

			await expect(
				run({
					resource: 'summaryView',
					operation: 'getResult',
					viewId: 'sv_00000000000000000000000000000000',
					scope: { ownerId: 'nobody' },
					options: {},
				}),
			).rejects.toMatchObject({ httpCode: '404' });
			// The server's wording is pinned by the e2e test, inside a real n8n.
			const missing = await client.probe(
				'GET',
				'/summary-views/sv_00000000000000000000000000000000/result?ownerId=nobody',
			);
			expect(missing.status).toBe(404);
			expect(JSON.parse(missing.body)).toEqual({
				type: '/errors/resource-not-found',
				title: 'Summary View Not Found',
				status: 404,
				detail: 'The requested Summary View or exact result was not found.',
			});
		});

		// Opt-in (AGENT_MEMORY_SUMMARY_VIEW_TESTS=true): the server computes the
		// summary with a model, which takes a while and costs money.
		describe.skipIf(!summaryViewTests)('computed result', () => {
			it('refreshes a partition and waits until the summary of the seeded memories is ready', async () => {
				const view = await createView('computed');
				const viewId = view.viewId as string;
				const ownerId = `${runPrefix}-sv-owner`;
				client.track(`${runPrefix}-sv-no-session`, ownerId);
				await client.request({
					method: 'POST',
					path: '/memories',
					body: {
						memories: [
							{ memoryId: `${runPrefix}-sv-1`, ownerId, text: 'The user is vegetarian' },
							{ memoryId: `${runPrefix}-sv-2`, ownerId, text: 'The user lives in Sofia' },
						],
					},
				});

				const [result] = await run({
					resource: 'summaryView',
					operation: 'refresh',
					viewId,
					target: 'PARTITION',
					scope: { ownerId },
					waitForResult: true,
					maxWait: 120,
					options: { includeSourceMemoryIds: true },
				});
				expect(result).toMatchObject({
					viewId,
					status: 'READY',
					text: expect.any(String),
					computedAt: expect.any(String),
					sourceMemoryCount: 2,
				});
				expect(result.sourceMemoryIds).toEqual(
					expect.arrayContaining([`${runPrefix}-sv-1`, `${runPrefix}-sv-2`]),
				);
			}, 150_000);
		});
	});
});
