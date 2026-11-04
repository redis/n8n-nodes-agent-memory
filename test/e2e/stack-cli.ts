/*
 * Test harness code: it runs in Node and is never published (package.json
 * "files" ships only dist). The n8n Cloud rules below guard node code, which
 * must not read the environment or print to the console.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-globals, no-console */
import { agentMemoryConfig, skipReason } from '../support/env';
import { LLM_STUB_URL, N8N_URL, OWNER } from './harness';
import { startStack, stopStack } from './stack';

/**
 * Starts or stops the end-to-end stack for manual testing in a browser.
 *
 *   npm run e2e:up     build the package and start a fresh, seeded stack
 *   npm run e2e:down   stop the stack and delete its data
 */
async function main(command: string | undefined): Promise<void> {
	switch (command) {
		case 'up': {
			await startStack();
			console.log(`
n8n is running with this package installed.

  Open:      ${N8N_URL}
  Log in:    ${OWNER.email} / ${OWNER.password}
  Workflows: "E2E: Chat agent" (open it and use Open chat) and "E2E: Chat Memory Manager"
  LLM stub:  ${LLM_STUB_URL}/_requests shows what the agent sent to the model
${agentMemoryConfig ? '' : `\n  Note: ${skipReason.replace('Skipped: set', 'Set')}.\n  Until then, fill in the "Agent Memory (e2e)" credential in the editor.\n`}
To pick up code changes, run npm run e2e:up again: it rebuilds and starts afresh.
Stop with: npm run e2e:down`);
			return;
		}
		case 'down':
			stopStack();
			console.log(
				'Stopped the stack and deleted its data. Logs: test/e2e/.work/docker-compose.log',
			);
			return;
		default:
			console.error('Usage: tsx test/e2e/stack-cli.ts <up|down>');
			process.exitCode = 1;
	}
}

main(process.argv[2]).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
