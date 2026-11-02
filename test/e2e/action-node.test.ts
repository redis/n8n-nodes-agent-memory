import { afterAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../support/env';
import { N8N_URL, postJson } from './harness';

interface StoredEvent {
	eventId: string;
	actorId: string;
	content: Array<{ text: string }>;
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

describe.skipIf(!agentMemoryConfig)(
	`Redis Agent Memory action node inside n8n ${skipReason}`,
	() => {
		const client = new AgentMemoryTestClient(agentMemoryConfig!);

		afterAll(async () => {
			await client.cleanup();
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

			const [session] = await callAction<{ ownerId: string; events: StoredEvent[] }>(
				'e2e-action-session-get',
				{ sessionId },
			);
			expect(session.ownerId).toBe(userId);
			expect(session.events.map((e) => e.content[0].text)).toEqual(['First', 'Second']);

			const [deleted] = await callAction<{ deleted: boolean; eventId: string }>(
				'e2e-action-event-delete',
				{ sessionId, eventId: session.events[0].eventId },
			);
			expect(deleted).toEqual({ deleted: true, sessionId, eventId: session.events[0].eventId });

			const [after] = await callAction<{ events: StoredEvent[] }>('e2e-action-session-get', {
				sessionId,
			});
			expect(after.events.map((e) => e.content[0].text)).toEqual(['Second']);
		});

		it('creates a memory, finds it for its user only, then deletes it', async () => {
			const userId = `${runPrefix}-action-user-2`;
			const otherUserId = `${runPrefix}-action-user-3`;
			client.track(`${runPrefix}-unused`, userId);

			const [created] = await callAction<{ id: string; text: string; ownerId: string }>(
				'e2e-action-memory-create',
				{ userId, text: 'The user is allergic to peanuts' },
			);
			expect(created).toMatchObject({ text: 'The user is allergic to peanuts', ownerId: userId });
			expect(created.id).toMatch(/^n8n-/);

			const found = await callAction<{ id: string; text: string }>('e2e-action-memory-search', {
				userId,
				query: 'Does the user have any allergies?',
			});
			expect(found.map((m) => m.id)).toContain(created.id);

			const foundForOther = await callAction<{ id: string }>('e2e-action-memory-search', {
				userId: otherUserId,
				query: 'Does the user have any allergies?',
			});
			expect(foundForOther).toEqual([]);

			const [deleted] = await callAction<{ deleted: boolean; id: string }>(
				'e2e-action-memory-delete',
				{ memoryId: created.id },
			);
			expect(deleted).toEqual({ deleted: true, id: created.id });
			const afterDelete = await callAction<{ id: string }>('e2e-action-memory-search', {
				userId,
				query: 'Does the user have any allergies?',
			});
			expect(afterDelete.map((m) => m.id)).not.toContain(created.id);
		});
	},
);
