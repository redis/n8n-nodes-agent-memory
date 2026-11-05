import { afterAll, describe, expect, it } from 'vitest';
import { sleep } from 'n8n-workflow';
import {
	AgentMemoryChatHistory,
	SUMMARY_MESSAGE_ID,
	SummaryAwareWindowedChatMemory,
} from '../../nodes/RedisAgentMemoryChatMemory/memory';
import { NOT_FOUND_ERROR_TYPE } from '../../nodes/shared/agentMemoryRequest';
import { AgentMemoryTestClient } from '../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason, summaryTests } from '../support/env';

/**
 * Runs the node's chat history against the hosted Agent Memory service, with
 * no n8n involved. Catches changes in the REST contract.
 */
describe.skipIf(!agentMemoryConfig)(`Agent Memory session contract ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	let counter = 0;

	function newSession() {
		counter += 1;
		const sessionId = `${runPrefix}-contract-${counter}`;
		const actorId = `${runPrefix}-user-${counter}`;
		client.track(sessionId, actorId);
		const history = new AgentMemoryChatHistory({ sessionId, actorId, request: client.request });
		return { sessionId, actorId, history };
	}

	afterAll(async () => {
		await client.cleanup();
	});

	it('returns no messages for a session that does not exist', async () => {
		const { history } = newSession();

		expect(await history.getMessages()).toEqual([]);
	});

	it('stores messages as session events and reads them back in order', async () => {
		const { sessionId, actorId, history } = newSession();

		await history.addMessages([
			{ role: 'user', content: [{ type: 'text', text: 'My favourite colour is teal.' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'Noted: teal.' }] },
		]);

		const messages = await history.getMessages();
		expect(messages.map((m) => [m.role, m.content])).toEqual([
			['user', [{ type: 'text', text: 'My favourite colour is teal.' }]],
			['assistant', [{ type: 'text', text: 'Noted: teal.' }]],
		]);

		const stored = await client.getSession(sessionId);
		expect(stored?.events.map((e) => [e.role, e.actorId])).toEqual([
			['USER', actorId],
			['ASSISTANT', actorId],
		]);
	});

	it('does not store tool calls or tool results', async () => {
		const { sessionId, history } = newSession();

		await history.addMessages([
			{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Calling calculator with input: {"input":"2+2"}' },
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'calculator',
						input: '{"input":"2+2"}',
					},
				],
			},
			{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: '4' }] },
			{ role: 'assistant', content: [{ type: 'text', text: '2+2 is 4.' }] },
		]);

		const stored = await client.getSession(sessionId);
		expect(stored?.events.map((e) => e.content.map((c) => c.text).join(''))).toEqual([
			'What is 2+2?',
			'2+2 is 4.',
		]);
	});

	it('keeps sessions apart', async () => {
		const a = newSession();
		const b = newSession();

		await a.history.addMessage({ role: 'user', content: [{ type: 'text', text: 'Only in A' }] });

		expect(await b.history.getMessages()).toEqual([]);
	});

	it('clears a session, and clearing twice is harmless', async () => {
		const { history } = newSession();
		await history.addMessage({ role: 'user', content: [{ type: 'text', text: 'Forget me' }] });

		await history.clear();
		await history.clear();

		expect(await history.getMessages()).toEqual([]);
	});

	it("answers a missing session with the API's not-found body, the one the node swallows", async () => {
		const { sessionId } = newSession();

		const { status, body } = await client.probe(
			'GET',
			`/sessions/${encodeURIComponent(sessionId)}`,
		);

		expect(status).toBe(404);
		expect(JSON.parse(body)).toMatchObject({
			type: NOT_FOUND_ERROR_TYPE,
			title: 'Session Not Found',
			status: 404,
		});
	});

	it('deletes a missing session with 204, not 404', async () => {
		const { sessionId } = newSession();

		const { status } = await client.probe('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);

		expect(status).toBe(204);
	});

	it('windows the turns the model receives', async () => {
		const { history } = newSession();
		for (let i = 0; i < 3; i++) {
			await history.addMessages([
				{ role: 'user', content: [{ type: 'text', text: `question ${i}` }] },
				{ role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
			]);
		}
		const memory = new SummaryAwareWindowedChatMemory(history, {
			windowSize: 1,
			includeSummary: true,
		});

		const messages = await memory.loadMessages();

		const turns = messages.filter((m) => m.role !== 'system');
		expect(turns.map((m) => m.content)).toEqual([
			[{ type: 'text', text: 'question 2' }],
			[{ type: 'text', text: 'answer 2' }],
		]);
	});

	describe('session ownership', () => {
		// The node's "Verify Session Owner" option rests on these two facts.
		it('sets the owner from the first event and accepts events from other actors', async () => {
			const a = newSession();
			const bActorId = `${a.actorId}-b`;
			client.track(a.sessionId, bActorId);
			const asB = new AgentMemoryChatHistory({
				sessionId: a.sessionId,
				actorId: bActorId,
				request: client.request,
			});

			await a.history.addMessage({
				role: 'user',
				content: [{ type: 'text', text: 'Hello from A' }],
			});
			await asB.addMessage({ role: 'user', content: [{ type: 'text', text: 'Hello from B' }] });

			const stored = await client.getSession(a.sessionId);
			expect(stored?.ownerId).toBe(a.actorId);
			expect(stored?.events.map((e) => e.actorId)).toEqual([a.actorId, bActorId]);
		});

		it("with Verify Session Owner, refuses another user's session on read and on write", async () => {
			const a = newSession();
			await a.history.addMessage({
				role: 'user',
				content: [{ type: 'text', text: 'Hello from A' }],
			});
			const asB = new AgentMemoryChatHistory({
				sessionId: a.sessionId,
				actorId: `${a.actorId}-b`,
				verifyOwner: true,
				request: client.request,
			});

			await expect(asB.getMessages()).rejects.toThrow(`belongs to user "${a.actorId}"`);
			await expect(
				asB.addMessage({ role: 'user', content: [{ type: 'text', text: 'Hello from B' }] }),
			).rejects.toThrow(`belongs to user "${a.actorId}"`);
			expect((await client.getSession(a.sessionId))?.events).toHaveLength(1);
		});
	});

	// Opt-in (AGENT_MEMORY_SUMMARY_TESTS=true): writes 40 events and waits for the
	// server's background summary, which took about 20 seconds on the hosted store.
	describe.skipIf(!summaryTests)('server summary', () => {
		it('puts the summary in front of the retained turns for the model, and never in getMessages()', async () => {
			const { sessionId, history } = newSession();
			const topics = ['Lisbon', 'sourdough', 'the violin', 'marathons', 'Rust', 'houseplants'];
			for (let i = 0; i < 20; i++) {
				const topic = topics[i % topics.length];
				await history.addMessages([
					{
						role: 'user',
						content: [{ type: 'text', text: `Turn ${i + 1}: tell me about ${topic}.` }],
					},
					{
						role: 'assistant',
						content: [{ type: 'text', text: `About ${topic}: it rewards patience.` }],
					},
				]);
			}

			const deadline = Date.now() + 90_000;
			let stored = await client.getSession(sessionId);
			while (!stored?.summary && Date.now() < deadline) {
				await sleep(5_000);
				stored = await client.getSession(sessionId);
			}
			expect(stored?.summary?.text, 'the server produced no summary within 90 s').toBeTruthy();
			expect(stored!.events.length).toBeLessThan(40);

			const memory = new SummaryAwareWindowedChatMemory(history, {
				windowSize: 50,
				includeSummary: true,
			});
			const [first, ...rest] = await memory.loadMessages();
			expect(first.id).toBe(SUMMARY_MESSAGE_ID);
			expect(first.role).toBe('user');
			expect(first.content).toEqual([
				{ type: 'text', text: `Summary of the earlier conversation:\n${stored!.summary!.text}` },
			]);
			expect(rest).toHaveLength(stored!.events.length);

			const widget = await history.getMessages();
			expect(widget).toHaveLength(stored!.events.length);
			expect(widget.map((m) => m.id)).not.toContain(SUMMARY_MESSAGE_ID);
		}, 120_000);
	});

	it('recalls long-term memories created directly, scoped to the user', async () => {
		const { history, actorId } = newSession();
		const other = newSession();
		const created = await client.request<{ created: string[] }>({
			method: 'POST',
			path: '/memories',
			body: {
				memories: [
					{ memoryId: `${actorId}-m1`, ownerId: actorId, text: 'The user is vegetarian' },
					{
						memoryId: `${other.actorId}-m1`,
						ownerId: other.actorId,
						text: 'The user eats steak daily',
					},
				],
			},
		});
		expect(created?.created).toHaveLength(2);
		const memory = new SummaryAwareWindowedChatMemory(history, {
			windowSize: 10,
			includeSummary: false,
			recall: { query: 'What does the user eat?', limit: 5 },
		});

		const messages = await memory.loadMessages();

		expect(messages).toHaveLength(1);
		const [recall] = messages[0].content;
		expect(recall.type === 'text' && recall.text).toContain('The user is vegetarian');
		expect(recall.type === 'text' && recall.text).not.toContain('steak');
	});
});
