/*
 * Test harness code: it runs in Node during tests and is never published
 * (package.json "files" ships only dist). The n8n Cloud rules below guard
 * node code, which must not touch the file system or wait with timers. The
 * owner password comes from stack.ts and opens a local, test-only n8n.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { N8N_URL, WORK_DIR } from './harness';
import { OWNER } from './stack';

/**
 * A client for n8n's internal REST API, the one the editor uses, so a test
 * file can create its own workflows in the running stack, call them, and
 * read the executions they leave behind.
 *
 * Typical use:
 *
 *   const workflow = await createWorkflow({ name, nodes, connections });
 *   const { response, execution } = await callWebhookAndWait(
 *     workflow.id, workflow.webhooks['Webhook'], { sessionId: 'x' });
 *   expect(executionError(execution)?.message).toBe("'Session ID' is empty");
 *   await deleteWorkflow(workflow.id);
 *
 * Login: `POST /rest/login` sets the `n8n-auth` cookie. n8n allows five
 * logins per window, so the cookie is kept in memory and in
 * `.work/n8n-auth-cookie`, shared by every test process on this stack.
 */

const WEBHOOK_NODE = 'n8n-nodes-base.webhook';
const CHAT_TRIGGER_NODE = '@n8n/n8n-nodes-langchain.chatTrigger';
const COOKIE_FILE = resolve(WORK_DIR, 'n8n-auth-cookie');
const FINISHED = new Set(['success', 'error', 'crashed', 'canceled']);

let cookie: string | undefined;

async function sleep(ms: number): Promise<void> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function readCachedCookie(): string | undefined {
	try {
		return readFileSync(COOKIE_FILE, 'utf8').trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Writes through a temporary file, since several test processes may log in at once. */
function cacheCookie(value: string): void {
	mkdirSync(WORK_DIR, { recursive: true });
	const temp = `${COOKIE_FILE}.${randomBytes(4).toString('hex')}`;
	writeFileSync(temp, value);
	renameSync(temp, COOKIE_FILE);
}

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

async function authCookie(): Promise<string> {
	cookie ??= readCachedCookie();
	if (!cookie) {
		cookie = await login();
		cacheCookie(cookie);
	}
	return cookie;
}

export interface RestResponse<T> {
	status: number;
	text: string;
	json: T | undefined;
}

/**
 * One call to `/rest<path>`, logged in as the preset owner. Never throws on
 * an HTTP error. A rejected cookie (401), for example after a fresh stack,
 * triggers one new login.
 */
export async function n8nRest<T = unknown>(
	method: string,
	path: string,
	body?: unknown,
): Promise<RestResponse<T>> {
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${N8N_URL}/rest${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', cookie: await authCookie() },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		if (response.status === 401 && attempt === 0) {
			cookie = undefined;
			rmSync(COOKIE_FILE, { force: true });
			continue;
		}
		return { status: response.status, text, json: parseJson(text) as T | undefined };
	}
}

/** `n8nRest`, but throws on an HTTP error and unwraps n8n's `{ data }` envelope. */
async function restData<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await n8nRest<{ data: T }>(method, path, body);
	if (response.status >= 400 || response.json === undefined) {
		throw new Error(
			`${method} /rest${path} returned ${response.status}: ${response.text.slice(0, 500)}`,
		);
	}
	return response.json.data;
}

export interface WorkflowNode {
	name: string;
	type: string;
	typeVersion: number;
	parameters?: Record<string, unknown>;
	credentials?: Record<string, { id: string; name: string }>;
	/** Defaults to `node-<index>`. */
	id?: string;
	/** Defaults to a row along the x axis. */
	position?: [number, number];
	/** Defaults to a fresh UUID on Webhook and Chat Trigger nodes. */
	webhookId?: string;
	[key: string]: unknown;
}

