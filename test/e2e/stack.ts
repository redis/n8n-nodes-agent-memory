/*
 * Test harness code: it runs in Node during tests and is never published
 * (package.json "files" ships only dist). The n8n Cloud rules below guard
 * node code, which must not spawn processes.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-dangerous-functions, @n8n/community-nodes/require-node-api-error, no-console */
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { agentMemoryConfig } from '../support/env';
import { compose, E2E_DIR, waitForN8n, WORK_DIR } from './harness';

const ROOT = resolve(E2E_DIR, '..', '..');
const FIXTURE_WORKFLOWS = resolve(E2E_DIR, 'fixtures', 'workflows');

/** The `id` of every workflow file in fixtures/workflows. */
function fixtureWorkflowIds(): string[] {
	return readdirSync(FIXTURE_WORKFLOWS)
		.filter((file) => file.endsWith('.json'))
		.sort()
		.map((file) => {
			const { id } = JSON.parse(readFileSync(resolve(FIXTURE_WORKFLOWS, file), 'utf8')) as {
				id?: string;
			};
			if (!id) throw new Error(`fixtures/workflows/${file} has no "id"`);
			return id;
		});
}

/** Copies only what npm would publish, so peers resolve from n8n, not from our node_modules. */
function stagePackage(): void {
	execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
	const nodesDir = resolve(WORK_DIR, 'nodes');
	const target = resolve(nodesDir, 'node_modules', '@redis', 'n8n-nodes-agent-memory');
	mkdirSync(target, { recursive: true });
	cpSync(resolve(ROOT, 'package.json'), resolve(target, 'package.json'));
	cpSync(resolve(ROOT, 'dist'), resolve(target, 'dist'), { recursive: true });
	// n8n writes its own package.json here; the container user may differ from ours.
	chmodSync(nodesDir, 0o777);
}

/**
 * Writes the credentials fixture. Only the harness reads AGENT_MEMORY_*; the
 * node never does. Without them, the Agent Memory credential is left empty,
 * to fill in from the n8n editor.
 */
function stageFixtures(): void {
	const fixtures = resolve(WORK_DIR, 'fixtures');
	cpSync(FIXTURE_WORKFLOWS, resolve(fixtures, 'workflows'), { recursive: true });
	const credentials = [
		{
			id: 'e2eAgentMemory01',
			name: 'Agent Memory (e2e)',
			type: 'redisAgentMemoryApi',
			data: agentMemoryConfig ?? { serverUrl: '', storeId: '', apiKey: '' },
		},
		{
			id: 'e2eOpenAiStub001',
			name: 'OpenAI stub (e2e)',
			type: 'openAiApi',
			data: { apiKey: 'stub-key', url: 'http://llm-stub:8080/v1' },
		},
	];
	writeFileSync(resolve(fixtures, 'credentials.json'), JSON.stringify(credentials, null, 2));
}

/**
 * Builds the package and starts a fresh stack: any running stack and its data
 * are removed first, then n8n is seeded with the fixtures and started.
 */
export async function startStack(): Promise<void> {
	rmSync(WORK_DIR, { recursive: true, force: true });
	stagePackage();
	stageFixtures();

	compose(['down', '--volumes', '--remove-orphans'], { quiet: true });
	// Seed before the server starts: n8n registers webhooks only at startup.
	compose([
		'run',
		'--rm',
		'--no-deps',
		'n8n',
		'import:credentials',
		'--input=/fixtures/credentials.json',
	]);
	compose([
		'run',
		'--rm',
		'--no-deps',
		'n8n',
		'import:workflow',
		'--separate',
		'--input=/fixtures/workflows',
	]);
	// In regular mode, import cannot activate workflows; publishing does.
	for (const id of fixtureWorkflowIds()) {
		compose(['run', '--rm', '--no-deps', 'n8n', 'publish:workflow', `--id=${id}`]);
	}
	compose(['up', '--detach']);

	try {
		await waitForN8n();
	} catch (error) {
		console.error(compose(['logs', '--no-color', 'n8n'], { quiet: true }));
		compose(['down', '--volumes'], { quiet: true });
		throw error;
	}
}

/** Saves the container logs to .work/docker-compose.log, then removes the stack and its data. */
export function stopStack(): void {
	try {
		mkdirSync(WORK_DIR, { recursive: true });
		writeFileSync(
			resolve(WORK_DIR, 'docker-compose.log'),
			compose(['logs', '--no-color'], { quiet: true }),
		);
	} catch {
		// No stack, or Docker is unavailable: nothing to save.
	}
	compose(['down', '--volumes', '--remove-orphans'], { quiet: true });
}
