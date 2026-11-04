/*
 * Test harness code: it runs in Node during tests and is never published
 * (package.json "files" ships only dist). The n8n Cloud rules below guard
 * node code, which must not read the environment or spawn processes.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * Connection to the hosted Agent Memory service used by contract and
 * end-to-end tests. Only the test harness reads these variables; the node
 * itself never reads the environment.
 */
export interface AgentMemoryTestConfig {
	serverUrl: string;
	storeId: string;
	apiKey: string;
}

const ENV_FILE = resolve(__dirname, '..', '..', '.env');

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const REQUIRED = ['AGENT_MEMORY_SERVER_URL', 'AGENT_MEMORY_STORE_ID', 'AGENT_MEMORY_API_KEY'];

export const missingAgentMemoryEnv = REQUIRED.filter((name) => !process.env[name]);

export const agentMemoryConfig: AgentMemoryTestConfig | undefined =
	missingAgentMemoryEnv.length === 0
		? {
				serverUrl: process.env.AGENT_MEMORY_SERVER_URL!.replace(/\/+$/, ''),
				storeId: process.env.AGENT_MEMORY_STORE_ID!,
				apiKey: process.env.AGENT_MEMORY_API_KEY!,
			}
		: undefined;

/**
 * Opt-in for the contract test that waits for a real server summary. It writes
 * 40 events to a fresh session and polls for up to 90 seconds, so it is off
 * unless `AGENT_MEMORY_SUMMARY_TESTS=true`. CI turns it on.
 */
export const summaryTests = process.env.AGENT_MEMORY_SUMMARY_TESTS === 'true';

export const skipReason =
	missingAgentMemoryEnv.length > 0
		? `Skipped: set ${missingAgentMemoryEnv.join(', ')} (in the environment or .env) to run tests against Agent Memory`
		: '';

/**
 * Prefix for every session ID and user ID a test run creates, so concurrent
 * runs on the shared store never see each other's data.
 */
export const runPrefix = `it-${process.env.GITHUB_RUN_ID ?? 'local'}-${randomBytes(4).toString('hex')}`;
