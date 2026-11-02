import { describe, expect, it } from 'vitest';
import type { INode, ISupplyDataFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import {
	createAgentMemoryRequest,
	NOT_FOUND_ERROR_TYPE,
} from '../../nodes/shared/agentMemoryRequest';

const NODE: INode = {
	id: 'memory-node',
	name: 'Redis Agent Memory',
	type: '@redis/n8n-nodes-agent-memory.redisAgentMemoryChatMemory',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const ITEM_INDEX = 3;

/** The body the API returns for a missing session (verified against the service). */
const SESSION_NOT_FOUND = {
	type: NOT_FOUND_ERROR_TYPE,
	title: 'Session Not Found',
	status: 404,
	detail: 'The requested session was not found',
};

/** What axios throws for a non-2xx response: the parsed body sits in `response.data`. */
function httpError(status: number, data?: unknown) {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data },
	});
}

/** Builds the request function with a stub context whose HTTP helper throws `thrown`. */
async function requestThatThrows(thrown: unknown) {
	const ctx = {
		getNode: () => NODE,
		getCredentials: async () => ({ serverUrl: 'https://memory.example.com/', storeId: 'store-1' }),
		helpers: {
			async httpRequestWithAuthentication() {
				throw thrown;
			},
		},
	} as unknown as ISupplyDataFunctions;
	return await createAgentMemoryRequest(ctx, ITEM_INDEX);
}

describe('createAgentMemoryRequest', () => {
	it("resolves the API's not-found to undefined when the caller allows it", async () => {
		const request = await requestThatThrows(httpError(404, SESSION_NOT_FOUND));

		await expect(
			request({ method: 'GET', path: '/session-memory/s-1', allowNotFound: true }),
		).resolves.toBeUndefined();
	});

	it("rethrows the API's not-found when the caller does not allow it", async () => {
		const request = await requestThatThrows(httpError(404, SESSION_NOT_FOUND));
		const call = request({ method: 'GET', path: '/session-memory/s-1' });

		await expect(call).rejects.toBeInstanceOf(NodeApiError);
		await expect(call).rejects.toMatchObject({ httpCode: '404' });
	});

	it('rethrows a 404 whose body is not the API not-found, even when allowed', async () => {
		// An unknown path, or a proxy in front of the store, answers with text.
		const request = await requestThatThrows(httpError(404, '404 page not found'));
		const call = request({ method: 'GET', path: '/session-memory/s-1', allowNotFound: true });

		await expect(call).rejects.toBeInstanceOf(NodeApiError);
		await expect(call).rejects.toMatchObject({ httpCode: '404' });
	});

	it('rethrows a 404 with another problem type, even when allowed', async () => {
		const request = await requestThatThrows(
			httpError(404, { ...SESSION_NOT_FOUND, type: '/errors/gateway-not-found' }),
		);

		await expect(
			request({ method: 'GET', path: '/session-memory/s-1', allowNotFound: true }),
		).rejects.toMatchObject({ httpCode: '404' });
	});

	it('wraps other failures as NodeApiError with the status and the item index', async () => {
		const request = await requestThatThrows(httpError(401));
		const call = request({ method: 'GET', path: '/session-memory/s-1', allowNotFound: true });

		await expect(call).rejects.toBeInstanceOf(NodeApiError);
		await expect(call).rejects.toMatchObject({
			httpCode: '401',
			context: { itemIndex: ITEM_INDEX },
		});
	});

	it("keeps the item index on an error n8n's helper has already wrapped", async () => {
		// httpRequestWithAuthentication throws a NodeApiError itself; constructing
		// another from it returns the same instance, with no item index applied.
		const wrapped = new NodeApiError(NODE, httpError(500) as unknown as JsonObject);
		const request = await requestThatThrows(wrapped);

		const error = await request({ method: 'GET', path: '/session-memory/s-1' }).catch(
			(e: unknown) => e,
		);

		expect(error).toBe(wrapped);
		expect(wrapped.context.itemIndex).toBe(ITEM_INDEX);
	});
});
