/*
 * Test harness code: it runs in Node during tests and is never published
 * (package.json "files" ships only dist). The n8n Cloud rules below guard
 * node code, which must not read the environment.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-globals, no-console */
import { agentMemoryConfig, skipReason } from '../support/env';
import { waitForN8n } from './harness';
import { startStack, stopStack } from './stack';

/** True when a stack already answers, so `E2E_REUSE_STACK=true` can skip the start. */
async function stackIsRunning(): Promise<boolean> {
	try {
		await waitForN8n(5_000);
		return true;
	} catch {
		return false;
	}
}

export default async function setup(): Promise<(() => void) | undefined> {
	if (!agentMemoryConfig) {
		console.warn(`\n[e2e] ${skipReason}\n`);
		return undefined;
	}

	const reuse = process.env.E2E_REUSE_STACK === 'true';
	if (reuse && (await stackIsRunning())) {
		console.warn('[e2e] E2E_REUSE_STACK=true: using the running stack, left as it is');
		return undefined;
	}

	await startStack();

	return () => {
		if (reuse || process.env.E2E_KEEP_STACK === 'true') {
			console.warn('[e2e] leaving the stack running. Stop it with: npm run e2e:down');
			return;
		}
		stopStack();
	};
}
