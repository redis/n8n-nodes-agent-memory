import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentMemoryConfig, credentialTests, runPrefix, skipReason } from '../../support/env';
import {
	createWorkflow,
	deleteWorkflow,
	n8nRest,
	type CreatedWorkflow,
	type ExecutionError,
} from '../n8n-api';
import { NOT_FOUND_BODY, pairsWorkflow, runPair, type PairSpec } from './action-node-support';

/**
 * What the user sees when the Redis Agent Memory credential is slightly
 * wrong. Each variant is a real credential in n8n, used by a Session → Get of
 * a session that does not exist: a correct credential yields the API's own
 * 404, anything else yields something different.
 *
 * The gateway in front of the hosted store rate-limits bad keys, so every
 * test makes one request, and the file stops at the first Cloudflare page.
 * Opt-in (E2E_CREDENTIAL_TESTS=true): a wrong key sent often earns a ban.
 */

const CREDENTIAL_TYPE = 'redisAgentMemoryApi';
const WELL_FORMED_WRONG_STORE_ID = '0123456789abcdef0123456789abcdef';

type Variant = 'plain' | 'trailingSlash' | 'v1Appended' | 'wrongKey' | 'wrongStore';

interface CredentialData {
	serverUrl: string;
	storeId: string;
	apiKey: string;
}

function variantData(variant: Variant): CredentialData {
	const base = agentMemoryConfig!;
	switch (variant) {
		case 'plain':
			return { ...base };
		case 'trailingSlash':
			return { ...base, serverUrl: `${base.serverUrl}/` };
		case 'v1Appended':
			return { ...base, serverUrl: `${base.serverUrl}/v1` };
		case 'wrongKey':
			return { ...base, apiKey: 'sk-wrong' };
		case 'wrongStore':
			return { ...base, storeId: WELL_FORMED_WRONG_STORE_ID };
	}
}

/** `POST /rest/credentials`; the response is never logged, since it may echo the data. */
async function createCredential(name: string, data: CredentialData): Promise<string> {
	const response = await n8nRest<{ data: { id: string } }>('POST', '/credentials', {
		name,
		type: CREDENTIAL_TYPE,
		data,
	});
	if (response.status >= 400 || !response.json?.data?.id) {
		throw new Error(`POST /rest/credentials returned ${response.status}`);
	}
	return response.json.data.id;
}

/** What the editor shows, plus the parsed body; never the request. */
function shown(error: ExecutionError | undefined) {
	if (!error) return undefined;
	return {
		type: error.type,
		httpCode: error.httpCode,
		message: error.message,
		description: error.description,
		data: error.context?.data,
	};
}

const credentialSkipReason = credentialTests
	? ''
	: 'Skipped: set E2E_CREDENTIAL_TESTS=true to send wrong credentials to the gateway';

