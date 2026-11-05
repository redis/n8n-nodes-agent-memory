import { describe, expect, it } from 'vitest';
import type { IHttpRequestOptions, INode, ISupplyDataFunctions } from 'n8n-workflow';
import { RedisAgentMemoryChatMemory } from '../../nodes/RedisAgentMemoryChatMemory/RedisAgentMemoryChatMemory.node';
import { NOT_FOUND_ERROR_TYPE } from '../../nodes/shared/agentMemoryRequest';

/** A LangChain message, as far as these tests read it. */
interface BaseMessage {
	id?: string;
	content: unknown;
	getType(): string;
}

/** The LangChain memory the node supplies to the AI Agent, as far as these tests use it. */
interface SuppliedMemory {
	loadMemoryVariables(values: object): Promise<{ chat_history: BaseMessage[] }>;
	saveContext(input: { input: string }, output: { output: string }): Promise<void>;
}

interface Setup {
	parameters?: Record<string, unknown>;
	credentials?: Record<string, string>;
	respond?: (options: IHttpRequestOptions) => unknown;
}

const STORE_URL = 'https://memory.example.com/iris/data/v1/agent-memory/stores/store%2F1';

const NODE: INode = {
	id: 'memory-node',
	name: 'Redis Agent Memory',
	type: '@redis/n8n-nodes-agent-memory.redisAgentMemoryChatMemory',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** An HTTP failure as n8n's request helper surfaces it; `data` is the parsed body. */
function httpError(status: number, data?: unknown) {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		httpCode: String(status),
		response: { status, data },
	});
}

/** The body the API returns for a missing session (verified against the service). */
const SESSION_NOT_FOUND = {
	type: NOT_FOUND_ERROR_TYPE,
	title: 'Session Not Found',
	status: 404,
	detail: 'The requested session was not found',
};

function context({ parameters = {}, credentials = {}, respond = () => ({}) }: Setup) {
	const requests: Array<{ credentialType: string; options: IHttpRequestOptions }> = [];
	const params: Record<string, unknown> = {
		sessionId: 's-1',
		actorId: 'user-1',
		options: {},
		...parameters,
	};

	const ctx = {
		getNode: () => NODE,
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async () => ({
			serverUrl: 'https://memory.example.com/',
			storeId: 'store/1',
			apiKey: 'secret',
			...credentials,
		}),
		addInputData: () => ({ index: 0 }),
		addOutputData: () => undefined,
		helpers: {
			async httpRequestWithAuthentication(credentialType: string, options: IHttpRequestOptions) {
				requests.push({ credentialType, options });
				return await respond(options);
			},
		},
	};

	return { ctx: ctx as unknown as ISupplyDataFunctions, requests };
}

async function supply(setup: Setup = {}) {
	const { ctx, requests } = context(setup);
	const { response } = await new RedisAgentMemoryChatMemory().supplyData.call(ctx, 0);
	return { memory: response as SuppliedMemory, requests };
}

