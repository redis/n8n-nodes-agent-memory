import { BaseChatHistory, BaseChatMemory, type Message } from '@n8n/ai-node-sdk';
import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { newIdempotencyKey, type AgentMemoryRequest } from '../shared/agentMemoryRequest';

export type { AgentMemoryRequest } from '../shared/agentMemoryRequest';

/** Message ID used for the synthetic message carrying the session summary. */
export const SUMMARY_MESSAGE_ID = 'agent-memory-summary';

/** Message ID used for the synthetic message carrying recalled long-term memories. */
export const RECALL_MESSAGE_ID = 'agent-memory-recall';

/** Message ID used for the synthetic message carrying a summary view's result. */
export const SUMMARY_VIEW_MESSAGE_ID = 'agent-memory-summary-view';

/**
 * Wire types for the Redis Agent Memory REST API (session memory subset).
 * Field names mirror the API's camelCase JSON. See the REST API reference:
 * https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/api-reference/
 *
 * Exported so the test client reads the same shape the node parses; a
 * recorded response is in test/unit/fixtures/session-with-summary.json.
 */
export type AgentMemoryRole = 'USER' | 'ASSISTANT' | 'SYSTEM';

export interface AgentMemorySessionEvent {
	eventId: string;
	actorId: string;
	sessionId: string;
	role: AgentMemoryRole;
	content: Array<{ text: string }>;
	createdAt: string;
}

/** The server's summary of the turns before `summarizedUpToEventId`. */
export interface AgentMemorySessionSummary {
	text: string;
	summarizedUpToEventId: string;
	summarizedEvents: number;
	createdAt: string;
	updatedAt: string;
	metadata?: Record<string, unknown>;
}

export interface AgentMemorySessionResponse {
	sessionId: string;
	ownerId: string;
	events: AgentMemorySessionEvent[];
	summary?: AgentMemorySessionSummary;
}

/** A long-term memory record, as far as recall reads it. */
export interface AgentMemoryRecord {
	memoryId: string;
	text: string;
	ownerId?: string;
	memoryType?: string;
	topics?: string[];
}

interface AgentMemorySearchResponse {
	items: AgentMemoryRecord[];
	nextCursor?: string;
}

/** A summary view result, as far as the chat memory reads it. */
interface AgentMemorySummaryViewResult {
	status?: string;
	value?: { text?: string; data?: unknown };
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
	/**
	 * The node this history serves and the item it runs for. An owner
	 * mismatch is then an n8n error on that node and item, so n8n reports it
	 * there whichever node called the history. Without a node it is a plain
	 * `Error` with the same message.
	 */
	node?: INode;
	itemIndex?: number;
	request: AgentMemoryRequest;
}

/** A session as the chat history sees it: the summary text and the retained turns. */
export interface AgentMemorySession {
	summary?: string;
	messages: Message[];
}

