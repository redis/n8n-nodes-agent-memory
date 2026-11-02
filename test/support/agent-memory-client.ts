import {
	NOT_FOUND_ERROR_TYPE,
	type AgentMemoryRequest,
} from '../../nodes/shared/agentMemoryRequest';
import type { AgentMemoryTestConfig } from './env';

export class AgentMemoryHttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		method: string,
		path: string,
	) {
		super(`${method} ${path} returned ${status}: ${body}`);
	}
}

/** Same rule as the node's adapter: only the API's own not-found body counts. */
function isResourceNotFound(body: string): boolean {
	try {
		return (JSON.parse(body) as { type?: unknown }).type === NOT_FOUND_ERROR_TYPE;
	} catch {
		return false;
	}
}

export interface StoredSessionEvent {
	eventId: string;
	actorId: string;
	role: 'USER' | 'ASSISTANT' | 'SYSTEM';
	content: Array<{ text: string }>;
}

export interface StoredSession {
	sessionId: string;
	ownerId: string;
	events: StoredSessionEvent[];
	summary?: { text: string };
}

/**
 * Minimal Agent Memory client for tests: the same request contract the node
 * uses, implemented with `fetch`, plus helpers to read and clean up data.
 */
export class AgentMemoryTestClient {
	private readonly createdSessions = new Set<string>();
	private readonly createdOwners = new Set<string>();

	constructor(private readonly config: AgentMemoryTestConfig) {}

	readonly request: AgentMemoryRequest = async <T>({
		method,
		path,
		body,
		allowNotFound,
	}: Parameters<AgentMemoryRequest>[0]) => {
		const url = `${this.config.serverUrl}/v1/stores/${encodeURIComponent(this.config.storeId)}${path}`;
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				Accept: 'application/json',
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await response.text();
		if (allowNotFound && response.status === 404 && isResourceNotFound(text)) return undefined;
		if (!response.ok) throw new AgentMemoryHttpError(response.status, text, method, path);
		return (text ? JSON.parse(text) : undefined) as T | undefined;
	};

	/** One raw call, for tests that pin a status code or an error body. */
	async probe(method: string, path: string): Promise<{ status: number; body: string }> {
		const url = `${this.config.serverUrl}/v1/stores/${encodeURIComponent(this.config.storeId)}${path}`;
		const response = await fetch(url, {
			method,
			headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: 'application/json' },
		});
		return { status: response.status, body: await response.text() };
	}

	/** Records a session and its owner for `cleanup()`. */
	track(sessionId: string, ownerId: string): void {
		this.createdSessions.add(sessionId);
		this.createdOwners.add(ownerId);
	}

	async getSession(sessionId: string): Promise<StoredSession | undefined> {
		return await this.request<StoredSession>({
			method: 'GET',
			path: `/session-memory/${encodeURIComponent(sessionId)}`,
			allowNotFound: true,
		});
	}

	/**
	 * Deletes every tracked session, then the long-term memories extracted for
	 * the tracked owners. Extraction is asynchronous, so a memory extracted
	 * after this runs can survive; the run prefix keeps it out of other runs.
	 */
	async cleanup(): Promise<void> {
		const failures: unknown[] = [];

		for (const sessionId of this.createdSessions) {
			await this.request({
				method: 'DELETE',
				path: `/session-memory/${encodeURIComponent(sessionId)}`,
				allowNotFound: true,
			}).catch((error: unknown) => failures.push(error));
		}

		if (this.createdOwners.size > 0) {
			await this.deleteLongTermMemories([...this.createdOwners]).catch((error: unknown) =>
				failures.push(error),
			);
		}

		this.createdSessions.clear();
		this.createdOwners.clear();
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Agent Memory cleanup: ${failures.length} request(s) failed`,
			);
		}
	}

	private async deleteLongTermMemories(ownerIds: string[]): Promise<void> {
		// Re-read the first page after each delete, since deleting shifts the
		// pages. The bound stops a loop if deletes silently fail.
		for (let batch = 0; batch < 50; batch++) {
			const page = await this.request<{ items: Array<{ id: string }> }>({
				method: 'POST',
				path: '/long-term-memory/search',
				body: { filter: { ownerId: { in: ownerIds } }, limit: 100 },
			});
			const ids = (page?.items ?? []).map((item) => item.id);
			if (ids.length === 0) return;
			await this.request({
				method: 'DELETE',
				path: '/long-term-memory',
				body: { memoryIds: ids },
			});
		}
	}
}