/** The same shape as the files in fixtures/workflows, without `id` and `active`. */
export interface WorkflowSpec {
	name: string;
	nodes: WorkflowNode[];
	connections: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

export interface CreatedWorkflow {
	id: string;
	name: string;
	/** Put before the `path` of every Webhook node, so paths never clash across workflows. */
	webhookPrefix: string;
	/**
	 * Webhook path by trigger node name, without `/webhook/`: Webhook nodes
	 * get `<prefix>/<path>`, Chat Triggers get `<webhookId>/chat`.
	 */
	webhooks: Record<string, string>;
}

/**
 * Activation returns before n8n registers the webhooks (about 100 ms later).
 * This polls with a method the webhook does not serve, which cannot start an
 * execution: n8n answers an unknown path with "The requested webhook ... is
 * not registered" and a known path with "Did you mean to make a POST
 * request?", or with the chat page for a public Chat Trigger.
 */
async function waitForWebhook(path: string, method: string, timeoutMs = 15_000): Promise<void> {
	const probeMethod = method.toUpperCase() === 'GET' ? 'POST' : 'GET';
	const deadline = Date.now() + timeoutMs;
	let last = '';
	while (Date.now() < deadline) {
		const response = await fetch(`${N8N_URL}/webhook/${path}`, { method: probeMethod });
		last = await response.text();
		if (!(response.status === 404 && last.includes('The requested webhook'))) return;
		await sleep(100);
	}
	throw new Error(
		`Webhook ${path} was not registered within ${timeoutMs} ms: ${last.slice(0, 200)}`,
	);
}

/**
 * Creates the workflow, publishes it and waits until its webhooks answer.
 * Webhook node paths are prefixed (see `CreatedWorkflow.webhookPrefix`);
 * Chat Triggers are unique through their `webhookId`.
 */
export async function createWorkflow(
	workflow: WorkflowSpec,
	options: { webhookPrefix?: string } = {},
): Promise<CreatedWorkflow> {
	const webhookPrefix = options.webhookPrefix ?? `e2e-${randomBytes(4).toString('hex')}`;
	const webhooks: Record<string, string> = {};
	const probes: Array<{ path: string; method: string }> = [];

	const nodes = workflow.nodes.map((node, index) => {
		const copy: WorkflowNode = { ...node };
		copy.id ??= `node-${index + 1}`;
		copy.position ??= [index * 220, 0];
		if (node.type === WEBHOOK_NODE) {
			copy.webhookId ??= randomUUID();
			const parameters = { ...copy.parameters };
			const own = String(parameters.path ?? copy.webhookId).replace(/^\/+/, '');
			const path = `${webhookPrefix}/${own}`;
			parameters.path = path;
			copy.parameters = parameters;
			webhooks[copy.name] = path;
			probes.push({ path, method: String(parameters.httpMethod ?? 'GET') });
		} else if (node.type === CHAT_TRIGGER_NODE) {
			copy.webhookId ??= randomUUID();
			webhooks[copy.name] = `${copy.webhookId}/chat`;
			// Only a public Chat Trigger registers a webhook.
			if (copy.parameters?.public === true) {
				probes.push({ path: webhooks[copy.name], method: 'POST' });
			}
		}
		return copy;
	});

	const created = await restData<{ id: string; versionId: string }>('POST', '/workflows', {
		name: workflow.name,
		nodes,
		connections: workflow.connections,
		settings: {
			executionOrder: 'v1',
			// Tests read the executions, so keep them whatever the instance default.
			saveDataSuccessExecution: 'all',
			saveDataErrorExecution: 'all',
			...workflow.settings,
		},
	});
	await restData('POST', `/workflows/${created.id}/activate`, { versionId: created.versionId });
	for (const probe of probes) await waitForWebhook(probe.path, probe.method);

	return { id: created.id, name: workflow.name, webhookPrefix, webhooks };
}

/** Deactivates, archives and deletes the workflow. A workflow that is already gone is fine. */
export async function deleteWorkflow(id: string): Promise<void> {
	await n8nRest('POST', `/workflows/${id}/deactivate`);
	const archived = await n8nRest('POST', `/workflows/${id}/archive`);
	if (archived.status === 404) return;
	const deleted = await n8nRest('DELETE', `/workflows/${id}`);
	if (deleted.status >= 400) {
		throw new Error(`DELETE /rest/workflows/${id} returned ${deleted.status}: ${deleted.text}`);
	}
}

export interface ExecutionSummary {
	id: string;
	workflowId: string;
	mode: string;
	status: string;
	createdAt: string;
	startedAt: string | null;
	stoppedAt: string | null;
}

/** The error as n8n stores it; `message`, `description` and `httpCode` are what the editor shows. */
export interface RawExecutionError {
	name?: string;
	message: string;
	description?: string;
	httpCode?: string;
	level?: string;
	context?: { itemIndex?: number; [key: string]: unknown };
	node?: { name: string; type?: string };
	[key: string]: unknown;
}

export interface NodeRun {
	startTime: number;
	executionTime: number;
	executionStatus?: string;
	error?: RawExecutionError;
	/** Output items by connection type, then by output index. */
	data?: Record<string, Array<Array<{ json: Record<string, unknown> }> | null>>;
	[key: string]: unknown;
}

export interface Execution extends ExecutionSummary {
	finished?: boolean;
	data: {
		resultData: {
			error?: RawExecutionError;
			runData: Record<string, NodeRun[]>;
			lastNodeExecuted?: string;
		};
		[key: string]: unknown;
	};
	workflowData: { id: string; name: string; nodes: WorkflowNode[] };
}

/** The newest executions of a workflow, newest first. */
export async function executions(
	workflowId: string,
	options: { limit?: number } = {},
): Promise<ExecutionSummary[]> {
	const filter = encodeURIComponent(JSON.stringify({ workflowId }));
	const data = await restData<{ results: ExecutionSummary[] }>(
		'GET',
		`/executions?limit=${options.limit ?? 20}&filter=${filter}`,
	);
	return data.results;
}

/**
 * Parses the `flatted` format n8n stores run data in: a JSON array whose
 * first item is the root; every string inside an object or array is the
 * index of another item. Same result as flatted's `parse`, without the
 * dependency.
 */
export function unflatten(text: string): unknown {
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
		'GET',
		`/executions/${id}`,
	);
	const data = typeof raw.data === 'string' ? (unflatten(raw.data) as Execution['data']) : raw.data;
	return { ...raw, data };
}

