import { describe, expect, it } from 'vitest';
import type { Message } from '@n8n/ai-node-sdk';
import type { INode } from 'n8n-workflow';
import recordedSession from './fixtures/session-with-summary.json';
import {
	AgentMemoryChatHistory,
	RECALL_MESSAGE_ID,
	SUMMARY_MESSAGE_ID,
	SUMMARY_VIEW_MESSAGE_ID,
	SummaryAwareWindowedChatMemory,
	type AgentMemoryRequest,
} from '../../nodes/RedisAgentMemoryChatMemory/memory';

type Call = Parameters<AgentMemoryRequest>[0];

/** Records every request and answers from canned responses keyed by "METHOD path". */
function fakeRequest(responses: Record<string, unknown> = {}) {
	const calls: Call[] = [];
	const request: AgentMemoryRequest = async <T>(call: Call) => {
		calls.push(call);
		const key = `${call.method} ${call.path}`;
		if (key in responses) return responses[key] as T;
		if (call.allowNotFound) return undefined;
		return {} as T;
	};
	return { calls, request };
}

function event(eventId: string, role: 'USER' | 'ASSISTANT' | 'SYSTEM', ...texts: string[]) {
	return {
		eventId,
		actorId: 'user-1',
		sessionId: 'session-1',
		role,
		content: texts.map((text) => ({ text })),
		createdAt: '2026-10-09T10:00:00Z',
	};
}

function history(request: AgentMemoryRequest, namespaceId?: string) {
	return new AgentMemoryChatHistory({
		sessionId: 'session 1/a',
		actorId: 'user-1',
		namespaceId,
		request,
	});
}

const SESSION_PATH = '/sessions/session%201%2Fa';
const EVENTS_PATH = `${SESSION_PATH}/events`;

