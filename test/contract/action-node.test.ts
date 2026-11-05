import { afterAll, describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INode } from 'n8n-workflow';
import { RedisAgentMemory } from '../../nodes/RedisAgentMemory/RedisAgentMemory.node';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../support/env';

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
});