/** The error for a session whose owner on the server is not the configured user. */
function sessionOwnerMismatch(options: AgentMemoryChatHistoryOptions, ownerId: string): Error {
	const { sessionId, actorId, node, itemIndex } = options;
	const message =
		`Session "${sessionId}" belongs to user "${ownerId}", not to the configured User ID "${actorId}". ` +
		'Use a session ID derived from the user, or turn off "Verify Session Owner" for shared sessions.';
	if (!node) return new Error(message);
	return new NodeOperationError(node, message, {
		itemIndex,
		description:
			'The server names the first user who writes to a session its owner. ' +
			'Shared sessions, such as group chats, need "Verify Session Owner" off.',
	});
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
		return `/sessions/${encodeURIComponent(this.options.sessionId)}`;
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
		const { verifyOwner, actorId } = this.options;
		if (verifyOwner && session.ownerId && session.ownerId !== actorId) {
			throw sessionOwnerMismatch(this.options, session.ownerId);
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
			path: '/memories/search',
			body: {
				query,
				limit,
				filter: {
					ownerId: { eq: this.options.actorId },
					...(this.options.namespaceId ? { namespaceId: { eq: this.options.namespaceId } } : {}),
				},
			},
		});
		// The search is scoped to the user; should the store return another
		// user's record anyway, it must not reach the model.
		return (response?.items ?? []).filter(
			(record) => record.ownerId === undefined || record.ownerId === this.options.actorId,
		);
	}

	/**
	 * The summary a view holds for the configured user, as text, or undefined
	 * when the server has not computed it yet (`status` other than `READY`),
	 * it is empty, or the view no longer exists. The view must be grouped by
	 * user; the server checks the scope. A structured summary is sent as JSON.
	 */
	async getSummaryViewText(viewId: string): Promise<string | undefined> {
		const result = await this.options.request<AgentMemorySummaryViewResult>({
			method: 'GET',
			path: `/summary-views/${encodeURIComponent(viewId)}/result`,
			qs: { ownerId: this.options.actorId },
			allowNotFound: true,
		});
		if (result?.status !== 'READY') return undefined;
		const text = result.value?.text?.trim();
		if (text) return text;
		return result.value?.data !== undefined ? JSON.stringify(result.value.data) : undefined;
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

		// The server creates the session on its first event.
		await this.options.request({
			method: 'POST',
			path: `${this.sessionPath}/events`,
			body: {
				idempotencyKey: newIdempotencyKey(),
				actorId: this.options.actorId,
				role,
				content,
				createdAt: new Date().toISOString(),
				...(this.options.namespaceId ? { namespaceId: this.options.namespaceId } : {}),
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
	/** When set, each load also reads this summary view's result for the user and prepends it. */
	summaryViewId?: string;
}

/**
 * Windowed memory that puts the session summary in front of the recent turns.
 *
 * The AI Agent reads history through `loadMessages()`, so only the model sees
 * the summary and the recalled long-term memories. The SDK's
 * `WindowedChatMemory` is not reused: its only logic is the window, which
 * `loadMessages()` here must apply itself to avoid a second request for the
 * summary. The window rule is `lastTurns()`, and `saveTurn()` and `clear()`
 * are the SDK's few lines, owned here.
 *
 * The Agent's prompt starts with its own system message, so history lands
 * after it. Some chat models (Anthropic, Gemini) reject a system message in
 * any other position, so the history this returns has none: the recalled
 * memories, the summary and stored SYSTEM events reach the model as user
 * messages.
 */
export class SummaryAwareWindowedChatMemory extends BaseChatMemory {
	constructor(
		readonly chatHistory: AgentMemoryChatHistory,
		private readonly memoryOptions: SummaryAwareWindowedChatMemoryOptions,
	) {
		super();
	}

	async loadMessages(): Promise<Message[]> {
		const { recall, includeSummary, windowSize, summaryViewId } = this.memoryOptions;
		const query = recall?.query.trim();
		const [{ summary, messages }, recalled, briefing] = await Promise.all([
			this.chatHistory.getSession(),
			recall && query
				? this.chatHistory.searchLongTermMemories(query, recall.limit)
				: Promise.resolve([]),
			summaryViewId
				? this.chatHistory.getSummaryViewText(summaryViewId)
				: Promise.resolve(undefined),
		]);

		const windowed = lastTurns(messages, windowSize).map(
			(message): Message => (message.role === 'system' ? { ...message, role: 'user' } : message),
		);

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
		if (briefing) {
			leading.push({
				id: SUMMARY_VIEW_MESSAGE_ID,
				role: 'user',
				content: [
					{
						type: 'text',
						text: `What is known about the user, summarized from earlier conversations:\n${briefing}`,
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

	async saveTurn(input: string, output: string): Promise<void> {
		await this.chatHistory.addMessages([
			{ role: 'user', content: [{ type: 'text', text: input }] },
			{ role: 'assistant', content: [{ type: 'text', text: output }] },
		]);
	}

	async clear(): Promise<void> {
		await this.chatHistory.clear();
	}
}

/**
 * The window rule: the last `windowSize` interactions, two messages each.
 * Applied to the turns the server retains (see the class comment).
 */
function lastTurns(messages: Message[], windowSize: number): Message[] {
	return messages.slice(-windowSize * 2);
}
