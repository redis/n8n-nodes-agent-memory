/*
 * Test harness code: it runs in Node during tests and is never published
 * (package.json "files" ships only dist). The n8n Cloud rules below guard
 * node code, which must not read the environment, spawn processes or embed
 * secrets. OWNER's password is not a secret: it opens a local, test-only n8n.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals, @n8n/community-nodes/no-dangerous-functions, @n8n/community-nodes/no-hardcoded-secrets */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const E2E_DIR = __dirname;
export const WORK_DIR = resolve(E2E_DIR, '.work');
export const COMPOSE_FILE = resolve(E2E_DIR, 'docker-compose.yml');

export const N8N_URL = `http://127.0.0.1:${process.env.E2E_N8N_PORT ?? '15678'}`;
export const LLM_STUB_URL = `http://127.0.0.1:${process.env.E2E_LLM_STUB_PORT ?? '18080'}`;

/**
 * The owner account preset by docker-compose.yml, for logging in from a
 * browser and for reading executions. The stack listens on 127.0.0.1 only
 * and holds test data only.
 */
export const OWNER = { email: 'e2e@example.com', password: 'E2e-test-password1' };

/** Webhook IDs and paths fixed in fixtures/workflows. */
export const CHAT_WEBHOOK_ID = '6f1d2c9e-0c4b-4f53-9a51-1f7d1b2a0010';
export const CHAT_WEBHOOK_PATH = `${CHAT_WEBHOOK_ID}/chat`;

/** Workflow IDs fixed in fixtures/workflows. */
export const MEMORY_MANAGER_WORKFLOW = 'e2eMemoryManager';
export const CHAT_AGENT_WORKFLOW = 'e2eChatAgent0001';
export const ACTION_NODE_WORKFLOW = 'e2eActionNode001';

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
				const probe = await fetch(`${N8N_URL}/webhook/${CHAT_WEBHOOK_PATH}`, {
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
	const { output } = await postJson<{ output: string }>(`/webhook/${CHAT_WEBHOOK_PATH}`, {
		action: 'sendMessage',
		sessionId,
		chatInput,
	});
	return output;
}

export async function loadPreviousSession(sessionId: string): Promise<SerializedMessage[]> {
	const { data } = await postJson<{ data: SerializedMessage[] }>(`/webhook/${CHAT_WEBHOOK_PATH}`, {
		action: 'loadPreviousSession',
		sessionId,
	});
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

/*
 * Reading executions. A webhook answers a failed run with only
 * `500 Error in workflow`; the error the editor shows on the red node is in
 * the saved execution, which n8n's internal REST API serves to a logged-in
 * user. The cookie is kept for the process; n8n allows five logins per
 * window, and each test file logs in once.
 */

const FINISHED = new Set(['success', 'error', 'crashed', 'canceled']);

let cookie: string | undefined;

async function login(): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${N8N_URL}/rest/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emailOrLdapLoginId: OWNER.email, password: OWNER.password }),
		});
		if (response.ok) {
			const match = /n8n-auth=[^;]+/.exec(response.headers.get('set-cookie') ?? '');
			if (!match) throw new Error('POST /rest/login answered without the n8n-auth cookie');
			return match[0];
		}
		if (response.status === 429 && attempt < 5) {
			const retryAfter = Number(response.headers.get('retry-after') ?? '1');
			await sleep(Math.min(retryAfter, 10) * 1000 + 250);
			continue;
		}
		throw new Error(`POST /rest/login returned ${response.status}: ${await response.text()}`);
	}
}

/** `GET /rest<path>` as the owner, unwrapping n8n's `{ data }` envelope. A rejected cookie earns one new login. */
async function restData<T>(path: string): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		cookie ??= await login();
		const response = await fetch(`${N8N_URL}/rest${path}`, { headers: { cookie } });
		const text = await response.text();
		if (response.status === 401 && attempt === 0) {
			cookie = undefined;
			continue;
		}
		if (!response.ok) throw new Error(`GET /rest${path} returned ${response.status}: ${text}`);
		return (JSON.parse(text) as { data: T }).data;
	}
}

export interface ExecutionSummary {
	id: string;
	workflowId: string;
	status: string;
	createdAt: string;
}

/** The error as n8n stores it; `message`, `description` and `httpCode` are what the editor shows. */
interface RawExecutionError {
	name?: string;
	message: string;
	description?: string;
	httpCode?: string;
	context?: { itemIndex?: number; [key: string]: unknown };
	node?: { name: string };
}

