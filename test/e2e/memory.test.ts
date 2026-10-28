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

/**
 * Runs the node inside a real n8n (see docker-compose.yml), against the hosted
 * Agent Memory service, with the OpenAI API replaced by a stub.
 */
describe.skipIf(!agentMemoryConfig)(`Redis Agent Memory inside n8n ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	let counter = 0;

	function newSession(label: string) {
		counter += 1;
		const sessionId = `${runPrefix}-e2e-${label}-${counter}`;
		return { sessionId, userId: `${runPrefix}-user-${counter}` };
	}

	/** The chat workflow derives the user ID from the session ID. */
	function newChatSession(label: string) {
		const { sessionId } = newSession(label);
		client.track(sessionId, `user-${sessionId}`);
		return sessionId;
	}

	async function storedTexts(sessionId: string): Promise<Array<[string, string]>> {
		const session = await client.getSession(sessionId);
		return (session?.events ?? []).map((e) => [e.role, e.content.map((c) => c.text).join('')]);
	}

	afterAll(async () => {
		await client.cleanup();
	});

	describe('Chat Memory Manager, no model', () => {
		async function insert(session: { sessionId: string; userId: string }, user: string, ai: string) {
			client.track(session.sessionId, session.userId);
			await postJson('/webhook/e2e-memory-insert', { ...session, user, ai });
		}

		async function load(session: { sessionId: string; userId: string }) {
			const [result] = await postJson<Array<{ messages: SerializedMessage[] }>>(
				'/webhook/e2e-memory-load',
				session,
			).then((r) => (Array.isArray(r) ? r : [r]));
			return result.messages;
		}

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

		it('clears a session', async () => {
			const session = newSession('manager-clear');
			await insert(session, 'Forget me', 'Forgotten');

			await postJson('/webhook/e2e-memory-clear', session);

			expect(await load(session)).toEqual([]);
			expect(await storedTexts(session.sessionId)).toEqual([]);
		});
	});

	describe('AI Agent with the Chat Trigger', () => {
		const sessionId = newChatSession('chat');

		beforeEach(async () => {
			await resetStub();
		});

		function lastRequestFor(requests: StubRequest[], chatInput: string): StubRequest {
			const request = requests.find((r) =>
				r.messages.some((m) => m.role === 'user' && stubMessageText(m) === chatInput),
			);
			if (!request) throw new Error(`The model never received "${chatInput}"`);
			return request;
		}

		it('answers the first turn and stores it', async () => {
			expect(await sendChatMessage(sessionId, 'My name is Ada.')).toBe('Echo: My name is Ada.');

			expect(await storedTexts(sessionId)).toEqual([
				['USER', 'My name is Ada.'],
				['ASSISTANT', 'Echo: My name is Ada.'],
			]);
		});

		it('sends the earlier turn to the model on the next turn', async () => {
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
			const toolSession = newChatSession('tool');

			expect(await sendChatMessage(toolSession, 'calculate 2+2')).toBe('The answer is 4.');

			const requests = await stubRequests();
			expect(requests.some((r) => r.messages.some((m) => m.role === 'tool'))).toBe(true);
			expect(await storedTexts(toolSession)).toEqual([
				['USER', 'calculate 2+2'],
				['ASSISTANT', 'The answer is 4.'],
			]);
		});

		it('returns the history to the chat widget without system messages', async () => {
			const messages = await loadPreviousSession(sessionId);

			expect(messages.map((m) => messageType(m))).not.toContain('SystemMessage');
			expect(messages.map((m) => [messageType(m), messageText(m)])).toEqual([
				['HumanMessage', 'My name is Ada.'],
				['AIMessage', 'Echo: My name is Ada.'],
				['HumanMessage', 'What is my name?'],
				['AIMessage', 'Echo: What is my name?'],
			]);
		});

		it('keeps the history across an n8n restart', async () => {
			await restartN8n();

			const messages = await loadPreviousSession(sessionId);
			expect(messages).toHaveLength(4);

			await sendChatMessage(sessionId, 'Still there?');
			const request = lastRequestFor(await stubRequests(), 'Still there?');
			expect(request.messages.map((m) => stubMessageText(m))).toContain('My name is Ada.');
		});
	});
});
