import type { INodeType, INodeTypeDescription, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { supplyMemory } from '@n8n/ai-node-sdk';
import { AgentMemoryChatHistory, SummaryAwareWindowedChatMemory } from './memory';
import { AGENT_MEMORY_CREDENTIAL, createAgentMemoryRequest } from '../shared/agentMemoryRequest';

type MemoryOptions = {
	windowSize?: number;
	namespaceId?: string;
	includeSummary?: boolean;
	verifyOwner?: boolean;
	recallLongTermMemories?: boolean;
	recallQuery?: string;
	recallLimit?: number;
};

/**
 * Default Context Window Length, in interactions. Generous on purpose: the
 * server already trims the session and folds older turns into the summary,
 * so a small window here would hide turns that the summary does not cover
 * yet. See docs/research.md §9.3.
 */
const DEFAULT_WINDOW_SIZE = 50;

export class RedisAgentMemoryChatMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Redis Agent Chat Memory',
		name: 'redisAgentMemoryChatMemory',
		icon: { light: 'file:memory.svg', dark: 'file:memory.dark.svg' },
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
						displayName: 'Recall Limit',
						name: 'recallLimit',
						type: 'number',
						default: 5,
						description:
							'Max number of long-term memories to recall per turn. Used only when "Recall Long-Term Memories" is on.',
						typeOptions: {
							minValue: 1,
							maxValue: 100,
						},
					},
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
						description:
							'Text to search long-term memories with. Used only when "Recall Long-Term Memories" is on.',
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
		const options = this.getNodeParameter('options', itemIndex, {}) as MemoryOptions;

		if (!sessionId) {
			throw new NodeOperationError(this.getNode(), "'Session ID' is empty", {
				itemIndex,
				description: 'Set a session ID, for example from the chat trigger output',
			});
		}
		if (!actorId) {
			throw new NodeOperationError(this.getNode(), "'User ID' is empty", {
				itemIndex,
				description: 'Set the ID of the user this conversation belongs to',
			});
		}

		const request = await createAgentMemoryRequest(this, itemIndex);

		const history = new AgentMemoryChatHistory({
			sessionId,
			actorId,
			namespaceId: options.namespaceId?.trim() || undefined,
			verifyOwner: options.verifyOwner ?? false,
			request,
		});

		const memory = new SummaryAwareWindowedChatMemory(history, {
			windowSize: options.windowSize ?? DEFAULT_WINDOW_SIZE,
			includeSummary: options.includeSummary ?? true,
			recall: options.recallLongTermMemories
				? {
						query: String(options.recallQuery ?? ''),
						limit: options.recallLimit ?? 5,
					}
				: undefined,
		});

		return supplyMemory(this, memory);
	}
}
