import { BaseChatHistory, WindowedChatMemory, type Message } from '@n8n/ai-node-sdk';

/** Message ID used for the synthetic message carrying the session summary. */
export const SUMMARY_MESSAGE_ID = 'agent-memory-summary';

/**
 * Wire types for the Redis Agent Memory REST API (session memory subset).
 * Field names mirror the API's camelCase JSON. See the REST API reference:
 * https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/api-reference/
 */
type AgentMemoryRole = 'USER' | 'ASSISTANT' | 'SYSTEM';

interface AgentMemorySessionEvent {
	eventId: string;
	actorId: string;
	sessionId: string;
	role: AgentMemoryRole;
	content: Array<{ text: string }>;
	createdAt: string;
}

interface AgentMemorySessionResponse {
	sessionId: string;
	ownerId: string;
	events: AgentMemorySessionEvent[];
	summary?: { text: string; summarizedUpToEventId: string };
}

export type AgentMemoryRequest = <T>(options: {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: object;
	/** When true, a 404 resolves to `undefined` instead of throwing. */
	allowNotFound?: boolean;
}) => Promise<T | undefined>;

export interface AgentMemoryChatHistoryOptions {
	sessionId: string;
	actorId: string;
	namespaceId?: string;
	request: AgentMemoryRequest;
}

/** A session as the chat history sees it: the summary text and the retained turns. */
export interface AgentMemorySession {
	summary?: string;
	messages: Message[];
}

const toAgentMemoryRole: Partial<Record<Message['role'], AgentMemoryRole>> = {
	user: 'USER',
	assistant: 'ASSISTANT',
	system: 'SYSTEM',
};

const fromAgentMemoryRole: Record<AgentMemoryRole, Message['role']> = {
	USER: 'user',
	ASSISTANT: 'assistant',
	SYSTEM: 'system',
};

/**
 * Chat history backed by Redis Agent Memory session memory.
 *
 * - Reads return the retained session events. The server-maintained summary
 *   is available through `getSession()`, but `getMessages()` leaves it out:
 *   the Chat Trigger and the Chat Memory Manager read `getMessages()`
 *   directly, and would otherwise show the summary or store it back.
 * - Writes append one session event per message. The server extracts
 *   long-term memories from these events asynchronously.
 */
export class AgentMemoryChatHistory extends BaseChatHistory {
	constructor(private readonly options: AgentMemoryChatHistoryOptions) {
		super();
	}

	private get sessionPath(): string {
		return `/session-memory/${encodeURIComponent(this.options.sessionId)}`;
	}

	async getSession(): Promise<AgentMemorySession> {
		const session = await this.options.request<AgentMemorySessionResponse>({
			method: 'GET',
			path: this.sessionPath,
			allowNotFound: true,
		});
		if (!session) return { messages: [] };

		const messages: Message[] = [];
		for (const event of session.events ?? []) {
			const text = (event.content ?? []).map((part) => part.text).join('\n');
			if (!text) continue;
			messages.push({
				id: event.eventId,
				role: fromAgentMemoryRole[event.role] ?? 'user',
				content: [{ type: 'text', text }],
			});
		}

		return { summary: session.summary?.text || undefined, messages };
	}

	async getMessages(): Promise<Message[]> {
		return (await this.getSession()).messages;
	}

	async addMessage(message: Message): Promise<void> {
		const role = toAgentMemoryRole[message.role];
		// Tool results are not stored as session events.
		if (!role) return;
		// Neither are the assistant messages that request tool calls. When tools
		// ran, the Agent saves them alongside the final answer; their text (such
		// as "Calling calculator with input: ...") is not part of the conversation.
		if (
			message.content.some((part) => part.type === 'tool-call' || part.type === 'invalid-tool-call')
		) {
			return;
		}

		const content = message.content
			.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
			.map((part) => ({ text: part.text }))
			.filter((part) => part.text.length > 0);
		if (content.length === 0) return;

		await this.options.request({
			method: 'POST',
			path: '/session-memory/events',
			body: {
				sessionId: this.options.sessionId,
				actorId: this.options.actorId,
				role,
				content,
				createdAt: new Date().toISOString(),
				...(this.options.namespaceId
					? { namespaceRef: { namespaceId: this.options.namespaceId } }
					: {}),
			},
		});
	}

	async clear(): Promise<void> {
		await this.options.request({
			method: 'DELETE',
			path: this.sessionPath,
			allowNotFound: true,
		});
	}
}

export interface SummaryAwareWindowedChatMemoryOptions {
	windowSize: number;
	includeSummary: boolean;
}

/**
 * Windowed memory that puts the session summary in front of the recent turns.
 *
 * The AI Agent reads history through `loadMessages()`, so only the model sees
 * the summary. `WindowedChatMemory` alone keeps the last `windowSize * 2`
 * messages; this variant windows the turns, then adds the summary as a
 * leading user message.
 *
 * The Agent's prompt starts with its own system message, so history lands
 * after it. Some chat models (Anthropic, Gemini) reject a system message in
 * any other position, so the history this returns has none: the summary and
 * stored SYSTEM events reach the model as user messages.
 */
export class SummaryAwareWindowedChatMemory extends WindowedChatMemory {
	constructor(
		private readonly agentMemoryHistory: AgentMemoryChatHistory,
		private readonly memoryOptions: SummaryAwareWindowedChatMemoryOptions,
	) {
		super(agentMemoryHistory, { windowSize: memoryOptions.windowSize });
	}

	async loadMessages(): Promise<Message[]> {
		const { summary, messages } = await this.agentMemoryHistory.getSession();
		const windowed = messages
			.slice(-this.memoryOptions.windowSize * 2)
			.map((message): Message => (message.role === 'system' ? { ...message, role: 'user' } : message));
		if (!this.memoryOptions.includeSummary || !summary) return windowed;

		return [
			{
				id: SUMMARY_MESSAGE_ID,
				role: 'user',
				content: [{ type: 'text', text: `Summary of the earlier conversation:\n${summary}` }],
			},
			...windowed,
		];
	}
}
