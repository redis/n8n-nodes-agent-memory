import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const AGENT_MEMORY_CREDENTIAL = 'redisAgentMemoryApi';

export interface AgentMemoryRequestOptions {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	/** Path below `/v1/stores/{storeId}`, starting with a slash. */
	path: string;
	body?: object;
	qs?: Record<string, string | number | boolean>;
	/** When true, a 404 resolves to `undefined` instead of throwing. */
	allowNotFound?: boolean;
}

/** One authenticated call to the Agent Memory REST API of the credential's store. */
export type AgentMemoryRequest = <T>(options: AgentMemoryRequestOptions) => Promise<T | undefined>;

/**
 * Builds the request function both nodes use: it resolves the credential's
 * store URL once, authenticates every call and turns failures into
 * `NodeApiError`s that point at the current item.
 */
export async function createAgentMemoryRequest(
	context: IExecuteFunctions | ISupplyDataFunctions,
	itemIndex: number,
): Promise<AgentMemoryRequest> {
	const credentials = await context.getCredentials<{ serverUrl: string; storeId: string }>(
		AGENT_MEMORY_CREDENTIAL,
	);
	const baseUrl = `${credentials.serverUrl.replace(/\/+$/, '')}/v1/stores/${encodeURIComponent(
		credentials.storeId,
	)}`;

	return async ({ method, path, body, qs, allowNotFound }) => {
		try {
			return await context.helpers.httpRequestWithAuthentication.call(
				context,
				AGENT_MEMORY_CREDENTIAL,
				{
					method: method as IHttpRequestMethods,
					url: `${baseUrl}${path}`,
					body,
					qs,
					json: true,
				},
			);
		} catch (error) {
			const apiError = new NodeApiError(context.getNode(), error as JsonObject, { itemIndex });
			if (allowNotFound && String(apiError.httpCode) === '404') return undefined;
			throw apiError;
		}
	};
}