function text(message: Message): string {
	return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('AgentMemoryChatHistory', () => {
	describe('getMessages', () => {
		it('maps session events to messages, in order, with their roles', async () => {
			const { request, calls } = fakeRequest({
				[`GET ${SESSION_PATH}`]: {
					sessionId: 'session 1/a',
					ownerId: 'user-1',
					events: [
						event('e1', 'USER', 'Hi'),
						event('e2', 'ASSISTANT', 'Hello'),
						event('e3', 'SYSTEM', 'Be brief'),
					],
				},
			});

			const messages = await history(request).getMessages();

			expect(calls).toEqual([{ method: 'GET', path: SESSION_PATH, allowNotFound: true }]);
			expect(messages.map((m) => [m.id, m.role, text(m)])).toEqual([
				['e1', 'user', 'Hi'],
				['e2', 'assistant', 'Hello'],
				['e3', 'system', 'Be brief'],
			]);
		});

		it('joins multi-part content and drops events without text', async () => {
			const { request } = fakeRequest({
				[`GET ${SESSION_PATH}`]: {
					events: [event('e1', 'USER', 'line 1', 'line 2'), event('e2', 'ASSISTANT')],
				},
			});

			const messages = await history(request).getMessages();

			expect(messages).toHaveLength(1);
			expect(text(messages[0])).toBe('line 1\nline 2');
		});

		it('leaves the summary out, so the chat widget and Memory Manager never see it', async () => {
			const { request } = fakeRequest({
				[`GET ${SESSION_PATH}`]: {
					events: [event('e1', 'USER', 'Hi')],
					summary: { text: 'Earlier turns', summarizedUpToEventId: 'e0' },
				},
			});

			const messages = await history(request).getMessages();

			expect(messages.map((m) => m.id)).toEqual(['e1']);
		});

		it('returns no messages for an unknown session', async () => {
			const { request } = fakeRequest();

			expect(await history(request).getMessages()).toEqual([]);
		});
	});

	describe('getSession', () => {
		it('returns the summary text with the messages', async () => {
			const { request } = fakeRequest({
				[`GET ${SESSION_PATH}`]: {
					events: [event('e1', 'USER', 'Hi')],
					summary: { text: 'Earlier turns', summarizedUpToEventId: 'e0' },
				},
			});

			const session = await history(request).getSession();

			expect(session.summary).toBe('Earlier turns');
			expect(session.messages).toHaveLength(1);
		});
	});

	describe('addMessage', () => {
		it('posts one session event per message', async () => {
			const { request, calls } = fakeRequest();

			await history(request).addMessage({
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
			});

			expect(calls).toHaveLength(1);
			// The session is in the path; the body names the actor, not the session.
			expect(calls[0]).toMatchObject({
				method: 'POST',
				path: EVENTS_PATH,
				body: {
					idempotencyKey: expect.any(String) as string,
					actorId: 'user-1',
					role: 'USER',
					content: [{ text: 'Hi' }],
				},
			});
			const body = calls[0].body as { createdAt: string };
			expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
			expect(body).not.toHaveProperty('sessionId');
			expect(body).not.toHaveProperty('namespaceId');
		});

		it('sends a different idempotency key with every event', async () => {
			const { request, calls } = fakeRequest();
			const message: Message = { role: 'user', content: [{ type: 'text', text: 'Hi' }] };

			await history(request).addMessages([message, message]);

			const keys = calls.map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
			expect(keys).toHaveLength(2);
			expect(keys[0]).not.toBe(keys[1]);
		});

		it.each([
			['assistant', 'ASSISTANT'],
			['system', 'SYSTEM'],
		] as const)('maps the %s role to %s', async (role, expected) => {
			const { request, calls } = fakeRequest();

			await history(request).addMessage({ role, content: [{ type: 'text', text: 'x' }] });

			expect(calls[0].body).toMatchObject({ role: expected });
		});

		it('binds the event to the namespace when one is set', async () => {
			const { request, calls } = fakeRequest();

			await history(request, 'ns-product').addMessage({
				role: 'user',
				content: [{ type: 'text', text: 'Hi' }],
			});

			expect(calls[0].body).toMatchObject({ namespaceId: 'ns-product' });
		});

		it('keeps only non-empty text parts', async () => {
			const { request, calls } = fakeRequest();

			await history(request).addMessage({
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: 'thinking' },
					{ type: 'text', text: '' },
					{ type: 'text', text: 'Answer' },
				],
			});

			expect(calls[0].body).toMatchObject({ content: [{ text: 'Answer' }] });
		});

		it('skips tool results', async () => {
			const { request, calls } = fakeRequest();

			await history(request).addMessage({
				role: 'tool',
				content: [{ type: 'tool-result', toolCallId: 'call-1', result: '4' }],
			});

			expect(calls).toEqual([]);
		});

		it('skips assistant messages that request tool calls, even when they carry text', async () => {
			const { request, calls } = fakeRequest();

			await history(request).addMessage({
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
			});

			expect(calls).toEqual([]);
		});

		it('skips messages with no text', async () => {
			const { request, calls } = fakeRequest();

			await history(request).addMessage({ role: 'user', content: [{ type: 'text', text: '' }] });

			expect(calls).toEqual([]);
		});
	});

	describe('clear', () => {
		it('deletes the session and tolerates an unknown one', async () => {
			const { request, calls } = fakeRequest();

			await history(request).clear();

			expect(calls).toEqual([{ method: 'DELETE', path: SESSION_PATH, allowNotFound: true }]);
		});
	});
});

