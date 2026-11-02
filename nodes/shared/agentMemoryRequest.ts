import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const AGENT_MEMORY_CREDENTIAL = 'redisAgentMemoryApi';

/**
 * Problem type the API puts in every not-found body (`{ type, title, status,
 * detail }`). It is the same for a missing session, memory or namespace; only
 * `title` names the resource. A wrong store or URL never produces it: the
 * gateway answers those with a 403, and an unknown path with a plain-text 404.
 */
export const NOT_FOUND_ERROR_TYPE = '/errors/resource-not-found';

export interface AgentMemoryRequestOptions {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	/** Path below `/v1/stores/{storeId}`, starting with a slash. */
	path: string;
	body?: object;
	qs?: Record<string, string | number | boolean>;
	/**
	 * When true, the API's own not-found answer (a 404 whose body has
	 * `type: '/errors/resource-not-found'`) resolves to `undefined`. Any other
	 * 404, such as a plain-text one from a proxy, still throws.
	 */
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
			// n8n's helper has usually wrapped the error already; NodeApiError then
			// returns that instance as is, so the item index must be set by hand.
			const apiError = new NodeApiError(context.getNode(), error as JsonObject, { itemIndex });
			apiError.context.itemIndex ??= itemIndex;
			if (allowNotFound && isResourceNotFound(apiError)) return undefined;
			throw apiError;
		}
	};
}

/** True for a 404 whose body is the API's Problem Details not-found. */
function isResourceNotFound(error: NodeApiError): boolean {
	if (String(error.httpCode) !== '404') return false;
	// NodeApiError keeps the parsed JSON body in `context.data`; a non-JSON
	// body (text or HTML) leaves it unset.
	const body = error.context.data;
	return (
		typeof body === 'object' &&
		body !== null &&
		(body as { type?: unknown }).type === NOT_FOUND_ERROR_TYPE
	);
}
