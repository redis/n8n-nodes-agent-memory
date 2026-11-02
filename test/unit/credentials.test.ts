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
			url: 'https://memory.example.com/v1/stores/store-1/health',
			headers: { Authorization: 'Bearer secret' },
		});
	});

	it('builds the same URL as the nodes: trailing slashes dropped, store ID encoded', () => {
		// The nodes' request adapter sends /v1/stores/store%2F1/...; the test must too.
		const { url } = resolveCredentialTest({
			serverUrl: 'https://memory.example.com//',
			storeId: 'store/1',
			apiKey: 'secret',
		});

		expect(url).toBe('https://memory.example.com/v1/stores/store%2F1/health');
	});
});
