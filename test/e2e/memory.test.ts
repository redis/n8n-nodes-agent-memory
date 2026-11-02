import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../support/env';
import {
	loadPreviousSession,
	messageText,
	messageType,
	postJson,
	resetStub,
	restartN8n,
	sendChatMessage,
	stubMessageText,
	stubRequests,
	type SerializedMessage,
	type StubRequest,
} from './harness';

interface Session {
	sessionId: string;
	userId: string;
}

/**
 * Runs the node inside a real n8n (see docker-compose.yml), against the hosted
 * Agent Memory service, with the OpenAI API replaced by a stub.
 *
 * Every test seeds its own session, through the Memory Manager's insert
 * webhook where it needs history, so each one can run alone with `-t` and a
 * failure points at the test that owns the data.
 */
describe.skipIf(!agentMemoryConfig)(`Redis Agent Memory inside n8n ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	let counter = 0;

	function newSession(label: string): Session {
		counter += 1;
		const session = {
			sessionId: `${runPrefix}-e2e-${label}-${counter}`,
			userId: `${runPrefix}-user-${counter}`,
		};
		client.track(session.sessionId, session.userId);
		return session;
	}

	/** The chat workflow derives the user ID from the session ID; seeded turns must match. */
	function newChatSession(label: string): Session {
		counter += 1;
		const sessionId = `${runPrefix}-e2e-${label}-${counter}`;
		const session = { sessionId, userId: `user-${sessionId}` };
		client.track(session.sessionId, session.userId);
		return session;
	}

	/** Writes one user/assistant turn through the node, with no model involved. */
	async function insert(session: Session, user: string, ai: string) {
		await postJson('/webhook/e2e-memory-insert', { ...session, user, ai });
	}

	async function load(session: Session) {
		const [result] = await postJson<Array<{ messages: SerializedMessage[] }>>(
			'/webhook/e2e-memory-load',
			session,
		).then((r) => (Array.isArray(r) ? r : [r]));
		return result.messages;
	}

	async function storedTexts(sessionId: string): Promise<Array<[string, string]>> {
		const session = await client.getSession(sessionId);
		return (session?.events ?? []).map((e) => [e.role, e.content.map((c) => c.text).join('')]);
	}

	function lastRequestFor(requests: StubRequest[], chatInput: string): StubRequest {
		const request = requests.find((r) =>
			r.messages.some((m) => m.role === 'user' && stubMessageText(m) === chatInput),
		);
		if (!request) throw new Error(`The model never received "${chatInput}"`);
		return request;
	}

	beforeEach(async () => {
		await resetStub();
	});

	afterAll(async () => {
		await client.cleanup();
	});

	describe('Chat Memory Manager, no model', () => {
		it('inserts messages through the node and loads them back', async () => {
			const session = newSession('manager');

			await insert(session, 'My favourite colour is teal.', 'Noted: teal.');
			const messages = await load(session);

			expect(messages.map((m) => [messageType(m), messageText(m)])).toEqual([
				['HumanMessage', 'My favourite colour is teal.'],
				['AIMessage', 'Noted: teal.'],
			]);
			expect(await storedTexts(session.sessionId)).toEqual([
				['USER', 'My favourite colour is teal.'],
				['ASSISTANT', 'Noted: teal.'],
			]);
			const stored = await client.getSession(session.sessionId);
			expect(stored?.events.every((e) => e.actorId === session.userId)).toBe(true);
		});

		it('keeps sessions apart', async () => {
			const a = newSession('manager-a');
			const b = newSession('manager-b');

			await insert(a, 'Only in A', 'Only in A, too');

			expect(await load(b)).toEqual([]);
		});

		it('replaces the session with Insert > Override All', async () => {
			const session = newSession('manager-override');
			await insert(session, 'Old question', 'Old answer');

			await postJson('/webhook/e2e-memory-override', {
				...session,
				user: 'New question',
				ai: 'New answer',
			});

			expect((await load(session)).map((m) => messageText(m))).toEqual([
				'New question',
				'New answer',
			]);
			expect(await storedTexts(session.sessionId)).toEqual([
				['USER', 'New question'],
				['ASSISTANT', 'New answer'],
			]);
		});

		it('clears a session', async () => {
			const session = newSession('manager-clear');
			await insert(session, 'Forget me', 'Forgotten');

			await postJson('/webhook/e2e-memory-clear', session);

			expect(await load(session)).toEqual([]);
			expect(await storedTexts(session.sessionId)).toEqual([]);
		});
	});

	describe('AI Agent with the Chat Trigger', () => {
		it('stores a turn and sends it to the model on the next turn', async () => {
			const { sessionId } = newChatSession('chat');

			expect(await sendChatMessage(sessionId, 'My name is Ada.')).toBe('Echo: My name is Ada.');
			expect(await storedTexts(sessionId)).toEqual([
				['USER', 'My name is Ada.'],
				['ASSISTANT', 'Echo: My name is Ada.'],
			]);

			await sendChatMessage(sessionId, 'What is my name?');

			const request = lastRequestFor(await stubRequests(), 'What is my name?');
			const history = request.messages.map((m) => [m.role, stubMessageText(m)]);
			expect(history).toContainEqual(['user', 'My name is Ada.']);
			expect(history).toContainEqual(['assistant', 'Echo: My name is Ada.']);
		});

		// On n8n 2.42, the assistant message that requests the tool reaches memory
		// with no text, so this test passes with or without the node's tool-call
		// filter. The unit and contract tests cover the filter itself; this one
		// checks what users get.
		it('stores only the question and the answer when a tool runs', async () => {
			const { sessionId } = newChatSession('tool');

			expect(await sendChatMessage(sessionId, 'calculate 2+2')).toBe('The answer is 4.');

			const requests = await stubRequests();
			expect(requests.some((r) => r.messages.some((m) => m.role === 'tool'))).toBe(true);
			expect(await storedTexts(sessionId)).toEqual([
				['USER', 'calculate 2+2'],
				['ASSISTANT', 'The answer is 4.'],
			]);
		});

		it('returns the history to the chat widget without system messages', async () => {
			const session = newChatSession('widget');
			await insert(session, 'My name is Ada.', 'Echo: My name is Ada.');
			await insert(session, 'What is my name?', 'Echo: What is my name?');

			const messages = await loadPreviousSession(session.sessionId);

			expect(messages.map((m) => messageType(m))).not.toContain('SystemMessage');
			expect(messages.map((m) => [messageType(m), messageText(m)])).toEqual([
				['HumanMessage', 'My name is Ada.'],
				['AIMessage', 'Echo: My name is Ada.'],
				['HumanMessage', 'What is my name?'],
				['AIMessage', 'Echo: What is my name?'],
			]);
		});
	});

	// Last, and on its own: restarting the container is slow and would disturb
	// any test running alongside it.
	describe('n8n restart', () => {
		it('keeps the history across an n8n restart', async () => {
			const session = newChatSession('restart');
			await insert(session, 'My name is Ada.', 'Echo: My name is Ada.');

			await restartN8n();

			expect((await loadPreviousSession(session.sessionId)).map((m) => messageText(m))).toEqual([
				'My name is Ada.',
				'Echo: My name is Ada.',
			]);

			await sendChatMessage(session.sessionId, 'Still there?');
			const request = lastRequestFor(await stubRequests(), 'Still there?');
			expect(request.messages.map((m) => stubMessageText(m))).toContain('My name is Ada.');
		});
	});
});
