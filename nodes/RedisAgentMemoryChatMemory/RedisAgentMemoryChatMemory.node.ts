import type {
	IHttpRequestMethods,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { supplyMemory } from '@n8n/ai-node-sdk';
import {
	AgentMemoryChatHistory,
	SummaryAwareWindowedChatMemory,
	type AgentMemoryRequest,
} from './memory';

type MemoryOptions = {
	windowSize?: number;
	namespaceId?: string;
	includeSummary?: boolean;
};

export class RedisAgentMemoryChatMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Redis Agent Memory',
		name: 'redisAgentMemoryChatMemory',
		icon: { light: 'file:memory.svg', dark: 'file:memory.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: 'Session memory',
		description:
			'Use Redis Agent Memory for chat history, with server-side summarization and long-term memory extraction',
		defaults: {
			name: 'Redis Agent Memory',
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
				name: 'redisAgentMemoryApi',
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
				description: 'Unique identifier for the conversation session',
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
						default: 10,
						description: 'How many past interactions the model receives as context',
						typeOptions: {
							minValue: 1,
							maxValue: 100,
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
							'ID of the namespace to bind the session to. Long-term memories extracted from the session are placed in this namespace.',
						placeholder: 'e.g. ns-product',
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

		const credentials = await this.getCredentials<{ serverUrl: string; storeId: string }>(
			'redisAgentMemoryApi',
		);
		const baseUrl = `${credentials.serverUrl.replace(/\/+$/, '')}/v1/stores/${encodeURIComponent(
			credentials.storeId,
		)}`;

		const request: AgentMemoryRequest = async ({ method, path, body, allowNotFound }) => {
			try {
				return await this.helpers.httpRequestWithAuthentication.call(this, 'redisAgentMemoryApi', {
					method: method as IHttpRequestMethods,
					url: `${baseUrl}${path}`,
					body,
					json: true,
				});
			} catch (error) {
				const apiError = new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
				if (allowNotFound && String(apiError.httpCode) === '404') return undefined;
				throw apiError;
			}
		};

		const history = new AgentMemoryChatHistory({
			sessionId,
			actorId,
			namespaceId: options.namespaceId?.trim() || undefined,
			request,
		});

		const memory = new SummaryAwareWindowedChatMemory(history, {
			windowSize: options.windowSize ?? 10,
			includeSummary: options.includeSummary ?? true,
		});

		return supplyMemory(this, memory);
	}
}
