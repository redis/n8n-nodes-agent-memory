import { stubRequestsContaining, stubMessageText, type StubRequest } from '../harness';
import {
	callWebhookAndWait,
	type CreatedWorkflow,
	type Execution,
	type WebhookResponse,
	type WorkflowNode,
	type WorkflowSpec,
} from '../n8n-api';

/**
 * Builders for the scenario tests of the Redis Agent Memory node used as an
 * AI Agent tool: a chat workflow with the stub model and any number of tool
 * nodes, and one helper that sends a chat turn and collects what the tool
 * returned to the model and what n8n saved about the run.
 */

export const AGENT_MEMORY_CREDENTIAL = {
	redisAgentMemoryApi: { id: 'e2eAgentMemory01', name: 'Agent Memory (e2e)' },
};

/** The `usableAsTool` face of the action node. */
export const TOOL_NODE_TYPE = '@redis/n8n-nodes-agent-memory.redisAgentMemoryTool';

export const CHAT_TRIGGER = 'Chat Trigger';

/** A tool node: its name decides the function name the model sees. */
export interface ToolSpec {
	name: string;
	parameters: Record<string, unknown>;
	/** Node settings such as `retryOnFail`, merged into the node. */
	settings?: Record<string, unknown>;
}

/** The chat memory sub-node, attached only where a test needs history. */
export interface MemorySpec {
	sessionId: string;
	actorId: string;
	options?: Record<string, unknown>;
}

/**
 * A `$fromAI` expression as the editor writes it: the model fills the
 * parameter, the other arguments describe it to the model.
 */
export function fromAI(key: string, description: string, type = 'string'): string {
	return `={{ $fromAI('${key}', '${description}', '${type}') }}`;
}

/** n8n's rule: every run of characters outside `[A-Za-z0-9_-]` becomes one `_`. */
export function toolName(nodeName: string): string {
	return nodeName.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/**
 * Chat Trigger (public, webhook mode, answers with the last node) → AI Agent
 * with the OpenAI stub as model, the given tool nodes on `ai_tool`, and the
 * chat memory sub-node on `ai_memory` when `memory` is given.
 */
export function agentWithTools(
	name: string,
	tools: ToolSpec[],
	options: { memory?: MemorySpec; systemMessage?: string } = {},
): WorkflowSpec {
	const nodes: WorkflowNode[] = [
		{
			name: CHAT_TRIGGER,
			type: '@n8n/n8n-nodes-langchain.chatTrigger',
			typeVersion: 1.5,
			parameters: { public: true, mode: 'webhook', options: { responseMode: 'lastNode' } },
		},
		{
			name: 'AI Agent',
			type: '@n8n/n8n-nodes-langchain.agent',
			typeVersion: 3.1,
			parameters: {
				options: options.systemMessage ? { systemMessage: options.systemMessage } : {},
			},
		},
		{
			name: 'OpenAI stub',
			type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
			typeVersion: 1.2,
			position: [160, 220],
			parameters: { model: { __rl: true, mode: 'id', value: 'gpt-4o-mini' }, options: {} },
			credentials: { openAiApi: { id: 'e2eOpenAiStub001', name: 'OpenAI stub (e2e)' } },
		},
	];
	const connections: Record<string, unknown> = {
		[CHAT_TRIGGER]: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
		'OpenAI stub': {
			ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]],
		},
	};

	if (options.memory) {
		nodes.push({
			name: 'Redis Agent Chat Memory',
			type: '@redis/n8n-nodes-agent-memory.redisAgentMemoryChatMemory',
			typeVersion: 1,
			position: [320, 220],
			parameters: {
				sessionId: options.memory.sessionId,
				actorId: options.memory.actorId,
				options: options.memory.options ?? {},
			},
			credentials: AGENT_MEMORY_CREDENTIAL,
		});
		connections['Redis Agent Chat Memory'] = {
			ai_memory: [[{ node: 'AI Agent', type: 'ai_memory', index: 0 }]],
		};
	}

	tools.forEach((tool, index) => {
		nodes.push({
			...tool.settings,
			name: tool.name,
			type: TOOL_NODE_TYPE,
			typeVersion: 1,
			position: [480 + index * 200, 220],
			parameters: tool.parameters,
			credentials: AGENT_MEMORY_CREDENTIAL,
		});
		connections[tool.name] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
	});

	return { name, nodes, connections };
}

export interface ToolCall {
	name: string;
	/** Parsed from the JSON string the model sent. */
	arguments: Record<string, unknown>;
}

/** Everything one chat turn left behind. */
export interface ToolTurn {
	/** Put in front of the chat message, so `stubRequestsContaining(marker)` finds this turn only. */
	marker: string;
	chatInput: string;
	response: WebhookResponse;
	/** The chat answer, when the run produced one. */
	answer: string | undefined;
	execution: Execution;
	/** The stub requests of this turn, oldest first. */
	requests: StubRequest[];
	/** The tool call the model made, when it made one. */
	toolCall: ToolCall | undefined;
	/** The tool-role message content the model received, when the agent sent one. */
	toolResult: string | undefined;
}

let turnCounter = 0;

/** `use tool <function> with <json>`, the sentence the stub turns into a tool call. */
export function toolRequest(functionName: string, args: Record<string, unknown>): string {
	return `use tool ${functionName} with ${JSON.stringify(args)}`;
}

/**
 * Sends one chat message in `sessionId` and waits for the execution. A
 * per-turn marker goes in front of the message so the stub's record of this
 * turn can be told apart from other turns and other test files.
 */
export async function chatTurn(
	workflow: CreatedWorkflow,
	sessionId: string,
	message: string,
): Promise<ToolTurn> {
	turnCounter += 1;
	const marker = `${sessionId}.t${turnCounter}`;
	const chatInput = `[${marker}] ${message}`;
	const { response, execution } = await callWebhookAndWait(
		workflow.id,
		workflow.webhooks[CHAT_TRIGGER],
		{ action: 'sendMessage', sessionId, chatInput },
	);
	const requests = await stubRequestsContaining(marker);
	const messages = requests.flatMap((request) => request.messages);
	const assistantCall = messages.find((m) => m.role === 'assistant' && m.tool_calls?.length) as
		| { tool_calls: Array<{ function: { name: string; arguments: string } }> }
		| undefined;
	const toolCall = assistantCall
		? {
				name: assistantCall.tool_calls[0].function.name,
				arguments: JSON.parse(assistantCall.tool_calls[0].function.arguments) as Record<
					string,
					unknown
				>,
			}
		: undefined;
	const toolMessage = messages.find((m) => m.role === 'tool');
	const output = (response.json as { output?: unknown } | undefined)?.output;

	return {
		marker,
		chatInput,
		response,
		answer: typeof output === 'string' ? output : undefined,
		execution,
		requests,
		toolCall,
		toolResult: toolMessage ? stubMessageText(toolMessage) : undefined,
	};
}

/** `chatTurn` with a `use tool ... with ...` message. */
export async function callTool(
	workflow: CreatedWorkflow,
	sessionId: string,
	functionName: string,
	args: Record<string, unknown>,
): Promise<ToolTurn> {
	return await chatTurn(workflow, sessionId, toolRequest(functionName, args));
}

/** The items of a successful tool result, which n8n sends as a JSON array. */
export function toolResultItems(turn: ToolTurn): Array<Record<string, unknown>> {
	if (turn.toolResult === undefined) throw new Error('The model received no tool result');
	const parsed = JSON.parse(turn.toolResult) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error(`Expected a JSON array as tool result, got: ${turn.toolResult}`);
	}
	return parsed as Array<Record<string, unknown>>;
}