describe.skipIf(!agentMemoryConfig || !credentialTests)(
	`E2E scenario: credential conditions ${skipReason || credentialSkipReason}`,
	() => {
		const credentialIds = new Map<Variant, string>();
		let workflow: CreatedWorkflow;
		/** Set once any body mentions Cloudflare; every later test skips. */
		let blocked = false;

		function stepName(variant: Variant): string {
			return `Get session (${variant})`;
		}

		function freshSessionId(variant: Variant): string {
			return `${runPrefix}-credential-${variant.toLowerCase()}`;
		}

		/** One Session → Get with the variant's credential; stops the file on a Cloudflare page. */
		async function getWith(variant: Variant) {
			const run = await runPair(workflow, stepName(variant), {
				sessionId: freshSessionId(variant),
			});
			const text = `${run.response.body} ${JSON.stringify(run.error ?? {})}`;
			if (/cloudflare/i.test(text)) {
				blocked = true;
				throw new Error(`Cloudflare answered the ${variant} request; stopping the file`);
			}
			return run;
		}

		beforeAll(async () => {
			const variants: Variant[] = [
				'plain',
				'trailingSlash',
				'v1Appended',
				'wrongKey',
				'wrongStore',
			];
			const pairs: PairSpec[] = [];
			for (const variant of variants) {
				const name = `${runPrefix} credential ${variant}`;
				const id = await createCredential(name, variantData(variant));
				credentialIds.set(variant, id);
				pairs.push({
					key: stepName(variant),
					parameters: {
						resource: 'session',
						operation: 'get',
						sessionId: '={{ $json.body.sessionId }}',
						options: {},
					},
					credentials: { redisAgentMemoryApi: { id, name } },
				});
			}
			workflow = await createWorkflow(pairsWorkflow('E2E scenario: credential conditions', pairs));
		});

		afterAll(async () => {
			if (workflow) await deleteWorkflow(workflow.id);
			for (const id of credentialIds.values()) {
				await n8nRest('DELETE', `/credentials/${id}`);
			}
		});

		it("a Server URL with a trailing slash behaves like the plain one: the API's 404", async (ctx) => {
			if (blocked) ctx.skip();

			const { response, error } = await getWith('trailingSlash');

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: stepName('trailingSlash'),
				type: 'NodeApiError',
				httpCode: '404',
				message: 'The requested session was not found',
			});
			expect(error?.context?.data).toMatchObject({ ...NOT_FOUND_BODY, title: 'Session Not Found' });
		});

		/**
		 * The gateway answers a wrong URL, a wrong key and a wrong store alike: a
		 * 403 HTML page. n8n keeps no body for it (`context.data` is undefined),
		 * so the user sees the same two lines in all three cases, which name only
		 * the credentials.
		 */
		const GATEWAY_FORBIDDEN = {
			type: 'NodeApiError',
			httpCode: '403',
			message: 'Forbidden - perhaps check your credentials?',
			description: 'Request failed with status code 403',
			data: undefined,
		};

		it("a Server URL with /v1 appended shows the gateway's 403 as a credential problem", async (ctx) => {
			if (blocked) ctx.skip();

			const { response, error } = await getWith('v1Appended');

			expect(response.status).toBe(500);
			expect(error?.nodeName).toBe(stepName('v1Appended'));
			expect(shown(error)).toEqual(GATEWAY_FORBIDDEN);
		});

		it("a wrong API key shows the gateway's 403 as a credential problem", async (ctx) => {
			if (blocked) ctx.skip();

			const { response, error } = await getWith('wrongKey');

			expect(response.status).toBe(500);
			expect(error?.nodeName).toBe(stepName('wrongKey'));
			expect(shown(error)).toEqual(GATEWAY_FORBIDDEN);
		});

		it("a wrong but well-formed Store ID shows the gateway's 403 as a credential problem", async (ctx) => {
			if (blocked) ctx.skip();

			const { response, error } = await getWith('wrongStore');

			expect(response.status).toBe(500);
			expect(error?.nodeName).toBe(stepName('wrongStore'));
			expect(shown(error)).toEqual(GATEWAY_FORBIDDEN);
		});

		describe('the credential test in the editor', () => {
			async function testCredential(variant: Variant) {
				const id = credentialIds.get(variant)!;
				const response = await n8nRest<{ data: { status: string; message: string } }>(
					'POST',
					'/credentials/test',
					{
						credentials: {
							id,
							name: `${runPrefix} credential ${variant}`,
							type: CREDENTIAL_TYPE,
							data: variantData(variant),
						},
					},
				);
				if (/cloudflare/i.test(response.text)) {
					blocked = true;
					throw new Error(`Cloudflare answered the credential test for ${variant}; stopping`);
				}
				return { status: response.status, result: response.json?.data };
			}

			it('passes for the correct credential', async (ctx) => {
				if (blocked) ctx.skip();

				const { status, result } = await testCredential('plain');

				expect(status).toBe(200);
				expect(result).toEqual({ status: 'OK', message: 'Connection successful!' });
			});

			// The editor shows the gateway's status text and nothing more.
			it('fails for a wrong API key with the bare word "Forbidden"', async (ctx) => {
				if (blocked) ctx.skip();

				const { status, result } = await testCredential('wrongKey');

				expect(status).toBe(200);
				expect(result).toEqual({ status: 'Error', message: 'Forbidden' });
			});
		});
	},
);
