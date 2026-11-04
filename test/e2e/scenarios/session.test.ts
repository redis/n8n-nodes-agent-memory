import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentMemorySessionResponse } from '../../../nodes/RedisAgentMemoryChatMemory/memory';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { createWorkflow, deleteWorkflow, type CreatedWorkflow } from '../n8n-api';
import { NOT_FOUND_BODY, pairsWorkflow, runPair } from './action-node-support';

/**
 * The action node's Session resource inside a real n8n: parameters resolve
 * from the webhook body through expressions, the node calls the hosted
 * store, and the test reads the items or the error the execution saved.
 */

const WORKFLOW = pairsWorkflow('E2E scenario: session', [
	{
		key: 'Add event',
		parameters: {
			resource: 'session',
			operation: 'addEvent',
			sessionId: '={{ $json.body.sessionId }}',
			actorId: '={{ $json.body.userId }}',
			role: "={{ $json.body.role || 'USER' }}",
			text: '={{ $json.body.text }}',
			additionalFields: {
				createdAt: '={{ $json.body.createdAt }}',
				namespaceId: '={{ $json.body.namespaceId }}',
			},
		},
	},
	{
		// Created At from n8n's own date type, as a user picks it in the editor.
		key: 'Add event dated yesterday',
		parameters: {
			resource: 'session',
			operation: 'addEvent',
			sessionId: '={{ $json.body.sessionId }}',
			actorId: '={{ $json.body.userId }}',
			role: 'USER',
			text: '={{ $json.body.text }}',
			additionalFields: { createdAt: '={{ $now.minus({ days: 1 }) }}' },
		},
	},
	{
		key: 'Get session',
		parameters: {
			resource: 'session',
			operation: 'get',
			sessionId: '={{ $json.body.sessionId }}',
			options: {},
		},
	},
	{
		key: 'Get session with summarized events',
		parameters: {
			resource: 'session',
			operation: 'get',
			sessionId: '={{ $json.body.sessionId }}',
			options: { includeSummarisedEvents: true },
		},
	},
	{
		key: 'Get many sessions',
		parameters: {
			resource: 'session',
			operation: 'getAll',
			returnAll: false,
			limit: '={{ $json.body.limit || 50 }}',
			filters: { ownerId: '={{ $json.body.userId }}' },
		},
	},
	{
		key: 'Get all sessions',
		parameters: {
			resource: 'session',
			operation: 'getAll',
			returnAll: true,
			filters: { ownerId: '={{ $json.body.userId }}' },
		},
	},
	{
		key: 'Delete session',
		parameters: {
			resource: 'session',
			operation: 'delete',
			sessionId: '={{ $json.body.sessionId }}',
		},
	},
	{
		key: 'Delete event',
		parameters: {
			resource: 'session',
			operation: 'deleteEvent',
			sessionId: '={{ $json.body.sessionId }}',
			eventId: '={{ $json.body.eventId }}',
		},
	},
]);

type Event = AgentMemorySessionResponse['events'][number];

