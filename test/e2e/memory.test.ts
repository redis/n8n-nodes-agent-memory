import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SUMMARY_VIEW_HEADING } from '../../nodes/RedisAgentChatMemory/memory';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason, summaryViewTests } from '../support/env';
import {
	callWebhookAndWait,
	CHAT_AGENT_WORKFLOW,
	CHAT_WEBHOOK_PATH,
	executionError,
	loadPreviousSession,
	MEMORY_MANAGER_WORKFLOW,
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

/** The first line of the message that carries recalled long-term memories. */
const RECALL_HEADER = 'Long-term memories about the user, from earlier conversations:';

/** The chat URL of fixtures/workflows/chat-agent-recall.json, the agent with recall on. */
const RECALL_CHAT_WEBHOOK_PATH = '6f1d2c9e-0c4b-4f53-9a51-1f7d1b2a0011/chat';

/** The first line of the message that carries a summary view's briefing. */

/**
 * The chat URL of fixtures/workflows/chat-agent-summary-view.json, the agent
 * whose memory reads the summary view named by `summaryViewId` in the message.
 */
const SUMMARY_VIEW_CHAT_WEBHOOK_PATH = '6f1d2c9e-0c4b-4f53-9a51-1f7d1b2a0012/chat';

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

	/** The messages between the Agent's system message and the current user message. */
	function historyOf(request: StubRequest): Array<[string, string]> {
		const messages = request.messages.map((m): [string, string] => [m.role, stubMessageText(m)]);
		const start = messages[0]?.[0] === 'system' ? 1 : 0;
		return messages.slice(start, -1);
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

		// This session has no server summary, so it cannot show that the summary
		// stays out of the widget; the contract test "server summary" and the
		// recorded-session unit test cover that. This checks the plain path.
		it('returns the seeded history to the chat widget', async () => {
			const session = newChatSession('widget');
			await insert(session, 'My name is Ada.', 'Echo: My name is Ada.');
			await insert(session, 'What is my name?', 'Echo: What is my name?');

			const messages = await loadPreviousSession(session.sessionId);

			expect(messages.map((m) => [messageType(m), messageText(m)])).toEqual([
				['HumanMessage', 'My name is Ada.'],
				['AIMessage', 'Echo: My name is Ada.'],
				['HumanMessage', 'What is my name?'],
				['AIMessage', 'Echo: What is my name?'],
			]);
		});
	});

	// Each test here pins a fix to a defect the first end-to-end run of the
	// node surfaced (docs/testing.md, "How the design was verified"). The chat agent fixture
	// reads the window from the chat body and carries the Search tool next to
	// the Calculator. Recall has a chat workflow of its own: the server
	// extracts long-term memories from sessions in the background, so an
	// agent with recall on could add a recall message to the history that the
	// tests above compare in full.
	describe('summary view option', () => {
		/** A view grouped by user that computes only on Refresh, created straight on the store. */
		async function createView(label: string): Promise<string> {
			return await client.createSummaryView(`${runPrefix}-e2e-${label}`);
		}

		async function chat(session: Session, summaryViewId: string, chatInput: string) {
			const { output } = await postJson<{ output: string }>(
				`/webhook/${SUMMARY_VIEW_CHAT_WEBHOOK_PATH}`,
				{ action: 'sendMessage', sessionId: session.sessionId, chatInput, summaryViewId },
			);
			return output;
		}

		it('adds nothing to the history while the view has no summary for the user', async () => {
			const session = newChatSession('view-cold');
			const viewId = await createView('cold');

			expect(await chat(session, viewId, 'Hello there')).toBe('Echo: Hello there');

			expect(historyOf(lastRequestFor(await stubRequests(), 'Hello there'))).toEqual([]);
			expect(await storedTexts(session.sessionId)).toEqual([
				['USER', 'Hello there'],
				['ASSISTANT', 'Echo: Hello there'],
			]);
		});

		// Opt-in (AGENT_MEMORY_SUMMARY_VIEW_TESTS=true): the server computes the
		// summary with a model.
		describe.skipIf(!summaryViewTests)('computed result', () => {
			it("gives the model the view's summary of the user once it is READY", async () => {
				const session = newChatSession('view-ready');
				const viewId = await createView('ready');
				await client.request({
					method: 'POST',
					path: '/memories',
					body: {
						memories: [
							{
								memoryId: `${session.sessionId}-sv-1`,
								ownerId: session.userId,
								text: 'The user is vegetarian',
							},
							{
								memoryId: `${session.sessionId}-sv-2`,
								ownerId: session.userId,
								text: 'The user lives in Sofia',
							},
						],
					},
				});
				await client.request({
					method: 'POST',
					path: `/summary-views/${viewId}/refresh`,
					body: { target: 'PARTITION', scope: { ownerId: session.userId } },
				});
				const { status } = await client.waitForSummaryResult(
					viewId,
					{ ownerId: session.userId },
					300_000,
				);
				expect(status).toBe('READY');

				expect(await chat(session, viewId, 'What do you know about me?')).toBe(
					'Echo: What do you know about me?',
				);

				const history = historyOf(
					lastRequestFor(await stubRequests(), 'What do you know about me?'),
				);
				expect(history).toHaveLength(1);
				expect(history[0][0]).toBe('user');
				expect(history[0][1].startsWith(`${SUMMARY_VIEW_HEADING}\n`)).toBe(true);
				expect(history[0][1].length).toBeGreaterThan(SUMMARY_VIEW_HEADING.length + 1);
				// The briefing is shown to the model, not written back to the session.
				expect(await storedTexts(session.sessionId)).toEqual([
					['USER', 'What do you know about me?'],
					['ASSISTANT', 'Echo: What do you know about me?'],
				]);
			}, 360_000);
		});
	});

	describe('fixes verified inside n8n', () => {
		// Recall ran only with a Recall Query typed under Options; the switch
		// alone did nothing. The query now defaults to the chat input.
		it('recalls a long-term memory with only the recall switch on', async () => {
			const session = newChatSession('recall');
			await client.request({
				method: 'POST',
				path: '/memories',
				body: {
					memories: [
						{
							memoryId: `${session.sessionId}-m1`,
							ownerId: session.userId,
							text: 'The user is vegetarian',
						},
					],
				},
			});

			const { output } = await postJson<{ output: string }>(
				`/webhook/${RECALL_CHAT_WEBHOOK_PATH}`,
				{ action: 'sendMessage', sessionId: session.sessionId, chatInput: 'What do I eat?' },
			);

			expect(output).toBe('Echo: What do I eat?');
			expect(historyOf(lastRequestFor(await stubRequests(), 'What do I eat?'))).toEqual([
				['user', `${RECALL_HEADER}\n- The user is vegetarian`],
			]);
			// The recalled memory is shown to the model, not written back to the session.
			expect(await storedTexts(session.sessionId)).toEqual([
				['USER', 'What do I eat?'],
				['ASSISTANT', 'Echo: What do I eat?'],
			]);
		});

		// n8n shows only the message of a sub-node error, so the hint in the
		// description was lost; the message carries it now.
		it('shows the hint when the Session ID is empty', async () => {
			const { response, execution } = await callWebhookAndWait(
				CHAT_AGENT_WORKFLOW,
				CHAT_WEBHOOK_PATH,
				{ action: 'sendMessage', sessionId: '', chatInput: 'hello' },
			);

			expect(response.status).toBe(500);
			const error = executionError(execution);
			expect(error?.nodeName).toBe('Redis Agent Chat Memory');
			expect(`${error?.message} ${error?.description}`).toContain(
				'Set a session ID, for example from the chat trigger output',
			);
		});

		// A window that resolved to something other than a number turned the
		// window off without a word. An empty value means the default.
		it('fails the run when the window resolves to "abc"', async () => {
			const session = newChatSession('window-abc');

			const { response, execution } = await callWebhookAndWait(
				CHAT_AGENT_WORKFLOW,
				CHAT_WEBHOOK_PATH,
				{
					action: 'sendMessage',
					sessionId: session.sessionId,
					chatInput: 'hello',
					windowSize: 'abc',
				},
			);

			expect(response.status).toBe(500);
			const error = executionError(execution);
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
			});
			expect(`${error?.message} ${error?.description}`).toContain(
				"'Context Window Length' must be a whole number of 1 or more",
			);
			expect(await client.getSession(session.sessionId)).toBeUndefined();
		});

		it('sends every turn when the window resolves to ""', async () => {
			const session = newChatSession('window-empty');
			await insert(session, 'question 1', 'answer 1');
			await insert(session, 'question 2', 'answer 2');
			await insert(session, 'question 3', 'answer 3');

			await postJson(`/webhook/${CHAT_WEBHOOK_PATH}`, {
				action: 'sendMessage',
				sessionId: session.sessionId,
				chatInput: 'question 4',
				windowSize: '',
			});

			expect(historyOf(lastRequestFor(await stubRequests(), 'question 4'))).toEqual([
				['user', 'question 1'],
				['assistant', 'answer 1'],
				['user', 'question 2'],
				['assistant', 'answer 2'],
				['user', 'question 3'],
				['assistant', 'answer 3'],
			]);
		});

		// The owner check threw a plain Error, which n8n showed on the Memory
		// Manager instead of on the memory node.
		it('shows the owner mismatch on the memory sub-node', async () => {
			const session = newSession('owner');
			const intruder = `${runPrefix}-intruder-${counter}`;
			client.track(session.sessionId, intruder);
			await insert(session, 'question 1', 'answer 1');

			const { response, execution } = await callWebhookAndWait(
				MEMORY_MANAGER_WORKFLOW,
				'e2e-memory-insert-verified',
				{ sessionId: session.sessionId, userId: intruder, user: 'question 2', ai: 'answer 2' },
			);

			expect(response.status).toBe(500);
			expect(executionError(execution)).toMatchObject({
				nodeName: 'Redis Agent Chat Memory (verify owner)',
				type: 'NodeOperationError',
				message:
					`Session "${session.sessionId}" belongs to user "${session.userId}", not to the configured User ID "${intruder}". ` +
					'Use a session ID derived from the user, or turn off "Verify Session Owner" for shared sessions.',
			});
			expect(await storedTexts(session.sessionId)).toHaveLength(2);
		});

		// As a tool, a search with no hits gave the model the JSON string "",
		// which it could not read; it now gets one item that says so.
		it('tells the model that no memory matched when the Search tool finds nothing', async () => {
			const { sessionId } = newChatSession('tool-search');

			const output = await sendChatMessage(
				sessionId,
				'use tool Search_memories with {"query":"anything"}',
			);

			const toolMessage = (await stubRequests())
				.flatMap((r) => r.messages)
				.find((m) => m.role === 'tool');
			if (!toolMessage) throw new Error('The model received no tool result');
			const toolResult = stubMessageText(toolMessage);
			expect(JSON.parse(toolResult)).toEqual([{ message: 'No memories matched' }]);
			expect(output).toBe(`The answer is ${toolResult}.`);
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
