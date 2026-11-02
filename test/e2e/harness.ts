/*
 * Test harness code: it runs in Node during tests and is never published
 * (package.json "files" ships only dist). The n8n Cloud rules below guard
 * node code, which must not read the environment or spawn processes.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals, @n8n/community-nodes/no-dangerous-functions */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const E2E_DIR = __dirname;
export const WORK_DIR = resolve(E2E_DIR, '.work');
export const COMPOSE_FILE = resolve(E2E_DIR, 'docker-compose.yml');

export const N8N_URL = `http://127.0.0.1:${process.env.E2E_N8N_PORT ?? '15678'}`;
export const LLM_STUB_URL = `http://127.0.0.1:${process.env.E2E_LLM_STUB_PORT ?? '18080'}`;

/** Webhook IDs and paths fixed in fixtures/workflows. */
export const CHAT_WEBHOOK_ID = '6f1d2c9e-0c4b-4f53-9a51-1f7d1b2a0010';

export function compose(args: string[], options: { quiet?: boolean } = {}): string {
	return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
		encoding: 'utf8',
		stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
	});
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Polls until n8n is ready and the chat workflow's webhook is registered. */
export async function waitForN8n(timeoutMs = 180_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastState = 'not started';
	while (Date.now() < deadline) {
		try {
			const ready = await fetch(`${N8N_URL}/healthz/readiness`);
			if (ready.ok) {
				// An unknown action is answered by the trigger once its webhook is live.
				const probe = await fetch(`${N8N_URL}/webhook/${CHAT_WEBHOOK_ID}/chat`, {
					method: 'OPTIONS',
				});
				if (probe.status !== 404) return;
				lastState = 'ready, but the chat webhook is not registered yet';
			} else {
				lastState = `readiness returned ${ready.status}`;
			}
		} catch (error) {
			lastState = (error as Error).message;
		}
		await sleep(1_000);
	}
	throw new Error(`n8n did not become ready within ${timeoutMs} ms (${lastState})`);
}

export async function postJson<T>(path: string, body: object): Promise<T> {
	const response = await fetch(`${N8N_URL}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${text}`);
	return JSON.parse(text) as T;
}

/** A message as LangChain serialises it (`toJSON()`), the shape n8n returns. */
export interface SerializedMessage {
	id: string[];
	kwargs: { content: unknown };
}

export function messageType(message: SerializedMessage): string {
	return message.id[message.id.length - 1];
}

export function messageText(message: SerializedMessage): string {
	const { content } = message.kwargs;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map((part: { text?: string }) => part.text ?? '').join('');
	}
	return '';
}

export async function sendChatMessage(sessionId: string, chatInput: string): Promise<string> {
	const { output } = await postJson<{ output: string }>(`/webhook/${CHAT_WEBHOOK_ID}/chat`, {
		action: 'sendMessage',
		sessionId,
		chatInput,
	});
	return output;
}

export async function loadPreviousSession(sessionId: string): Promise<SerializedMessage[]> {
	const { data } = await postJson<{ data: SerializedMessage[] }>(
		`/webhook/${CHAT_WEBHOOK_ID}/chat`,
		{
			action: 'loadPreviousSession',
			sessionId,
		},
	);
	return data;
}

export interface StubRequest {
	messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
}

/** The text of an OpenAI message, whose content is a string or a list of parts. */
export function stubMessageText(message: StubRequest['messages'][number]): string {
	const { content } = message;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map((part: { text?: string }) => part.text ?? '').join('');
	}
	return '';
}

export async function stubRequests(): Promise<StubRequest[]> {
	return (await (await fetch(`${LLM_STUB_URL}/_requests`)).json()) as StubRequest[];
}

export async function resetStub(): Promise<void> {
	await fetch(`${LLM_STUB_URL}/_requests`, { method: 'DELETE' });
}

export async function restartN8n(): Promise<void> {
	compose(['restart', 'n8n'], { quiet: true });
	await waitForN8n();
}
