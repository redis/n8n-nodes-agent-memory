import type { INode, INodeType, INodeTypeDescription, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { supplyMemory } from '@n8n/ai-node-sdk';
import { AgentMemoryChatHistory, SummaryAwareWindowedChatMemory } from './memory';
import { AGENT_MEMORY_CREDENTIAL, createAgentMemoryRequest } from '../shared/agentMemoryRequest';

type MemoryOptions = {
	/** A number from the field, or whatever an expression resolved to. */
	windowSize?: unknown;
	namespaceId?: string;
	includeSummary?: boolean;
	verifyOwner?: boolean;
};

/**
 * Default Context Window Length, in interactions. Generous on purpose: the
 * server already trims the session and folds older turns into the summary,
 * so a small window here would hide turns that the summary does not cover
 * yet. See docs/design-draft.md §9.3.
 */
const DEFAULT_WINDOW_SIZE = 50;

/**
 * The window as a whole number of 1 or more. An absent or empty option means
 * the default; anything else that is not such a number is an error, since
 * `slice(-NaN)` or `slice(0)` would turn the window off without a word.
 */
function windowSizeFrom(value: unknown, node: INode, itemIndex: number): number {
	if (value === undefined || value === null || value === '') return DEFAULT_WINDOW_SIZE;
	const windowSize = Number(value);
	if (!Number.isInteger(windowSize) || windowSize < 1) {
		throw new NodeOperationError(
			node,
			"'Context Window Length' must be a whole number of 1 or more",
			{ itemIndex, description: `The option resolved to ${JSON.stringify(value)}` },
		);
	}
	return windowSize;
}

export class RedisAgentMemoryChatMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Redis Agent Chat Memory',
		name: 'redisAgentMemoryChatMemory',
		icon: { light: 'file:../../icons/memory.svg', dark: 'file:../../icons/memory.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: 'Session memory',
		description:
			'Use Redis Agent Memory for chat history, with server-side summarization and long-term memory extraction',
		defaults: {
			name: 'Redis Agent Chat Memory',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
				Memory: ['Other memories'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/',
					},
				],
			},
		},

		inputs: [],

		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ['Memory'],
		credentials: [
			{
				name: AGENT_MEMORY_CREDENTIAL,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				required: true,
				default: '={{ $json.sessionId }}',
				description:
					'Unique identifier for the conversation session. Anyone who knows it can read and extend the session, so take it from an authenticated trigger or derive it from the user.',
				placeholder: 'e.g. session-user42-20240315',
			},
			{
				displayName: 'User ID',
				name: 'actorId',
				type: 'string',
				required: true,
				default: '',
				description:
					'Identifier of the user the conversation belongs to. Long-term memories extracted from the session are owned by this user.',
				placeholder: 'e.g. user-42',
			},
			// Top-level, not in Options: a top-level default is always evaluated,
			// so the switch alone is enough for recall to search the current message.
			{
				displayName: 'Recall Long-Term Memories',
				name: 'recallLongTermMemories',
				type: 'boolean',
				default: false,
				description:
					"Whether to search the user's long-term memories with the Recall Query on every turn and give the results to the model, before the summary and the recent turns",
			},
			{
				displayName: 'Recall Query',
				name: 'recallQuery',
				type: 'string',
				default: '={{ $json.chatInput }}',
				description: 'Text to search long-term memories with. Defaults to the current message.',
				displayOptions: {
					show: {
						recallLongTermMemories: [true],
					},
				},
			},
			{
				displayName: 'Recall Limit',
				name: 'recallLimit',
				type: 'number',
				default: 5,
				description: 'Max number of long-term memories to recall per turn',
				typeOptions: {
					minValue: 1,
					maxValue: 100,
				},
				displayOptions: {
					show: {
						recallLongTermMemories: [true],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Context Window Length',
						name: 'windowSize',
						type: 'number',
						default: DEFAULT_WINDOW_SIZE,
						description:
							'How many past interactions the model receives as context. The server already trims the session and folds older turns into the summary, so keep this at least as high as the number of turns the server retains. A turn outside the window that the summary does not cover yet is not sent to the model at all.',
						typeOptions: {
							minValue: 1,
							maxValue: 500,
						},
					},
					{
						displayName: 'Include Summary',
						name: 'includeSummary',
						type: 'boolean',
						default: true,
						description:
							'Whether to prepend the server-maintained summary of older conversation turns to the history',
					},
					{
						displayName: 'Namespace ID',
						name: 'namespaceId',
						type: 'string',
						default: '',
						description:
							'ID of the namespace to bind the session to. Long-term memories extracted from the session are placed in this namespace, and recall searches only this namespace.',
						placeholder: 'e.g. ns-product',
					},
					{
						displayName: 'Verify Session Owner',
						name: 'verifyOwner',
						type: 'boolean',
						default: false,
						description:
							'Whether to refuse to read or write a session whose owner on the server is not the User ID. Leave off for shared sessions, such as group chats.',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
		// Expressions can resolve to a number (such as a Telegram chat ID) or to
		// undefined (when the input has no such field), so coerce before trimming.
		const sessionId = String(this.getNodeParameter('sessionId', itemIndex) ?? '').trim();
		const actorId = String(this.getNodeParameter('actorId', itemIndex) ?? '').trim();
		const recall = this.getNodeParameter('recallLongTermMemories', itemIndex, false) as boolean;
		const options = this.getNodeParameter('options', itemIndex, {}) as MemoryOptions;
		const node = this.getNode();

		// n8n shows a sub-node error as "Error in sub-node …" with this message
		// as the description and the description dropped, so the message
		// carries the hint too.
		if (!sessionId) {
			throw new NodeOperationError(
				node,
				"'Session ID' is empty. Set a session ID, for example from the chat trigger output.",
				{ itemIndex, description: 'Set a session ID, for example from the chat trigger output' },
			);
		}
		if (!actorId) {
			throw new NodeOperationError(
				node,
				"'User ID' is empty. Set the ID of the user this conversation belongs to.",
				{ itemIndex, description: 'Set the ID of the user this conversation belongs to' },
			);
		}
		const windowSize = windowSizeFrom(options.windowSize, node, itemIndex);

		const request = await createAgentMemoryRequest(this, itemIndex);

		const history = new AgentMemoryChatHistory({
			sessionId,
			actorId,
			namespaceId: options.namespaceId?.trim() || undefined,
			verifyOwner: options.verifyOwner ?? false,
			node,
			itemIndex,
			request,
		});

		const memory = new SummaryAwareWindowedChatMemory(history, {
			windowSize,
			includeSummary: options.includeSummary ?? true,
			recall: recall
				? {
						query: String(this.getNodeParameter('recallQuery', itemIndex, '') ?? ''),
						limit: Number(this.getNodeParameter('recallLimit', itemIndex, 5)),
					}
				: undefined,
		});

		return supplyMemory(this, memory);
	}
}
