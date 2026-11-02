import { describe, expect, it } from 'vitest';
import { resolveCredentialTest } from '../support/credential-test-request';
import { agentMemoryConfig, skipReason } from '../support/env';

/**
 * Sends the request the credential test block builds to the hosted service,
 * so a wrong path or an auth mismatch in that block fails here.
 */
describe.skipIf(!agentMemoryConfig)(`Agent Memory credential test contract ${skipReason}`, () => {
	it('reaches the store health check with the bearer key', async () => {
		const { method, url, headers } = resolveCredentialTest(agentMemoryConfig!);

		const response = await fetch(url, {
			method,
			headers: { ...headers, Accept: 'application/json' },
		});
		const body = (await response.json()) as { status?: string };

		expect(response.status).toBe(200);
		expect(body.status).toBe('healthy');
	});
});
