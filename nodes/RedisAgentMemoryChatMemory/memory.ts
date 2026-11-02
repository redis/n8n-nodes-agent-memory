import { BaseChatHistory, WindowedChatMemory, type Message } from '@n8n/ai-node-sdk';
import type { AgentMemoryRequest } from '../shared/agentMemoryRequest';

export type { AgentMemoryRequest } from '../shared/agentMemoryRequest';

/** Message ID used for the synthetic message carrying the session summary. */
export const SUMMARY_MESSAGE_ID = 'agent-memory-summary';

/** Message ID used for the synthetic message carrying recalled long-term memories. */
export const RECALL_MESSAGE_ID = 'agent-memory-recall';

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

/** A long-term memory record, as far as recall reads it. */
export interface AgentMemoryRecord {
	id: string;
	text: string;
	memoryType?: string;
	topics?: string[];
}

interface AgentMemorySearchResponse {
	items: AgentMemoryRecord[];
	nextPageToken?: string;
}

export interface AgentMemoryChatHistoryOptions {
	sessionId: string;
	actorId: string;
	namespaceId?: string;
	/**
	 * When true, reads and writes fail if the server says the session belongs
	 * to a different user than `actorId`. Leave off for shared sessions.
	 */
	verifyOwner?: boolean;
	request: AgentMemoryRequest;
}

/** A session as the chat history sees it: the summary text and the retained turns. */
export interface AgentMemorySession {
	summary?: string;
	messages: Message[];
}

/** Thrown when `verifyOwner` is on and the session's owner is not the configured user. */
export class SessionOwnerMismatchError extends Error {
	constructor(
		readonly sessionId: string,
		readonly ownerId: string,
		readonly actorId: string,
	) {
		super(
			`Session "${sessionId}" belongs to user "${ownerId}", not to the configured User ID "${actorId}". ` +
				'Use a session ID derived from the user, or turn off "Verify Session Owner" for shared sessions.',
		);
		this.name = 'SessionOwnerMismatchError';
	}
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
 * - The server sets a session's `ownerId` from its first event and accepts
 *   events from any actor after that. With `verifyOwner`, this class checks
 *   the owner itself, on the first read or write of each instance.
 */
export class AgentMemoryChatHistory extends BaseChatHistory {
	/** True once the owner check passed, or the session was found not to exist. */
	private ownerChecked = false;

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
		if (!session) {
			this.ownerChecked = true;
			return { messages: [] };
		}
		this.assertOwner(session);

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

	private assertOwner(session: AgentMemorySessionResponse): void {
		const { verifyOwner, sessionId, actorId } = this.options;
		if (verifyOwner && session.ownerId && session.ownerId !== actorId) {
			throw new SessionOwnerMismatchError(sessionId, session.ownerId, actorId);
		}
		this.ownerChecked = true;
	}

	async getMessages(): Promise<Message[]> {
		return (await this.getSession()).messages;
	}

	/**
	 * Semantic search over the user's long-term memories, scoped to the
	 * configured user and, when set, the namespace.
	 */
	async searchLongTermMemories(query: string, limit: number): Promise<AgentMemoryRecord[]> {
		const response = await this.options.request<AgentMemorySearchResponse>({
			method: 'POST',
			path: '/long-term-memory/search',
			body: {
				text: query,
				limit,
				filter: {
					ownerId: { eq: this.options.actorId },
					...(this.options.namespaceId
						? { namespaceRef: { eq: this.options.namespaceId } }
						: {}),
				},
			},
		});
		return response?.items ?? [];
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

		// A write-only path (the Memory Manager's Insert) has not read the
		// session yet, so the owner check needs one read first.
		if (this.options.verifyOwner && !this.ownerChecked) await this.getSession();

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
	/** When set, each load also searches long-term memory and prepends the results. */
	recall?: { query: string; limit: number };
}

/**
 * Windowed memory that puts the session summary in front of the recent turns.
 *
 * The AI Agent reads history through `loadMessages()`, so only the model sees
 * the summary and the recalled long-term memories. `WindowedChatMemory` alone
 * keeps the last `windowSize * 2` messages; this variant windows the turns,
 * then adds the recalled memories and the summary as leading user messages.
 *
 * The Agent's prompt starts with its own system message, so history lands
 * after it. Some chat models (Anthropic, Gemini) reject a system message in
 * any other position, so the history this returns has none: the recalled
 * memories, the summary and stored SYSTEM events reach the model as user
 * messages.
 */
export class SummaryAwareWindowedChatMemory extends WindowedChatMemory {
	constructor(
		private readonly agentMemoryHistory: AgentMemoryChatHistory,
		private readonly memoryOptions: SummaryAwareWindowedChatMemoryOptions,
	) {
		super(agentMemoryHistory, { windowSize: memoryOptions.windowSize });
	}

	async loadMessages(): Promise<Message[]> {
		const { recall, includeSummary, windowSize } = this.memoryOptions;
		const query = recall?.query.trim();
		const [{ summary, messages }, recalled] = await Promise.all([
			this.agentMemoryHistory.getSession(),
			recall && query
				? this.agentMemoryHistory.searchLongTermMemories(query, recall.limit)
				: Promise.resolve([]),
		]);

		const windowed = messages
			.slice(-windowSize * 2)
			.map((message): Message => (message.role === 'system' ? { ...message, role: 'user' } : message));

		const leading: Message[] = [];
		if (recalled.length > 0) {
			leading.push({
				id: RECALL_MESSAGE_ID,
				role: 'user',
				content: [
					{
						type: 'text',
						text: `Long-term memories about the user, from earlier conversations:\n${recalled
							.map((record) => `- ${record.text}`)
							.join('\n')}`,
					},
				],
			});
		}
		if (includeSummary && summary) {
			leading.push({
				id: SUMMARY_MESSAGE_ID,
				role: 'user',
				content: [{ type: 'text', text: `Summary of the earlier conversation:\n${summary}` }],
			});
		}

		return [...leading, ...windowed];
	}
}
