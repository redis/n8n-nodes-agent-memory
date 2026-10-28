import { describe, expect, it } from 'vitest';
import type { Message } from '@n8n/ai-node-sdk';
import {
	AgentMemoryChatHistory,
	SUMMARY_MESSAGE_ID,
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

const SESSION_PATH = '/session-memory/session%201%2Fa';

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
			expect(calls[0]).toMatchObject({
				method: 'POST',
				path: '/session-memory/events',
				body: {
					sessionId: 'session 1/a',
					actorId: 'user-1',
					role: 'USER',
					content: [{ text: 'Hi' }],
				},
			});
			const body = calls[0].body as { createdAt: string; namespaceRef?: unknown };
			expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
			expect(body).not.toHaveProperty('namespaceRef');
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

			expect(calls[0].body).toMatchObject({ namespaceRef: { namespaceId: 'ns-product' } });
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
					{ type: 'tool-call', toolCallId: 'call-1', toolName: 'calculator', input: '{"input":"2+2"}' },
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
