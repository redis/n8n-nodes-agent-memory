import { Expression } from 'n8n-workflow';
import type { IDataObject } from 'n8n-workflow';
import { RedisAgentMemoryApi } from '../../credentials/RedisAgentMemoryApi.credentials';

export interface ResolvedCredentialTest {
	method: string;
	/** `baseURL` and `url` joined, as the request will be sent. */
	url: string;
	headers: Record<string, string>;
}

/**
 * Resolves the expressions in a credential value the way n8n does when it runs
 * the credential test, with `$credentials` in scope. Expressions start with
 * `=`; plain strings are returned as they are.
 */
function resolve(value: unknown, credentials: IDataObject): string {
	if (typeof value !== 'string') return String(value ?? '');
	if (!value.startsWith('=')) return value;
	// The sandbox hides real globals. When n8n resolves a parameter it adds
	// `encodeURIComponent` to the data by hand (n8n-workflow, expression.js,
	// `resolveSimpleParameterValue`); `resolveWithoutWorkflow` does not, so
	// the same is done here.
	const data: IDataObject = { $credentials: credentials, encodeURIComponent };
	return String(Expression.resolveWithoutWorkflow(value.slice(1), data));
}

/**
 * The request the credential test block would send for the given credential
 * values: the health check of the configured store, with the bearer header
 * from the `authenticate` block.
 */
export function resolveCredentialTest(credentials: {
	serverUrl: string;
	storeId: string;
	apiKey: string;
}): ResolvedCredentialTest {
	const credential = new RedisAgentMemoryApi();
	const { request } = credential.test;
	const data: IDataObject = { ...credentials };

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(credential.authenticate.properties.headers ?? {})) {
		headers[name] = resolve(value, data);
	}

	return {
		method: String(request.method ?? 'GET'),
		url: `${resolve(request.baseURL, data)}${resolve(request.url, data)}`,
		headers,
	};
}