export type ExecutionMatch = number | Date | ((summary: ExecutionSummary) => boolean);

/**
 * Polls until a finished execution of the workflow matches, then returns it
 * with its run data. `match` is a predicate on the summary, or a time: the
 * execution's `createdAt` must not be before it. n8n saves an execution
 * right after the webhook answers, so the default 10 s is ample.
 */
export async function waitForExecution(
	workflowId: string,
	match: ExecutionMatch,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Execution> {
	const since = match instanceof Date ? match.getTime() : match;
	const matches =
		typeof since === 'function'
			? since
			: (summary: ExecutionSummary) => new Date(summary.createdAt).getTime() >= since;
	const deadline = Date.now() + (options.timeoutMs ?? 10_000);
	for (;;) {
		const list = await executions(workflowId, { limit: 10 });
		const found = list.find((summary) => FINISHED.has(summary.status) && matches(summary));
		if (found) return await execution(found.id);
		if (Date.now() >= deadline) {
			const seen = list.map((summary) => `${summary.id}:${summary.status}`).join(', ') || 'none';
			throw new Error(
				`No matching finished execution of workflow ${workflowId} within ${options.timeoutMs ?? 10_000} ms (seen: ${seen})`,
			);
		}
		await sleep(options.intervalMs ?? 250);
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
	context?: Record<string, unknown>;
	lastNodeExecuted?: string;
}

/**
 * The error the user sees on a failed execution: `resultData.error`, or the
 * first node run that recorded one, for example a tool that failed inside an
 * AI Agent that still answered.
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
		context: raw.context,
		lastNodeExecuted: resultData.lastNodeExecuted,
	};
}

/** The runs of one node, oldest first; empty when the node did not run. */
export function nodeRuns(run: Execution, nodeName: string): NodeRun[] {
	return run.data.resultData.runData[nodeName] ?? [];
}

/** The JSON of the items a node put on one output (`main` output 0 by default). */
export function nodeOutput(
	run: Execution,
	nodeName: string,
	options: { runIndex?: number; connectionType?: string; outputIndex?: number } = {},
): Array<Record<string, unknown>> {
	const nodeRun = nodeRuns(run, nodeName)[options.runIndex ?? 0];
	const branch = nodeRun?.data?.[options.connectionType ?? 'main']?.[options.outputIndex ?? 0];
	return (branch ?? []).map((item) => item.json);
}

export interface WebhookResponse {
	status: number;
	/** The body as text. */
	body: string;
	/** The body parsed, when it is JSON. */
	json?: unknown;
}

export interface WebhookInit {
	/** Defaults to POST. */
	method?: string;
	headers?: Record<string, string>;
}

/**
 * Calls a webhook and returns whatever n8n answered, never throwing on an
 * HTTP error, so a test can assert a 500 and then read the execution.
 * `path` is the part after `/webhook/`, or a full path when it starts with `/`.
 */
export async function callWebhook(
	path: string,
	body?: unknown,
	init: WebhookInit = {},
): Promise<WebhookResponse> {
	const url = path.startsWith('/') ? `${N8N_URL}${path}` : `${N8N_URL}/webhook/${path}`;
	const response = await fetch(url, {
		method: init.method ?? 'POST',
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...init.headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	return { status: response.status, body: text, json: parseJson(text) };
}

/**
 * Calls a webhook of the workflow and returns the response together with the
 * execution it produced. The execution is found by ID, so it is the right
 * one even when the same workflow ran a moment earlier.
 */
export async function callWebhookAndWait(
	workflowId: string,
	path: string,
	body?: unknown,
	init: WebhookInit = {},
): Promise<{ response: WebhookResponse; execution: Execution }> {
	const [newest] = await executions(workflowId, { limit: 1 });
	const response = await callWebhook(path, body, init);
	const run = await waitForExecution(
		workflowId,
		(summary) => newest === undefined || Number(summary.id) > Number(newest.id),
	);
	return { response, execution: run };
}