describe('SummaryAwareWindowedChatMemory', () => {
	const events = Array.from({ length: 10 }, (_, i) =>
		event(`e${i}`, i % 2 === 0 ? 'USER' : 'ASSISTANT', `turn ${i}`),
	);
	const sessionWithSummary = {
		[`GET ${SESSION_PATH}`]: {
			events,
			summary: { text: 'Earlier turns', summarizedUpToEventId: 'e-1' },
		},
	};

	it('keeps the last windowSize turns and puts the summary in front', async () => {
		const { request } = fakeRequest(sessionWithSummary);
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 2,
			includeSummary: true,
		});

		const messages = await memory.loadMessages();

		expect(messages.map((m) => m.id)).toEqual([SUMMARY_MESSAGE_ID, 'e6', 'e7', 'e8', 'e9']);
		expect(messages[0].role).toBe('user');
		expect(text(messages[0])).toBe('Summary of the earlier conversation:\nEarlier turns');
	});

	it('returns stored SYSTEM events as user messages, so the history holds no system message', async () => {
		const { request } = fakeRequest({
			[`GET ${SESSION_PATH}`]: {
				events: [event('e1', 'SYSTEM', 'Be brief'), event('e2', 'USER', 'Hi')],
			},
		});
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
		});

		const messages = await memory.loadMessages();

		expect(messages.map((m) => [m.id, m.role, text(m)])).toEqual([
			['e1', 'user', 'Be brief'],
			['e2', 'user', 'Hi'],
		]);
	});

	it('saves a turn as a user and an assistant message, and clears through the history', async () => {
		const { request, calls } = fakeRequest();
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
		});

		await memory.saveTurn('What is 2+2?', 'It is 4.');
		await memory.clear();

		expect(calls.map((c) => [c.method, c.path])).toEqual([
			['POST', EVENTS_PATH],
			['POST', EVENTS_PATH],
			['DELETE', SESSION_PATH],
		]);
		expect(calls.slice(0, 2).map((c) => c.body)).toMatchObject([
			{ role: 'USER', content: [{ text: 'What is 2+2?' }] },
			{ role: 'ASSISTANT', content: [{ text: 'It is 4.' }] },
		]);
	});

	it('leaves the summary out when includeSummary is off', async () => {
		const { request } = fakeRequest(sessionWithSummary);
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 2,
			includeSummary: false,
		});

		const messages = await memory.loadMessages();

		expect(messages.map((m) => m.id)).toEqual(['e6', 'e7', 'e8', 'e9']);
	});

	it('reads the session once per load', async () => {
		const { request, calls } = fakeRequest(sessionWithSummary);
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
		});

		await memory.loadMessages();

		expect(calls).toHaveLength(1);
	});

	it('saves a turn as a user event followed by an assistant event', async () => {
		const { request, calls } = fakeRequest();
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
		});

		await memory.saveTurn('What is 2+2?', 'It is 4.');

		expect(calls.map((call) => call.body)).toMatchObject([
			{ role: 'USER', content: [{ text: 'What is 2+2?' }] },
			{ role: 'ASSISTANT', content: [{ text: 'It is 4.' }] },
		]);
	});
});

/**
 * A real session response, recorded on 2026-11-02 after 40 events: the server
 * kept the last 20 and summarized the first 20. The session and summary shape
 * is unchanged on the unified Iris API (`GET …/sessions/{sessionId}`). Pins the
 * wire shape the fake responses above only assume.
 */
describe('recorded session with a server summary', () => {
	const path = `/sessions/${encodeURIComponent(recordedSession.sessionId)}`;

	function recorded() {
		const { request } = fakeRequest({ [`GET ${path}`]: recordedSession });
		return new AgentMemoryChatHistory({
			sessionId: recordedSession.sessionId,
			actorId: recordedSession.ownerId,
			request,
		});
	}

	it('reads the summary from summary.text and the retained turns from events', async () => {
		const session = await recorded().getSession();

		expect(session.summary).toBe(recordedSession.summary.text);
		expect(session.summary).toContain('data engineer from Berlin');
		expect(session.messages).toHaveLength(recordedSession.events.length);
		expect(session.messages.map((m) => m.role)).toEqual(
			recordedSession.events.map((e) => (e.role === 'USER' ? 'user' : 'assistant')),
		);
		// The summary's boundary event is not among the retained ones.
		expect(recordedSession.events.map((e) => e.eventId)).not.toContain(
			recordedSession.summary.summarizedUpToEventId,
		);
	});

	it('gives the model the summary first and the chat widget no summary at all', async () => {
		const history = recorded();
		const memory = new SummaryAwareWindowedChatMemory(history, {
			windowSize: 50,
			includeSummary: true,
		});

		const [first, ...rest] = await memory.loadMessages();
		expect(first.id).toBe(SUMMARY_MESSAGE_ID);
		expect(text(first)).toBe(
			`Summary of the earlier conversation:\n${recordedSession.summary.text}`,
		);
		expect(rest.map((m) => m.id)).toEqual(recordedSession.events.map((e) => e.eventId));

		const widget = await history.getMessages();
		expect(widget.map((m) => m.id)).not.toContain(SUMMARY_MESSAGE_ID);
		expect(widget.every((m) => m.role !== 'system')).toBe(true);
	});
});

