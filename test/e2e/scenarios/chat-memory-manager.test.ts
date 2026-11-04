import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import {
	callWebhookAndWait,
	createWorkflow,
	deleteWorkflow,
	executionError,
	type CreatedWorkflow,
} from '../n8n-api';
import {
	branchNodes,
	chatAgentWorkflow,
	historySentToModel,
	insertMessages,
	memoryManagerWorkflow,
	modelRequestFor,
	SEED_BRANCH,
	seedTurns,
	sendMessage,
	storedEvents,
	USER_AI_FROM_BODY,
} from './chat-memory-support';

/**
 * The Redis Agent Chat Memory sub-node under n8n's Chat Memory Manager,
 * inside a real n8n, against the hosted Agent Memory store. No model is
 * involved, except where an AI Agent turn shows how inserted messages are
 * replayed.
 *
 * memory.test.ts covers insert, load, clear and Override All on the plain
 * path. These scenarios cover the rest: system messages, missing sessions,
 * Delete Last N, Simplify Output, several items per run, numeric IDs and
 * Verify Session Owner on the write path.
 */
describe.skipIf(!agentMemoryConfig)(
	`Redis Agent Chat Memory under the Chat Memory Manager ${skipReason}`,
	() => {
		const client = new AgentMemoryTestClient(agentMemoryConfig!);
		let counter = 0;
		/** One webhook per manager mode, each with its own sub-node instance. */
		let manager: CreatedWorkflow;
		/** Webhook → Split Out → Insert, one session per item. */
		let split: CreatedWorkflow;
		/** Chat Trigger → AI Agent with default options, to see what the model gets. */
		let agent: CreatedWorkflow;

		function newSession(label: string) {
			counter += 1;
			const sessionId = `${runPrefix}-manager-${label}-${counter}`;
			const userId = `${runPrefix}-manager-user-${counter}`;
			client.track(sessionId, userId);
			return { sessionId, userId };
		}

		/** Calls one branch of the manager workflow and returns the response and the execution. */
		async function call(branch: string, body: Record<string, unknown>) {
			const { response, execution } = await callWebhookAndWait(
				manager.id,
				manager.webhooks[branch],
				body,
			);
			return { response, execution, error: executionError(execution) };
		}

		beforeAll(async () => {
			manager = await createWorkflow(
				memoryManagerWorkflow('E2E chat memory: manager modes', [
					SEED_BRANCH,
					{
						key: 'insert-system',
						manager: insertMessages([
							{ type: 'system', message: '={{ $json.body.system }}' },
							...USER_AI_FROM_BODY,
						]),
					},
					{ key: 'override', manager: insertMessages(USER_AI_FROM_BODY, 'override') },
					{ key: 'load-simple', manager: { mode: 'load', simplifyOutput: true, options: {} } },
					{ key: 'delete-all', manager: { mode: 'delete', deleteMode: 'all' } },
					{
						key: 'delete-last',
						manager: {
							mode: 'delete',
							deleteMode: 'lastN',
							lastMessagesCount: '={{ $json.body.count }}',
						},
					},
					{
						key: 'insert-verify',
						manager: insertMessages(USER_AI_FROM_BODY),
						memory: { options: { verifyOwner: true } },
					},
				]),
			);
			split = await createWorkflow(
				memoryManagerWorkflow('E2E chat memory: one session per item', [
					{
						key: 'split-insert',
						between: [
							{
								name: 'Split Out',
								type: 'n8n-nodes-base.splitOut',
								typeVersion: 1,
								parameters: { fieldToSplitOut: 'body.items', options: {} },
							},
						],
						manager: insertMessages([
							{ type: 'user', message: '={{ $json.user }}' },
							{ type: 'ai', message: '={{ $json.ai }}' },
						]),
						memory: { sessionId: '={{ $json.sessionId }}', actorId: '={{ $json.userId }}' },
					},
				]),
			);
			agent = await createWorkflow(
				chatAgentWorkflow({
					name: 'E2E chat memory: agent after the manager',
					memory: {
						sessionId: '={{ $json.sessionId }}',
						actorId: '={{ $json.userId }}',
						options: {},
					},
				}),
			);
		});

		afterAll(async () => {
			for (const workflow of [manager, split, agent]) {
				if (workflow) await deleteWorkflow(workflow.id);
			}
			await client.cleanup();
		});

		describe('Insert Messages', () => {
			it('stores system, user and ai messages as SYSTEM, USER and ASSISTANT events', async () => {
				const session = newSession('insert-system');

				const { response } = await call('insert-system', {
					...session,
					system: 'You answer in haiku.',
					user: 'Who are you?',
					ai: 'A poet of few words.',
				});

				expect(response.status).toBe(200);
				expect(await storedEvents(client, session.sessionId)).toEqual([
					['SYSTEM', 'You answer in haiku.', session.userId],
					['USER', 'Who are you?', session.userId],
					['ASSISTANT', 'A poet of few words.', session.userId],
				]);
			});

			// Some chat models reject a system message anywhere but first, so the
			// node replays a stored SYSTEM event to the model as a user message.
			it('replays a stored system message to the model as a user message', async () => {
				const session = newSession('replay-system');
				await call('insert-system', {
					...session,
					system: 'You answer in haiku.',
					user: 'Who are you?',
					ai: 'A poet of few words.',
				});
				const chatInput = `another one ${session.sessionId}`;

				const reply = await sendMessage(agent.webhooks['Chat Trigger'], { ...session, chatInput });

				expect(reply.status, reply.body).toBe(200);
				expect(await historySentToModel(session.sessionId, chatInput)).toEqual([
					['user', 'You answer in haiku.'],
					['user', 'Who are you?'],
					['assistant', 'A poet of few words.'],
				]);
				const request = await modelRequestFor(session.sessionId, chatInput);
				expect(request.messages.slice(1).some((m) => m.role === 'system')).toBe(false);
			});

			it('creates the session with Override All when it does not exist yet', async () => {
				const session = newSession('override-new');

				const { response } = await call('override', {
					...session,
					user: 'First question',
					ai: 'First answer',
				});

				expect(response.status).toBe(200);
				expect(await storedEvents(client, session.sessionId)).toEqual([
					['USER', 'First question', session.userId],
					['ASSISTANT', 'First answer', session.userId],
				]);
			});
		});

		describe('Delete Messages', () => {
			it('does not fail with All Messages on a session that does not exist', async () => {
				const session = newSession('delete-missing');

				const { response, execution } = await call('delete-all', session);

				expect(response.status).toBe(200);
				expect(execution.status).toBe('success');
				expect(await client.getSession(session.sessionId)).toBeUndefined();
			});

			// README, "Chat Memory Manager": Last N is not supported. n8n
			// implements it as clear + re-insert of the kept messages, through
			// this node. The kept turns come back with new event IDs, and the
			// re-insert runs as the manager's user, who becomes the session
			// owner. Pinned so a change in n8n or in the node shows up.
			it('with Last N, rewrites the session under the deleting user (not supported, see README)', async () => {
				const session = newSession('delete-last');
				const deleter = `${runPrefix}-manager-deleter-${counter}`;
				client.track(session.sessionId, deleter);
				await seedTurns(manager.webhooks['seed'], session, [
					['question 1', 'answer 1'],
					['question 2', 'answer 2'],
				]);
				const before = (await client.getSession(session.sessionId))!.events;

				const { response, execution } = await call('delete-last', {
					sessionId: session.sessionId,
					userId: deleter,
					count: 1,
				});

				expect(response.status).toBe(200);
				expect(execution.status).toBe('success');
				const after = (await client.getSession(session.sessionId))!;
				expect(after.events.map((e) => [e.role, e.content[0].text, e.actorId])).toEqual([
					['USER', 'question 1', deleter],
					['ASSISTANT', 'answer 1', deleter],
					['USER', 'question 2', deleter],
				]);
				expect(after.ownerId).toBe(deleter);
				const oldIds = new Set(before.map((e) => e.eventId));
				expect(after.events.some((e) => oldIds.has(e.eventId))).toBe(false);
			});
		});

		describe('Get Many Messages', () => {
			// The sub-node returns message content as parts, so Simplify Output
			// gives `[{ type: 'text', text }]` where n8n's own memories give a
			// string. Pinned as it is; the wanted shape is the next test.
			it('with Simplify Output, groups each turn into a sender/content pair', async () => {
				const session = newSession('load-simple');
				await seedTurns(manager.webhooks['seed'], session, [
					['question 1', 'answer 1'],
					['question 2', 'answer 2'],
				]);

				const { response } = await call('load-simple', session);

				expect(response.status).toBe(200);
				expect(response.json).toEqual({
					messages: [
						{
							human: [{ type: 'text', text: 'question 1' }],
							ai: [{ type: 'text', text: 'answer 1' }],
						},
						{
							human: [{ type: 'text', text: 'question 2' }],
							ai: [{ type: 'text', text: 'answer 2' }],
						},
					],
					messagesCount: 2,
				});
			});

			it.fails('with Simplify Output, gives the text of each message as a string', async () => {
				const session = newSession('load-simple-text');
				await seedTurns(manager.webhooks['seed'], session, [['question 1', 'answer 1']]);

				const { response } = await call('load-simple', session);

				expect(response.json).toEqual({
					messages: [{ human: 'question 1', ai: 'answer 1' }],
					messagesCount: 1,
				});
			});

			it('returns an empty group for a session that does not exist', async () => {
				const session = newSession('load-missing');

				const { response, execution } = await call('load-simple', session);

				expect(response.status).toBe(200);
				expect(execution.status).toBe('success');
				expect(response.json).toEqual({ messages: [], messagesCount: 0 });
			});
		});

		describe('Several items in one run', () => {
			it('writes each item to the session and user of that item', async () => {
				const items = [1, 2, 3].map((i) => {
					const session = newSession(`split-${i}`);
					return { ...session, user: `question ${i}`, ai: `answer ${i}` };
				});

				const { response, execution } = await callWebhookAndWait(
					split.id,
					split.webhooks['split-insert'],
					{ items },
				);

				expect(response.status).toBe(200);
				expect(execution.status).toBe('success');
				for (const item of items) {
					expect(await storedEvents(client, item.sessionId)).toEqual([
						['USER', item.user, item.userId],
						['ASSISTANT', item.ai, item.userId],
					]);
				}
			});

			// The manager handles items in order and stops at the first error, so
			// the items before the bad one are stored and the ones after are not.
			it('fails at the item whose User ID is empty and leaves the later items unwritten', async () => {
				const items = [1, 2, 3].map((i) => {
					const session = newSession(`split-bad-${i}`);
					return { ...session, user: `question ${i}`, ai: `answer ${i}` };
				});
				items[1].userId = '';

				const { response, execution } = await callWebhookAndWait(
					split.id,
					split.webhooks['split-insert'],
					{ items },
				);

				expect(response.status).toBe(500);
				expect(execution.status).toBe('error');
				expect(executionError(execution)).toMatchObject({
					nodeName: branchNodes('split-insert').memory,
					message: `Error in sub-node ${branchNodes('split-insert').memory}`,
					description: "'User ID' is empty",
					itemIndex: 1,
					lastNodeExecuted: branchNodes('split-insert').manager,
				});
				expect(await storedEvents(client, items[0].sessionId)).toHaveLength(2);
				expect(await client.getSession(items[1].sessionId)).toBeUndefined();
				expect(await client.getSession(items[2].sessionId)).toBeUndefined();
			});
		});

		describe('Numeric IDs', () => {
			it('coerces a numeric session ID and user ID to text', async () => {
				const sessionId = Date.now();
				const userId = Number(String(sessionId).slice(-9));
				client.track(String(sessionId), String(userId));

				const inserted = await call('seed', {
					sessionId,
					userId,
					user: 'question 1',
					ai: 'answer 1',
				});
				const loaded = await call('load-simple', { sessionId, userId });

				expect(inserted.response.status).toBe(200);
				expect(await storedEvents(client, String(sessionId))).toEqual([
					['USER', 'question 1', String(userId)],
					['ASSISTANT', 'answer 1', String(userId)],
				]);
				expect(loaded.response.json).toMatchObject({ messagesCount: 1 });
			});
		});

		describe('Verify Session Owner on insert', () => {
			// The manager reads the session before it inserts, so the owner check
			// fails inside `getMessages()`. n8n shows that error on the manager
			// node, as the node's own `SessionOwnerMismatchError`, not on the
			// sub-node as it does on the AI Agent path. Pinned as it is; the
			// wanted node is the test after this one.
			it("refuses to insert into another user's session", async () => {
				const session = newSession('verify-refuse');
				const b = `${runPrefix}-manager-intruder-${counter}`;
				client.track(session.sessionId, b);
				await seedTurns(manager.webhooks['seed'], session, [['question 1', 'answer 1']]);

				const { response, execution, error } = await call('insert-verify', {
					sessionId: session.sessionId,
					userId: b,
					user: 'question 2',
					ai: 'answer 2',
				});

				expect(response.status).toBe(500);
				expect(execution.status).toBe('error');
				expect(error).toMatchObject({
					nodeName: branchNodes('insert-verify').manager,
					type: 'SessionOwnerMismatchError',
					message:
						`Session "${session.sessionId}" belongs to user "${session.userId}", not to the configured User ID "${b}". ` +
						'Use a session ID derived from the user, or turn off "Verify Session Owner" for shared sessions.',
				});
				expect(await storedEvents(client, session.sessionId)).toHaveLength(2);
			});

			it.fails('shows the owner mismatch on the memory sub-node', async () => {
				const session = newSession('verify-refuse-node');
				const b = `${runPrefix}-manager-intruder-${counter}`;
				client.track(session.sessionId, b);
				await seedTurns(manager.webhooks['seed'], session, [['question 1', 'answer 1']]);

				const { error } = await call('insert-verify', {
					sessionId: session.sessionId,
					userId: b,
					user: 'question 2',
					ai: 'answer 2',
				});

				expect(error?.nodeName).toBe(branchNodes('insert-verify').memory);
			});

			it("inserts into the owner's own session", async () => {
				const session = newSession('verify-own');
				await seedTurns(manager.webhooks['seed'], session, [['question 1', 'answer 1']]);

				const { response, execution } = await call('insert-verify', {
					...session,
					user: 'question 2',
					ai: 'answer 2',
				});

				expect(response.status).toBe(200);
				expect(execution.status).toBe('success');
				expect(await storedEvents(client, session.sessionId)).toEqual([
					['USER', 'question 1', session.userId],
					['ASSISTANT', 'answer 1', session.userId],
					['USER', 'question 2', session.userId],
					['ASSISTANT', 'answer 2', session.userId],
				]);
			});
		});
	},
);
