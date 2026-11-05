import { describe, expect, it } from 'vitest';
import { RedisAgentMemoryApi } from '../../credentials/RedisAgentMemoryApi.credentials';
import { resolveCredentialTest } from '../support/credential-test-request';

describe('RedisAgentMemoryApi credential', () => {
	it('marks the API key as a password and requires every field', () => {
		const { properties } = new RedisAgentMemoryApi();

		expect(properties.map((p) => p.name)).toEqual(['serverUrl', 'storeId', 'apiKey']);
		expect(properties.every((p) => p.required)).toBe(true);
		expect(properties.find((p) => p.name === 'apiKey')?.typeOptions).toEqual({ password: true });
	});

	it('tests the credential against the health check of the configured store', () => {
		const test = resolveCredentialTest({
			serverUrl: 'https://memory.example.com',
			storeId: 'store-1',
			apiKey: 'secret',
		});

		expect(test).toEqual({
			method: 'GET',
			url: 'https://memory.example.com/iris/data/v1/agent-memory/stores/store-1/health',
			headers: { Authorization: 'Bearer secret' },
		});
	});

	it('names all three fields on a 403 and the Server URL on a 404', () => {
		// The gateway refuses a wrong key, a wrong store and an extra path segment
		// in the URL the same way; n8n's default for a 403 is the bare word
		// "Forbidden". A Server URL that carries a path, or a server on the old
		// API, answers with an empty 404.
		const { test } = new RedisAgentMemoryApi();

		expect(test.rules).toEqual([
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message: 'Forbidden: check the API Key, Server URL and Store ID',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message: expect.stringContaining('check the Server URL') as string,
				},
			},
		]);
	});

	it('builds the same URL as the nodes: trailing slashes dropped, store ID encoded', () => {
		// The nodes' request adapter sends .../stores/store%2F1/...; the test must too.
		const { url } = resolveCredentialTest({
			serverUrl: 'https://memory.example.com//',
			storeId: 'store/1',
			apiKey: 'secret',
		});

		expect(url).toBe(
			'https://memory.example.com/iris/data/v1/agent-memory/stores/store%2F1/health',
		);
	});
});