describe('AgentMemoryChatHistory with Verify Session Owner', () => {
	const NODE: INode = {
		id: 'memory-node',
		name: 'Redis Agent Chat Memory',
		type: '@redis/n8n-nodes-agent-memory.redisAgentMemoryChatMemory',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	const MISMATCH =
		'Session "session 1/a" belongs to user "user-2", not to the configured User ID "user-1". ' +
		'Use a session ID derived from the user, or turn off "Verify Session Owner" for shared sessions.';

	function verifying(request: AgentMemoryRequest) {
		return new AgentMemoryChatHistory({
			sessionId: 'session 1/a',
			actorId: 'user-1',
			verifyOwner: true,
			node: NODE,
			itemIndex: 3,
			request,
		});
	}
	const ownedByOther = {
		[`GET ${SESSION_PATH}`]: {
			sessionId: 'session 1/a',
			ownerId: 'user-2',
			events: [event('e1', 'USER', 'Secret')],
		},
	};
	const ownedByUs = {
		[`GET ${SESSION_PATH}`]: { sessionId: 'session 1/a', ownerId: 'user-1', events: [] },
	};

	// An n8n error on the node, with the item, so n8n reports it on the memory
	// node whichever node called the history (the AI Agent or the Memory Manager).
	it('refuses to read a session owned by another user, as an n8n error on the node', async () => {
		const { request } = fakeRequest(ownedByOther);

		await expect(verifying(request).getMessages()).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: MISMATCH,
			node: { name: 'Redis Agent Chat Memory' },
			context: { itemIndex: 3 },
			description: expect.stringContaining('group chats') as string,
		});
	});

	it('reads the session once before the first write, then writes without re-reading', async () => {
		const { request, calls } = fakeRequest(ownedByUs);
		const history = verifying(request);
		const message: Message = { role: 'user', content: [{ type: 'text', text: 'Hi' }] };

		await history.addMessage(message);
		await history.addMessage(message);

		expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'POST']);
	});

	it('refuses to write into a session owned by another user', async () => {
		const { request, calls } = fakeRequest(ownedByOther);

		await expect(
			verifying(request).addMessage({ role: 'user', content: [{ type: 'text', text: 'Hi' }] }),
		).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: MISMATCH,
			context: { itemIndex: 3 },
		});
		expect(calls.map((call) => call.method)).toEqual(['GET']);
	});

	it('writes to a session that does not exist yet', async () => {
		const { request, calls } = fakeRequest();

		await verifying(request).addMessage({ role: 'user', content: [{ type: 'text', text: 'Hi' }] });

		expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
	});

	it('does not check or pre-read when the option is off', async () => {
		const { request, calls } = fakeRequest(ownedByOther);
		const plain = history(request);

		expect(await plain.getMessages()).toHaveLength(1);
		await plain.addMessage({ role: 'user', content: [{ type: 'text', text: 'Hi' }] });
		expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
	});
});

describe('SummaryAwareWindowedChatMemory with a summary view', () => {
	const RESULT_PATH = '/summary-views/sv-1/result';
	const session = {
		[`GET ${SESSION_PATH}`]: {
			events: [event('e1', 'USER', 'Hi')],
			summary: { text: 'Earlier turns', summarizedUpToEventId: 'e0' },
		},
	};
	const ready = {
		[`GET ${RESULT_PATH}`]: { status: 'READY', value: { text: 'Vegetarian, in Sofia.' } },
	};
	const options = { windowSize: 10, includeSummary: true, summaryViewId: 'sv-1' };

	it("reads the view's result for the user and puts it after recall, before the summary", async () => {
		const { request, calls } = fakeRequest({
			...session,
			...ready,
			'POST /memories/search': { items: [{ memoryId: 'm1', text: 'Likes spicy food' }] },
		});
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			...options,
			recall: { query: 'food', limit: 5 },
		});

		const messages = await memory.loadMessages();

		expect(calls.find((call) => call.path === RESULT_PATH)).toEqual({
			method: 'GET',
			path: RESULT_PATH,
			qs: { ownerId: 'user-1' },
			allowNotFound: true,
		});
		expect(messages.map((m) => m.id)).toEqual([
			RECALL_MESSAGE_ID,
			SUMMARY_VIEW_MESSAGE_ID,
			SUMMARY_MESSAGE_ID,
			'e1',
		]);
		expect(messages[1].role).toBe('user');
		expect(text(messages[1])).toBe(
			'What is known about the user, summarized from earlier conversations:\nVegetarian, in Sofia.',
		);
	});

	it('adds nothing while the result is not READY, and when the view does not exist', async () => {
		for (const result of [
			{ status: 'COLD' },
			{ status: 'FAILED', errorCode: 'GENERATION_FAILED' },
		]) {
			const { request } = fakeRequest({ ...session, [`GET ${RESULT_PATH}`]: result });
			const memory = new SummaryAwareWindowedChatMemory(history(request), options);
			expect((await memory.loadMessages()).map((m) => m.id)).toEqual([SUMMARY_MESSAGE_ID, 'e1']);
		}
		// No canned result: the fake answers a not-found with undefined, as the adapter does.
		const { request, calls } = fakeRequest(session);
		const memory = new SummaryAwareWindowedChatMemory(history(request), options);
		expect((await memory.loadMessages()).map((m) => m.id)).toEqual([SUMMARY_MESSAGE_ID, 'e1']);
		expect(calls.map((call) => call.path)).toEqual([SESSION_PATH, RESULT_PATH]);
	});

	it('sends a structured summary as JSON', async () => {
		const { request } = fakeRequest({
			...session,
			[`GET ${RESULT_PATH}`]: { status: 'READY', value: { data: { city: 'Sofia' } } },
		});
		const memory = new SummaryAwareWindowedChatMemory(history(request), options);

		const [briefing] = await memory.loadMessages();

		expect(briefing.id).toBe(SUMMARY_VIEW_MESSAGE_ID);
		expect(text(briefing)).toContain('{"city":"Sofia"}');
	});

	it('does not read a view when none is set', async () => {
		const { request, calls } = fakeRequest({ ...session, ...ready });
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
		});

		await memory.loadMessages();

		expect(calls.map((call) => call.path)).toEqual([SESSION_PATH]);
	});
});

