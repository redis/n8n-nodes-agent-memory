import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { stubRequestsContaining } from '../harness';
import {
	callWebhook,
	callWebhookAndWait,
	createWorkflow,
	deleteWorkflow,
	executionError,
	type CreatedWorkflow,
	type WorkflowSpec,
} from '../n8n-api';

const AGENT_MEMORY_CREDENTIAL = {
	redisAgentMemoryApi: { id: 'e2eAgentMemory01', name: 'Agent Memory (e2e)' },
};

/** Webhook → the action node, Session > Get. */
const sessionGetWorkflow: WorkflowSpec = {
	name: 'E2E smoke: session get',
	nodes: [
		{
			name: 'Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			parameters: {
				httpMethod: 'POST',
				path: 'session-get',
				responseMode: 'lastNode',
				options: {},
			},
		},
		{
			name: 'Session get',
			type: '@redis/n8n-nodes-agent-memory.redisAgentMemory',
			typeVersion: 1,
			parameters: {
				resource: 'session',
				operation: 'get',
				sessionId: '={{ $json.body.sessionId }}',
				options: {},
			},
			credentials: AGENT_MEMORY_CREDENTIAL,
		},
	],
	connections: { Webhook: { main: [[{ node: 'Session get', type: 'main', index: 0 }]] } },
};

/** The chat-agent fixture, with the action node as a tool in place of the Calculator. */
function chatAgentWorkflow(ownerId: string): WorkflowSpec {
	return {
		name: 'E2E smoke: chat agent with tool',
		nodes: [
			{
				name: 'Chat Trigger',
				type: '@n8n/n8n-nodes-langchain.chatTrigger',
				typeVersion: 1.5,
				parameters: { public: true, mode: 'webhook', options: { responseMode: 'lastNode' } },
			},
			{
				name: 'AI Agent',
				type: '@n8n/n8n-nodes-langchain.agent',
				typeVersion: 3.1,
				parameters: { options: {} },
			},
			{
				name: 'OpenAI stub',
				type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
				typeVersion: 1.2,
				position: [160, 220],
				parameters: { model: { __rl: true, mode: 'id', value: 'gpt-4o-mini' }, options: {} },
				credentials: { openAiApi: { id: 'e2eOpenAiStub001', name: 'OpenAI stub (e2e)' } },
			},
			{
				name: 'Redis Agent Chat Memory',
				type: '@redis/n8n-nodes-agent-memory.redisAgentMemoryChatMemory',
				typeVersion: 1,
				position: [320, 220],
				parameters: {
					sessionId: '={{ $json.sessionId }}',
					actorId: "={{ 'user-' + $json.sessionId }}",
					options: {},
				},
				credentials: AGENT_MEMORY_CREDENTIAL,
			},
			{
				name: 'Search memories',
				type: '@redis/n8n-nodes-agent-memory.redisAgentMemoryTool',
				typeVersion: 1,
				position: [480, 220],
				parameters: {
					resource: 'longTermMemory',
					operation: 'search',
					query: "={{ $fromAI('query', 'what to look for', 'string') }}",
					ownerId,
					maxResults: 5,
					options: {},
				},
				credentials: AGENT_MEMORY_CREDENTIAL,
			},
		],
		connections: {
			'Chat Trigger': { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
			'OpenAI stub': {
				ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]],
			},
			'Redis Agent Chat Memory': {
				ai_memory: [[{ node: 'AI Agent', type: 'ai_memory', index: 0 }]],
			},
			'Search memories': { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] },
		},
	};
}

/**
 * Proves the scenario infrastructure: a test file creates its own workflows
 * through n8n's REST API, reads the error a failed node shows, and drives
 * the AI Agent's tool calls through the stub.
 */
describe.skipIf(!agentMemoryConfig)(`E2E harness smoke ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const toolOwnerId = `${runPrefix}-smoke-tool-owner`;
	let sessionGet: CreatedWorkflow;
	let chatAgent: CreatedWorkflow;

	beforeAll(async () => {
		sessionGet = await createWorkflow(sessionGetWorkflow);
		chatAgent = await createWorkflow(chatAgentWorkflow(toolOwnerId));
	});

	afterAll(async () => {
		if (sessionGet) await deleteWorkflow(sessionGet.id);
		if (chatAgent) await deleteWorkflow(chatAgent.id);
		await client.cleanup();
	});

	it('shows the empty-parameter error on the node', async () => {
		const { response, execution } = await callWebhookAndWait(
			sessionGet.id,
			sessionGet.webhooks['Webhook'],
			{},
		);

		expect(response.status).toBe(500);
		expect(execution.status).toBe('error');
		expect(executionError(execution)).toMatchObject({
			nodeName: 'Session get',
			lastNodeExecuted: 'Session get',
			message: "'Session ID' is empty",
			type: 'NodeOperationError',
			itemIndex: 0,
		});
	});

	it("surfaces the API's 404 for a session that does not exist", async () => {
		const sessionId = `${runPrefix}-smoke-missing`;

		const { response, execution } = await callWebhookAndWait(
			sessionGet.id,
			sessionGet.webhooks['Webhook'],
			{ sessionId },
		);

		expect(response.status).toBe(500);
		expect(executionError(execution)).toMatchObject({
			nodeName: 'Session get',
			type: 'NodeApiError',
			httpCode: '404',
			message: 'The requested session was not found',
			description: 'Session Not Found (HTTP 404)',
		});
		expect(executionError(execution)?.context?.data).toMatchObject({
			status: 404,
			type: '/errors/resource-not-found',
		});
	});

	it('calls the tool the message names, with the arguments given', async () => {
		const sessionId = `${runPrefix}-smoke-tool`;
		client.track(sessionId, `user-${sessionId}`);
		client.track(sessionId, toolOwnerId);
		const marker = `${runPrefix}-nothing-is-stored-under-this`;

		const response = await callWebhook(chatAgent.webhooks['Chat Trigger'], {
			action: 'sendMessage',
			sessionId,
			chatInput: `use tool Search_memories with {"query":"${marker}"}`,
		});

		expect(response.status).toBe(200);
		expect((response.json as { output: string }).output).toMatch(/^The answer is /);

		const requests = await stubRequestsContaining(marker);
		expect(requests.length).toBeGreaterThanOrEqual(2);
		const [first, ...rest] = requests;
		expect(first.tools?.map((tool) => tool.function.name)).toEqual(['Search_memories']);
		expect(first.tools?.[0].function.parameters).toMatchObject({
			properties: { query: { type: 'string' } },
		});
		const toolMessage = rest.flatMap((r) => r.messages).find((m) => m.role === 'tool');
		expect(toolMessage).toBeDefined();
		const toolCall = rest
			.flatMap((r) => r.messages)
			.find((m) => m.role === 'assistant' && m.tool_calls?.length) as
			| { tool_calls: Array<{ function: { name: string; arguments: string } }> }
			| undefined;
		expect(toolCall?.tool_calls[0].function).toEqual({
			name: 'Search_memories',
			arguments: JSON.stringify({ query: marker }),
		});
	});
});