describe('RedisAgentMemoryChatMemory.supplyData', () => {
	it('loads the session through the credential, with a clean store URL', async () => {
		const { memory, requests } = await supply({
			respond: () => ({
				events: [
					{ eventId: 'e1', role: 'USER', content: [{ text: 'Hi' }] },
					{ eventId: 'e2', role: 'ASSISTANT', content: [{ text: 'Hello' }] },
				],
				summary: { text: 'Earlier turns', summarizedUpToEventId: 'e0' },
			}),
		});

		const { chat_history } = await memory.loadMemoryVariables({});

		expect(requests).toHaveLength(1);
		expect(requests[0].credentialType).toBe('redisAgentMemoryApi');
		expect(requests[0].options).toMatchObject({
			method: 'GET',
			url: `${STORE_URL}/sessions/s-1`,
			json: true,
		});
		expect(chat_history.map((m) => [m.getType(), m.content])).toEqual([
			['human', [{ type: 'text', text: 'Summary of the earlier conversation:\nEarlier turns' }]],
			['human', [{ type: 'text', text: 'Hi' }]],
			['ai', [{ type: 'text', text: 'Hello' }]],
		]);
	});

	it('applies the Context Window Length and Include Summary options', async () => {
		const events = Array.from({ length: 6 }, (_, i) => ({
			eventId: `e${i}`,
			role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
			content: [{ text: `turn ${i}` }],
		}));
		const { memory } = await supply({
			parameters: { options: { windowSize: 1, includeSummary: false } },
			respond: () => ({ events, summary: { text: 'Earlier turns' } }),
		});

		const { chat_history } = await memory.loadMemoryVariables({});

		expect(chat_history.map((m) => m.id)).toEqual(['e4', 'e5']);
	});

	it('treats an unknown session as empty', async () => {
		const { memory } = await supply({
			respond: () => {
				throw httpError(404, SESSION_NOT_FOUND);
			},
		});

		const { chat_history } = await memory.loadMemoryVariables({});

		expect(chat_history).toEqual([]);
	});

	it('fails the run for a 404 that is not the API not-found, such as a wrong URL', async () => {
		const { memory } = await supply({
			respond: () => {
				throw httpError(404, '404 page not found');
			},
		});

		// supplyMemory rethrows the adapter's NodeApiError as a NodeOperationError
		// with the same message (from the SDK's own copy of n8n-workflow, so the
		// class is matched by name); the adapter's tests pin the status code.
		const call = memory.loadMemoryVariables({});

		await expect(call).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: 'The resource you are requesting could not be found',
		});
	});

	it('fails the run for other API errors, with the status-specific message', async () => {
		const { memory } = await supply({
			respond: () => {
				throw httpError(401);
			},
		});

		// The SDK's log wrapper rethrows the adapter's NodeApiError as a
		// NodeOperationError (from its own copy of n8n-workflow, hence no
		// instanceof) and keeps the message; the adapter's tests pin the status.
		await expect(memory.loadMemoryVariables({})).rejects.toMatchObject({
			name: 'NodeOperationError',
			message: 'Authorization failed - please check your credentials',
		});
	});

	it('saves a turn as two session events with the user ID and namespace', async () => {
		const { memory, requests } = await supply({
			parameters: { options: { namespaceId: ' ns-product ' } },
		});

		await memory.saveContext({ input: 'What is 2+2?' }, { output: 'It is 4.' });

		const posts = requests.filter((r) => r.options.method === 'POST');
		expect(posts.map((r) => r.options.url)).toEqual([
			`${STORE_URL}/sessions/s-1/events`,
			`${STORE_URL}/sessions/s-1/events`,
		]);
		expect(posts.map((r) => r.options.body)).toMatchObject([
			{
				idempotencyKey: expect.any(String) as string,
				actorId: 'user-1',
				role: 'USER',
				content: [{ text: 'What is 2+2?' }],
				namespaceId: 'ns-product',
			},
			{ role: 'ASSISTANT', content: [{ text: 'It is 4.' }] },
		]);
		expect(posts[0].options.body).not.toHaveProperty('sessionId');
	});

	// n8n shows a sub-node error as "Error in sub-node …" with the node's
	// message demoted to the description and the node's own description
	// dropped, so the message itself must carry the hint.
	const EMPTY_ID_ERRORS = [
		[
			'sessionId',
			"'Session ID' is empty. Set a session ID, for example from the chat trigger output.",
			'Set a session ID, for example from the chat trigger output',
		],
		[
			'actorId',
			"'User ID' is empty. Set the ID of the user this conversation belongs to.",
			'Set the ID of the user this conversation belongs to',
		],
	] as const;

	it.each(EMPTY_ID_ERRORS)(
		'rejects an empty %s with the hint in the message',
		async (name, message, description) => {
			const { ctx } = context({ parameters: { [name]: '  ' } });

			await expect(new RedisAgentMemoryChatMemory().supplyData.call(ctx, 0)).rejects.toMatchObject({
				name: 'NodeOperationError',
				message,
				description,
				context: { itemIndex: 0 },
			});
		},
	);

	it.each(EMPTY_ID_ERRORS)('rejects a missing %s with its own message', async (name, message) => {
		const { ctx } = context({ parameters: { [name]: undefined } });

		await expect(new RedisAgentMemoryChatMemory().supplyData.call(ctx, 0)).rejects.toThrow(message);
	});

	describe('Context Window Length', () => {
		const events = Array.from({ length: 102 }, (_, i) => ({
			eventId: `e${i}`,
			role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
			content: [{ text: `turn ${i}` }],
		}));

		it.each([[''], [null], [undefined]])(
			'uses the default of 50 interactions when the option resolves to %j',
			async (windowSize) => {
				const { memory } = await supply({
					parameters: { options: { windowSize, includeSummary: false } },
					respond: () => ({ events }),
				});

				const { chat_history } = await memory.loadMemoryVariables({});

				expect(chat_history).toHaveLength(100);
				expect(chat_history[0].id).toBe('e2');
			},
		);

		it('accepts the string "1" from an expression as 1', async () => {
			const { memory } = await supply({
				parameters: { options: { windowSize: '1', includeSummary: false } },
				respond: () => ({ events }),
			});

			const { chat_history } = await memory.loadMemoryVariables({});

			expect(chat_history.map((m) => m.id)).toEqual(['e100', 'e101']);
		});

		it.each([[0], ['abc'], [-1], [1.5]])('rejects %j before any request', async (windowSize) => {
			const { ctx, requests } = context({ parameters: { options: { windowSize } } });

			await expect(new RedisAgentMemoryChatMemory().supplyData.call(ctx, 0)).rejects.toMatchObject({
				name: 'NodeOperationError',
				message: "'Context Window Length' must be a whole number of 1 or more",
				context: { itemIndex: 0 },
			});
			expect(requests).toEqual([]);
		});
	});

	describe('Recall Long-Term Memories', () => {
		const SEARCH_URL = `${STORE_URL}/memories/search`;
		const respond = (options: IHttpRequestOptions) =>
			options.url === SEARCH_URL
				? { items: [{ memoryId: 'm1', text: 'The user is vegetarian' }] }
				: { events: [{ eventId: 'e1', role: 'USER', content: [{ text: 'Hi' }] }] };

		it('searches with the top-level Recall Query and Recall Limit when the switch is on', async () => {
			const { memory, requests } = await supply({
				parameters: { recallLongTermMemories: true, recallQuery: 'food', recallLimit: 2 },
				respond,
			});

			const { chat_history } = await memory.loadMemoryVariables({});

			const search = requests.find((r) => r.options.url === SEARCH_URL);
			expect(search?.options).toMatchObject({
				method: 'POST',
				body: { query: 'food', limit: 2, filter: { ownerId: { eq: 'user-1' } } },
			});
			expect(chat_history.map((m) => [m.getType(), m.content])).toEqual([
				[
					'human',
					[
						{
							type: 'text',
							text: 'Long-term memories about the user, from earlier conversations:\n- The user is vegetarian',
						},
					],
				],
				['human', [{ type: 'text', text: 'Hi' }]],
			]);
		});

		it('ignores recall settings that an older workflow left in Options', async () => {
			const { memory, requests } = await supply({
				parameters: { options: { recallLongTermMemories: true, recallQuery: 'food' } },
				respond,
			});

			await memory.loadMemoryVariables({});

			expect(requests.map((r) => r.options.method)).toEqual(['GET']);
		});
	});

	it('accepts numeric session and user IDs', async () => {
		const { memory, requests } = await supply({ parameters: { sessionId: 12345, actorId: 678 } });

		await memory.saveContext({ input: 'Hi' }, { output: 'Hello' });

		expect(requests[0].options.url).toBe(`${STORE_URL}/sessions/12345/events`);
		expect(requests[0].options.body).toMatchObject({ actorId: '678' });
	});
});