export interface Execution extends ExecutionSummary {
	data: {
		resultData: {
			error?: RawExecutionError;
			runData: Record<string, Array<{ error?: RawExecutionError }>>;
			lastNodeExecuted?: string;
		};
	};
}

/** The newest executions of a workflow, newest first. */
export async function executions(workflowId: string, limit = 10): Promise<ExecutionSummary[]> {
	const filter = encodeURIComponent(JSON.stringify({ workflowId }));
	const { results } = await restData<{ results: ExecutionSummary[] }>(
		`/executions?limit=${limit}&filter=${filter}`,
	);
	return results;
}

/**
 * Parses the `flatted` format n8n stores run data in: a JSON array whose
 * first item is the root; every string inside an object or array is the
 * index of another item. Same result as flatted's `parse`, without the
 * dependency.
 */
function unflatten(text: string): unknown {
	const items = JSON.parse(text) as unknown[];
	const revived = new Map<number, unknown>();
	const revive = (index: number): unknown => {
		if (revived.has(index)) return revived.get(index);
		const value = items[index];
		revived.set(index, value);
		if (value && typeof value === 'object') {
			const record = value as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				const ref = record[key];
				if (typeof ref === 'string') record[key] = revive(Number(ref));
			}
		}
		return value;
	};
	return revive(0);
}

/** One execution with its run data parsed. */
export async function execution(id: string): Promise<Execution> {
	const raw = await restData<Omit<Execution, 'data'> & { data: string | Execution['data'] }>(
		`/executions/${id}`,
	);
	const data = typeof raw.data === 'string' ? (unflatten(raw.data) as Execution['data']) : raw.data;
	return { ...raw, data };
}

/**
 * Polls until a finished execution of the workflow matches, then returns it
 * with its run data. n8n saves an execution right after the webhook answers,
 * so the default 10 s is ample.
 */
export async function waitForExecution(
	workflowId: string,
	matches: (summary: ExecutionSummary) => boolean,
	timeoutMs = 10_000,
): Promise<Execution> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const list = await executions(workflowId);
		const found = list.find((summary) => FINISHED.has(summary.status) && matches(summary));
		if (found) return await execution(found.id);
		if (Date.now() >= deadline) {
			const seen = list.map((summary) => `${summary.id}:${summary.status}`).join(', ') || 'none';
			throw new Error(
				`No matching finished execution of workflow ${workflowId} within ${timeoutMs} ms (seen: ${seen})`,
			);
		}
		await sleep(250);
	}
}

export interface ExecutionError {
	/** The node the editor marks red. */
	nodeName?: string;
	message: string;
	description?: string;
	/** A string, as n8n stores it: `'404'`. */
	httpCode?: string;
	itemIndex?: number;
	/** The error class: `NodeOperationError`, `NodeApiError`, ... */
	type?: string;
}

/**
 * The error the user sees on a failed execution: `resultData.error`, or the
 * first node run that recorded one.
 */
export function executionError(run: Execution): ExecutionError | undefined {
	const { resultData } = run.data;
	let raw = resultData.error;
	let nodeName = raw?.node?.name;
	if (!raw) {
		for (const [name, runs] of Object.entries(resultData.runData)) {
			const failed = runs.find((nodeRun) => nodeRun.error);
			if (failed?.error) {
				raw = failed.error;
				nodeName = name;
				break;
			}
		}
	}
	if (!raw) return undefined;
	return {
		nodeName: nodeName ?? resultData.lastNodeExecuted,
		message: raw.message,
		description: raw.description,
		httpCode: raw.httpCode,
		itemIndex: raw.context?.itemIndex,
		type: raw.name,
	};
}

export interface WebhookResponse {
	status: number;
	/** The body as text. */
	body: string;
}

/**
 * Posts to a webhook of the workflow and returns the response, without
 * throwing on a 500, together with the execution the call produced. The
 * execution is found by ID, so it is the right one even when the same
 * workflow ran a moment earlier. `path` is the part after `/webhook/`.
 */
export async function callWebhookAndWait(
	workflowId: string,
	path: string,
	body: object,
): Promise<{ response: WebhookResponse; execution: Execution }> {
	const [newest] = await executions(workflowId, 1);
	const response = await fetch(`${N8N_URL}/webhook/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const run = await waitForExecution(
		workflowId,
		(summary) => newest === undefined || Number(summary.id) > Number(newest.id),
	);
	return { response: { status: response.status, body: text }, execution: run };
}