describe('SummaryAwareWindowedChatMemory with recall', () => {
	const session = {
		[`GET ${SESSION_PATH}`]: {
			events: [event('e1', 'USER', 'Hi')],
			summary: { text: 'Earlier turns', summarizedUpToEventId: 'e0' },
		},
	};
	const found = {
		'POST /memories/search': {
			items: [
				{ memoryId: 'm1', text: 'The user is vegetarian' },
				{ memoryId: 'm2', text: 'The user lives in Sofia' },
			],
		},
	};

	it("searches the user's memories with the query and puts them before the summary", async () => {
		const { request, calls } = fakeRequest({ ...session, ...found });
		const memory = new SummaryAwareWindowedChatMemory(history(request, 'ns-1'), {
			windowSize: 10,
			includeSummary: true,
			recall: { query: 'What should I cook?', limit: 5 },
		});

		const messages = await memory.loadMessages();

		const search = calls.find((call) => call.path === '/memories/search');
		expect(search).toMatchObject({
			method: 'POST',
			body: {
				query: 'What should I cook?',
				limit: 5,
				filter: { ownerId: { eq: 'user-1' }, namespaceId: { eq: 'ns-1' } },
			},
		});
		expect(messages.map((m) => m.id)).toEqual([RECALL_MESSAGE_ID, SUMMARY_MESSAGE_ID, 'e1']);
		expect(messages[0].role).toBe('user');
		expect(text(messages[0])).toBe(
			'Long-term memories about the user, from earlier conversations:\n- The user is vegetarian\n- The user lives in Sofia',
		);
	});

	it('adds nothing when the search finds nothing', async () => {
		const { request } = fakeRequest({ ...session, 'POST /memories/search': { items: [] } });
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: false,
			recall: { query: 'anything', limit: 5 },
		});

		expect((await memory.loadMessages()).map((m) => m.id)).toEqual(['e1']);
	});

	it('skips the search when the query is blank', async () => {
		const { request, calls } = fakeRequest({ ...session, ...found });
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: false,
			recall: { query: '  ', limit: 5 },
		});

		await memory.loadMessages();

		expect(calls.map((call) => call.method)).toEqual(['GET']);
	});

	it('does not search when recall is off', async () => {
		const { request, calls } = fakeRequest({ ...session, ...found });
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
		});

		await memory.loadMessages();

		expect(calls.map((call) => call.method)).toEqual(['GET']);
	});

	it('drops a recalled memory that belongs to another user', async () => {
		const { request } = fakeRequest({
			...session,
			'POST /memories/search': {
				items: [
					{ memoryId: 'm1', text: 'Mine', ownerId: 'user-1' },
					{ memoryId: 'm2', text: 'Theirs', ownerId: 'user-2' },
				],
			},
		});
		const memory = new SummaryAwareWindowedChatMemory(history(request), {
			windowSize: 10,
			includeSummary: true,
			recall: { query: 'anything', limit: 5 },
		});

		const recalled = (await memory.loadMessages()).find((m) => m.id === RECALL_MESSAGE_ID);

		expect(recalled && text(recalled)).toContain('Mine');
		expect(recalled && text(recalled)).not.toContain('Theirs');
	});
});