const WELL_FORMED_UNKNOWN_EVENT_ID = '0123456789abcdef0123456789abcdef';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!agentMemoryConfig)(`E2E scenario: Session resource ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const userA = `${runPrefix}-session-user-a`;
	const userB = `${runPrefix}-session-user-b`;
	const namespaceIds: string[] = [];
	let workflow: CreatedWorkflow;

	/** A fresh session ID for one test, registered for cleanup. */
	function sessionFor(label: string): string {
		const sessionId = `${runPrefix}-session-${label}`;
		client.track(sessionId, userA);
		return sessionId;
	}

	async function addEvent(body: Record<string, unknown>) {
		return await runPair(workflow, 'Add event', { userId: userA, ...body });
	}

	async function getSession(sessionId: unknown) {
		const run = await runPair(workflow, 'Get session', { sessionId });
		return { ...run, session: run.items[0] as unknown as AgentMemorySessionResponse | undefined };
	}

	async function createNamespace(label: string): Promise<string> {
		const created = await client.request<{ namespace: { namespaceId: string } }>({
			method: 'POST',
			path: '/namespaces',
			body: { name: `${runPrefix}-session-${label}`, scope: 'SHARED' },
		});
		const namespaceId = created!.namespace.namespaceId;
		namespaceIds.push(namespaceId);
		return namespaceId;
	}

	beforeAll(async () => {
		workflow = await createWorkflow(WORKFLOW);
	});

	afterAll(async () => {
		if (workflow) await deleteWorkflow(workflow.id);
		await client.cleanup();
		for (const namespaceId of namespaceIds) {
			await client.request({
				method: 'DELETE',
				path: `/namespaces/${encodeURIComponent(namespaceId)}`,
				allowNotFound: true,
			});
		}
	});

	describe('Add Event', () => {
		it('stores a USER, an ASSISTANT and a SYSTEM event and returns each one', async () => {
			const sessionId = sessionFor('roles');

			const runs = [];
			for (const role of ['USER', 'ASSISTANT', 'SYSTEM']) {
				runs.push(await addEvent({ sessionId, role, text: `said as ${role}` }));
			}

			for (const [index, role] of ['USER', 'ASSISTANT', 'SYSTEM'].entries()) {
				expect(runs[index].response.status).toBe(200);
				expect(runs[index].items).toHaveLength(1);
				expect(runs[index].items[0]).toMatchObject({ role, actorId: userA, sessionId });
				expect(runs[index].items[0].eventId).toEqual(expect.any(String));
				expect(runs[index].items[0].createdAt).toEqual(expect.any(String));
			}
			const { session } = await getSession(sessionId);
			expect(session?.events.map((event) => event.role)).toEqual(['USER', 'ASSISTANT', 'SYSTEM']);
			expect(session?.events.map((event) => event.eventId)).toEqual(
				runs.map((run) => run.items[0].eventId),
			);
		});

		it.each([
			[
				'emoji, CJK, several lines, quotes and backslashes',
				'unicode',
				'Line one 🚀 日本語\nLine "two" with \'quotes\'\n\tBack\\slash \\n literal',
			],
			// 45 characters × 180: a little over 8 KB.
			[
				'a text of about 8 KB',
				'large',
				'The quick brown fox jumps over the lazy dog. '.repeat(180).trim(),
			],
		])('round-trips %s', async (_what, label, text) => {
			const sessionId = sessionFor(label);

			const added = await addEvent({ sessionId, text });

			expect(added.error).toBeUndefined();
			const { session } = await getSession(sessionId);
			expect(session?.events[0].content).toEqual([{ text }]);
		});

		it('trims leading and trailing whitespace from the text', async () => {
			const sessionId = sessionFor('trim');

			await addEvent({ sessionId, text: '  padded text \n' });

			const { session } = await getSession(sessionId);
			expect(session?.events[0].content[0].text).toBe('padded text');
		});

		it("rejects whitespace-only text with 'Text' is empty", async () => {
			const sessionId = sessionFor('blank-text');

			const { response, error } = await addEvent({ sessionId, text: '   \n ' });

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Add event',
				type: 'NodeOperationError',
				message: "'Text' is empty",
				itemIndex: 0,
			});
			expect(await client.getSession(sessionId)).toBeUndefined();
		});

		it("rejects an empty user id with 'User ID' is empty", async () => {
			const sessionId = sessionFor('no-user');

			const { error } = await addEvent({ sessionId, userId: '', text: 'hello' });

			expect(error).toMatchObject({
				nodeName: 'Add event',
				type: 'NodeOperationError',
				message: "'User ID' is empty",
			});
		});

		// Every form a user may type or pick for Created At, and the instant the
		// store keeps. A value without a zone is read in the n8n container's zone,
		// which is UTC. The expression case allows an hour, since `$now` runs
		// inside n8n and the expected value is computed here.
		it.each<{
			form: string;
			step?: string;
			createdAt?: string;
			storedAt: string;
			withinMs?: number;
		}>([
			{
				form: 'a full ISO timestamp with a zone',
				createdAt: '2024-03-15T10:00:00+02:00',
				storedAt: '2024-03-15T08:00:00.000Z',
			},
			{
				form: 'a timestamp without a zone, read as UTC',
				createdAt: '2024-03-15T10:00:00',
				storedAt: '2024-03-15T10:00:00.000Z',
			},
			{
				form: 'a date only, read as midnight UTC',
				createdAt: '2024-03-15',
				storedAt: '2024-03-15T00:00:00.000Z',
			},
			{
				form: 'an n8n date expression',
				step: 'Add event dated yesterday',
				storedAt: new Date(Date.now() - DAY).toISOString(),
				withinMs: HOUR,
			},
		])('accepts Created At as $form', async ({ step, createdAt, storedAt, withinMs }) => {
			const sessionId = sessionFor('created-at');

			const { items, error } = await runPair(workflow, step ?? 'Add event', {
				sessionId,
				userId: userA,
				text: 'dated',
				createdAt,
			});

			expect(error).toBeUndefined();
			const stored = Date.parse(items[0].createdAt as string);
			expect(Math.abs(stored - Date.parse(storedAt))).toBeLessThanOrEqual(withinMs ?? 0);
		});

		it("names 'Created At' in the error for a value that is not a date", async () => {
			const sessionId = sessionFor('created-at-garbage');

			const { response, items, error } = await addEvent({
				sessionId,
				text: 'dated',
				createdAt: 'yesterday',
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Add event',
				type: 'NodeOperationError',
				message: `'Created At' is not a date: "yesterday"`,
				description: 'Use an ISO 8601 timestamp, for example 2024-03-15T10:00:00Z',
				itemIndex: 0,
			});
			expect(await client.getSession(sessionId)).toBeUndefined();
		});

		it('binds the session to the namespace given', async () => {
			const sessionId = sessionFor('namespace');
			const namespaceId = await createNamespace('ns-bind');

			const { items, error } = await addEvent({ sessionId, text: 'in a namespace', namespaceId });

			expect(error).toBeUndefined();
			// The node returns the event; the binding shows only on the session.
			expect(items[0]).toMatchObject({ sessionId, actorId: userA });
			expect(items[0]).not.toHaveProperty('namespaceRef');
			const stored = await client.getSession(sessionId);
			expect(stored).toMatchObject({
				sessionId,
				ownerId: userA,
				namespaceRef: { namespaceId },
				namespaceScope: 'SHARED',
			});
			const fetched = await getSession(sessionId);
			expect(fetched.items[0].namespaceRef).toMatchObject({ namespaceId });
		});

		it('accepts a numeric session id from the input item', async () => {
			// A number cannot carry the run prefix; it is tracked so cleanup removes it.
			const sessionId = Number(`${Date.now()}${Math.floor(Math.random() * 900) + 100}`);
			client.track(String(sessionId), userA);

			const added = await addEvent({ sessionId, text: 'numeric id' });

			expect(added.error).toBeUndefined();
			expect(added.items[0].sessionId).toBe(String(sessionId));
			const { session, error } = await getSession(sessionId);
			expect(error).toBeUndefined();
			expect(session?.sessionId).toBe(String(sessionId));
			expect(session?.events).toHaveLength(1);
		});

		// The server allows only letters, digits and hyphens in a session ID. The
		// POST body carries the ID, so the server rejects it and the node shows
		// the server's rule as the message.
		it("shows the server's rule when it rejects a session id", async () => {
			// Not tracked: the server never creates it.
			const sessionId = `${runPrefix}-session-a b`;

			const { response, items, error } = await addEvent({ sessionId, text: 'rejected id' });

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Add event',
				type: 'NodeApiError',
				httpCode: '400',
				message:
					'SessionID: must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-).',
				description: 'Invalid Request (HTTP 400)',
			});
		});

		it('accepts an event from a second user and keeps the first user as owner', async () => {
			const sessionId = sessionFor('two-users');
			client.track(sessionId, userB);

			await addEvent({ sessionId, userId: userA, text: 'from A' });
			const fromB = await addEvent({ sessionId, userId: userB, text: 'from B' });

			expect(fromB.error).toBeUndefined();
			expect(fromB.items[0]).toMatchObject({ actorId: userB, sessionId });
			const { session } = await getSession(sessionId);
			expect(session?.ownerId).toBe(userA);
			expect(session?.events.map((event) => event.actorId)).toEqual([userA, userB]);
		});
	});

	describe('Get', () => {
		it('returns the owner and the events in the order they were added', async () => {
			const sessionId = sessionFor('get');
			const first = await addEvent({ sessionId, text: 'first' });
			const second = await addEvent({ sessionId, role: 'ASSISTANT', text: 'second' });

			const { response, items, session } = await getSession(sessionId);

			expect(response.status).toBe(200);
			expect(items).toHaveLength(1);
			expect(session).toMatchObject({ sessionId, ownerId: userA });
			expect(session?.events.map((event: Event) => [event.eventId, event.content[0].text])).toEqual(
				[
					[first.items[0].eventId, 'first'],
					[second.items[0].eventId, 'second'],
				],
			);
		});

		it('returns the same events with Include Summarized Events on a session without a summary', async () => {
			const sessionId = sessionFor('get-summarized');
			await addEvent({ sessionId, text: 'only event' });

			const plain = await getSession(sessionId);
			const withSummarized = await runPair(workflow, 'Get session with summarized events', {
				sessionId,
			});

			expect(withSummarized.error).toBeUndefined();
			expect(withSummarized.items[0]).toMatchObject({ sessionId, ownerId: userA });
			expect(withSummarized.items[0].events).toEqual(plain.session?.events);
			expect(withSummarized.items[0].summary).toBeUndefined();
		});

		it("surfaces the API's not-found for a session that does not exist", async () => {
			const sessionId = `${runPrefix}-session-never-created`;

			const { response, error } = await getSession(sessionId);

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Get session',
				type: 'NodeApiError',
				httpCode: '404',
				message: 'The requested session was not found',
				description: 'Session Not Found (HTTP 404)',
			});
			expect(error?.context?.data).toMatchObject({ ...NOT_FOUND_BODY, title: 'Session Not Found' });
		});
	});

	describe('Get Many', () => {
		const listUserA = `${runPrefix}-session-list-a`;
		const listUserB = `${runPrefix}-session-list-b`;
		const sessionsOfA = ['list-a-1', 'list-a-2', 'list-a-3'].map(
			(label) => `${runPrefix}-${label}`,
		);
		const sessionOfB = `${runPrefix}-list-b-1`;

		beforeAll(async () => {
			for (const sessionId of sessionsOfA) {
				client.track(sessionId, listUserA);
				await addEvent({ sessionId, userId: listUserA, text: 'seed' });
			}
			client.track(sessionOfB, listUserB);
			await addEvent({ sessionId: sessionOfB, userId: listUserB, text: 'seed' });
		});

		it('returns every session of the filtered user with Return All', async () => {
			const { response, items, error } = await runPair(workflow, 'Get all sessions', {
				userId: listUserA,
			});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items.map((item) => item.sessionId).sort()).toEqual([...sessionsOfA].sort());
		});

		it('returns two items of shape { sessionId } with a limit of 2', async () => {
			const { items, error } = await runPair(workflow, 'Get many sessions', {
				userId: listUserA,
				limit: 2,
			});

			expect(error).toBeUndefined();
			expect(items).toHaveLength(2);
			for (const item of items) {
				expect(Object.keys(item)).toEqual(['sessionId']);
				expect(sessionsOfA).toContain(item.sessionId);
			}
		});

		it('returns only the sessions of the filtered user with the default limit', async () => {
			const { items, error } = await runPair(workflow, 'Get many sessions', {
				userId: listUserA,
			});

			expect(error).toBeUndefined();
			expect(items.map((item) => item.sessionId).sort()).toEqual([...sessionsOfA].sort());
			expect(items.map((item) => item.sessionId)).not.toContain(sessionOfB);
		});

		// The server needs a filter or `includeAll=true`; the node sends the
		// latter when the User ID filter is empty.
		it('lists sessions without a filter', async () => {
			const { response, items, error } = await runPair(workflow, 'Get all sessions', {});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items.map((item) => item.sessionId)).toEqual(
				expect.arrayContaining([...sessionsOfA, sessionOfB]),
			);
		});
	});

	describe('Delete', () => {
		it('deletes a session, after which Get reports not found', async () => {
			const sessionId = sessionFor('delete');
			await addEvent({ sessionId, text: 'to be deleted' });

			const { response, items } = await runPair(workflow, 'Delete session', { sessionId });

			expect(response.status).toBe(200);
			expect(items).toEqual([{ deleted: true, sessionId }]);
			const { error } = await getSession(sessionId);
			expect(error).toMatchObject({ httpCode: '404' });
			expect(error?.context?.data).toMatchObject(NOT_FOUND_BODY);
		});

		// The server answers 204 for a session that is already gone, so the node
		// cannot tell and reports `deleted: true` a second time.
		it('reports deleted: true again for a session that is already gone', async () => {
			const sessionId = sessionFor('delete-twice');
			await addEvent({ sessionId, text: 'to be deleted twice' });
			await runPair(workflow, 'Delete session', { sessionId });

			const { response, items, error } = await runPair(workflow, 'Delete session', {
				sessionId,
			});

			expect(response.status).toBe(200);
			expect(error).toBeUndefined();
			expect(items).toEqual([{ deleted: true, sessionId }]);
		});
	});

	describe('Delete Event', () => {
		it('deletes the first of two events and keeps the second', async () => {
			const sessionId = sessionFor('delete-event');
			const first = await addEvent({ sessionId, text: 'first' });
			const second = await addEvent({ sessionId, text: 'second' });
			const eventId = first.items[0].eventId as string;

			const { response, items } = await runPair(workflow, 'Delete event', {
				sessionId,
				eventId,
			});

			expect(response.status).toBe(200);
			expect(items).toEqual([{ deleted: true, sessionId, eventId }]);
			const { session } = await getSession(sessionId);
			expect(session?.events.map((event) => [event.eventId, event.content[0].text])).toEqual([
				[second.items[0].eventId, 'second'],
			]);
		});

		it("surfaces the API's not-found for a well-formed event id that does not exist", async () => {
			const sessionId = sessionFor('delete-event-unknown');
			await addEvent({ sessionId, text: 'kept' });

			const { response, items, error } = await runPair(workflow, 'Delete event', {
				sessionId,
				eventId: WELL_FORMED_UNKNOWN_EVENT_ID,
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Delete event',
				type: 'NodeApiError',
				httpCode: '404',
				message: 'The requested event was not found',
				description: 'Event Not Found (HTTP 404)',
			});
			expect(error?.context?.data).toEqual({
				...NOT_FOUND_BODY,
				title: 'Event Not Found',
				detail: 'The requested event was not found',
			});
			const { session } = await getSession(sessionId);
			expect(session?.events).toHaveLength(1);
		});

		it("shows the server's rule for an event id of the wrong length", async () => {
			const sessionId = sessionFor('delete-event-short');
			await addEvent({ sessionId, text: 'kept' });

			const { response, items, error } = await runPair(workflow, 'Delete event', {
				sessionId,
				eventId: 'abc',
			});

			expect(response.status).toBe(500);
			expect(items).toEqual([]);
			expect(error).toMatchObject({
				nodeName: 'Delete event',
				type: 'NodeApiError',
				httpCode: '400',
				message: 'EventID: the length must be exactly 32.',
				description: 'Invalid Request (HTTP 400)',
			});
		});
	});
});
