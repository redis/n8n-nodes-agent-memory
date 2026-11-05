import { describe, expect, it } from 'vitest';
import type { INode, ISupplyDataFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import {
	createAgentMemoryRequest,
	GATEWAY_FORBIDDEN_DESCRIPTION,
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
			request({ method: 'GET', path: '/sessions/s-1', allowNotFound: true }),
		).resolves.toBeUndefined();
	});

	it("rethrows the API's not-found when the caller does not allow it", async () => {
		const request = await requestThatThrows(httpError(404, SESSION_NOT_FOUND));
		const call = request({ method: 'GET', path: '/sessions/s-1' });

		await expect(call).rejects.toBeInstanceOf(NodeApiError);
		await expect(call).rejects.toMatchObject({ httpCode: '404' });
	});

	it('rethrows a 404 whose body is not the API not-found, even when allowed', async () => {
		// An unknown path, or a proxy in front of the store, answers with text.
		const request = await requestThatThrows(httpError(404, '404 page not found'));
		const call = request({ method: 'GET', path: '/sessions/s-1', allowNotFound: true });

		await expect(call).rejects.toBeInstanceOf(NodeApiError);
		await expect(call).rejects.toMatchObject({ httpCode: '404' });
	});

	it('rethrows a 404 with another problem type, even when allowed', async () => {
		const request = await requestThatThrows(
			httpError(404, { ...SESSION_NOT_FOUND, type: '/errors/gateway-not-found' }),
		);

		await expect(
			request({ method: 'GET', path: '/sessions/s-1', allowNotFound: true }),
		).rejects.toMatchObject({ httpCode: '404' });
	});

	it('wraps other failures as NodeApiError with the status and the item index', async () => {
		const request = await requestThatThrows(httpError(401));
		const call = request({ method: 'GET', path: '/sessions/s-1', allowNotFound: true });

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

		const error = await request({ method: 'GET', path: '/sessions/s-1' }).catch((e: unknown) => e);

		expect(error).toBe(wrapped);
		expect(wrapped.context.itemIndex).toBe(ITEM_INDEX);
	});
});

/**
 * The API answers every refusal with Problem Details: `title` names the
 * resource or the kind of fault, `detail` says what was wrong. n8n's default
 * message for a status code hides both, so the adapter puts them where the
 * editor and a tool-calling model can see them: `detail` as the message,
 * `title` and the status as the description.
 */
describe('createAgentMemoryRequest: Problem Details', () => {
	const MEMORY_TYPE_REFUSED = {
		type: '/errors/invalid-data',
		title: 'Invalid Request',
		status: 400,
		detail: 'memories[0]: memory type "SEMANTIC" is not registered on this store',
	};

	it("uses the API's detail as the message and its title as the description", async () => {
		const request = await requestThatThrows(httpError(400, MEMORY_TYPE_REFUSED));

		await expect(request({ method: 'POST', path: '/memories' })).rejects.toMatchObject({
			httpCode: '400',
			message: 'memories[0]: memory type "SEMANTIC" is not registered on this store',
			description: 'Invalid Request (HTTP 400)',
			context: { itemIndex: ITEM_INDEX, data: MEMORY_TYPE_REFUSED },
		});
	});

	it('names the missing resource for a not-found the caller does not allow', async () => {
		const request = await requestThatThrows(httpError(404, SESSION_NOT_FOUND));

		await expect(request({ method: 'GET', path: '/sessions/s-1' })).rejects.toMatchObject({
			httpCode: '404',
			message: 'The requested session was not found',
			description: 'Session Not Found (HTTP 404)',
		});
	});

	it('falls back to the title when the body has no detail', async () => {
		const request = await requestThatThrows(
			httpError(409, { type: '/errors/conflict', title: 'Namespace Already Exists', status: 409 }),
		);

		await expect(request({ method: 'POST', path: '/namespaces' })).rejects.toMatchObject({
			httpCode: '409',
			message: 'Namespace Already Exists',
			description: 'HTTP 409',
		});
	});

	it("keeps n8n's status text when the body is not Problem Details", async () => {
		// A proxy or the gateway answers with text or HTML; nothing to quote.
		const request = await requestThatThrows(httpError(404, '404 page not found'));

		await expect(request({ method: 'GET', path: '/sessions/s-1' })).rejects.toMatchObject({
			httpCode: '404',
			message: 'The resource you are requesting could not be found',
		});
	});

	/**
	 * The gateway in front of the hosted store answers a wrong key, a wrong
	 * store and an extra path segment in the URL alike: a 403 with an HTML
	 * page. n8n's own text names only the credentials, so the description
	 * points at all three fields.
	 */
	it('tells the user to check the URL and store too for a gateway 403', async () => {
		const request = await requestThatThrows(
			httpError(403, '<html><body><h1>403 Forbidden</h1></body></html>'),
		);

		await expect(request({ method: 'GET', path: '/sessions/s-1' })).rejects.toMatchObject({
			httpCode: '403',
			message: 'Forbidden - perhaps check your credentials?',
			description: GATEWAY_FORBIDDEN_DESCRIPTION,
		});
	});

	it('tells the user to check the URL and store too for a gateway 403 with no body', async () => {
		const request = await requestThatThrows(httpError(403));

		await expect(request({ method: 'GET', path: '/sessions/s-1' })).rejects.toMatchObject({
			httpCode: '403',
			description: GATEWAY_FORBIDDEN_DESCRIPTION,
		});
	});

	it("quotes the API's Problem Details for a 403 that carries them", async () => {
		const request = await requestThatThrows(
			httpError(403, {
				type: '/errors/forbidden',
				title: 'Forbidden',
				status: 403,
				detail: 'The key cannot write to this store',
			}),
		);

		await expect(request({ method: 'GET', path: '/sessions/s-1' })).rejects.toMatchObject({
			httpCode: '403',
			message: 'The key cannot write to this store',
			description: 'Forbidden (HTTP 403)',
		});
	});

	it("rewrites an error n8n's helper has already wrapped", async () => {
		const wrapped = new NodeApiError(
			NODE,
			httpError(400, MEMORY_TYPE_REFUSED) as unknown as JsonObject,
		);
		const request = await requestThatThrows(wrapped);

		const error = await request({ method: 'POST', path: '/memories' }).catch((e: unknown) => e);

		expect(error).toBe(wrapped);
		expect(wrapped.message).toBe(
			'memories[0]: memory type "SEMANTIC" is not registered on this store',
		);
		expect(wrapped.description).toBe('Invalid Request (HTTP 400)');
	});
});
