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
			url: 'https://memory.example.com/v1/stores/store%2F1/session-memory/s-1',
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
			'https://memory.example.com/v1/stores/store%2F1/session-memory/events',
			'https://memory.example.com/v1/stores/store%2F1/session-memory/events',
		]);
		expect(posts.map((r) => r.options.body)).toMatchObject([
			{
				sessionId: 's-1',
				actorId: 'user-1',
				role: 'USER',
				content: [{ text: 'What is 2+2?' }],
				namespaceRef: { namespaceId: 'ns-product' },
			},
			{ role: 'ASSISTANT', content: [{ text: 'It is 4.' }] },
		]);
	});

	it.each([
		['sessionId', "'Session ID' is empty"],
		['actorId', "'User ID' is empty"],
	])('rejects an empty %s', async (name, message) => {
		const { ctx } = context({ parameters: { [name]: '  ' } });

		await expect(new RedisAgentMemoryChatMemory().supplyData.call(ctx, 0)).rejects.toThrow(message);
	});

	it.each([
		['sessionId', "'Session ID' is empty"],
		['actorId', "'User ID' is empty"],
	])('rejects a missing %s with its own message', async (name, message) => {
		const { ctx } = context({ parameters: { [name]: undefined } });

		await expect(new RedisAgentMemoryChatMemory().supplyData.call(ctx, 0)).rejects.toThrow(message);
	});

	it('accepts numeric session and user IDs', async () => {
		const { memory, requests } = await supply({ parameters: { sessionId: 12345, actorId: 678 } });

		await memory.saveContext({ input: 'Hi' }, { output: 'Hello' });

		expect(requests[0].options.body).toMatchObject({ sessionId: '12345', actorId: '678' });
	});
});
