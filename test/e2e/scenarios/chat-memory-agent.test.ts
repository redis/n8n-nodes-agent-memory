import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { messageText, messageType, stubRequestsContaining } from '../harness';
import {
	callWebhookAndWait,
	createWorkflow,
	deleteWorkflow,
	executionError,
	nodeOutput,
	type CreatedWorkflow,
} from '../n8n-api';
import {
	AGENT_MEMORY_CREDENTIAL,
	chatAgentWorkflow,
	createMemories,
	createNamespace,
	deleteNamespace,
	historySentToModel,
	loadPrevious,
	memoryManagerWorkflow,
	RECALL_HEADER,
	recallBullets,
	SEED_BRANCH,
	seedTurns,
	sendMessage,
	storedEvents,
	SUMMARY_HEADER,
	TOOL_NODE_TYPE,
	type ChatBody,
} from './chat-memory-support';

/**
 * The Redis Agent Chat Memory sub-node on an AI Agent, inside a real n8n,
 * against the hosted Agent Memory store and the OpenAI stub.
 *
 * The unit and contract tests prove the classes. These tests prove what
 * happens inside n8n: how the parameters resolve, what the model and the
 * chat widget receive for each option, and what the user sees on failure.
 *
 * Most scenarios drive one workflow whose options are expressions over the
 * chat body (`{{ $json.windowSize ?? 50 }}`), which the Chat Trigger passes
 * through from the `sendMessage` body. Scenarios that need literal options
 * have their own workflow.
 *
 * Every chat input carries its session ID, so a scenario finds its own
 * requests in the shared stub with `stubRequestsContaining(sessionId)`.
 */
describe.skipIf(!agentMemoryConfig)(`Redis Agent Chat Memory on an AI Agent ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	const namespaces: string[] = [];
	let counter = 0;
	/** Options read from the chat body; the defaults in the expressions match the node's. */
	let agent: CreatedWorkflow;
	/** No options set at all, so the node's own defaults apply. */
	let plainAgent: CreatedWorkflow;
	/** Recall on with an explicit Recall Query, and the action node attached as a tool. */
	let toolAgent: CreatedWorkflow;
	/** Only the "Recall Long-Term Memories" switch on, nothing else set, as a user would. */
	let toggleOnlyAgent: CreatedWorkflow;
	/** Webhook → Chat Memory Manager insert, to seed history without the model. */
	let seed: CreatedWorkflow;

	const toolOwnerId = `${runPrefix}-agent-tool-owner`;

	/** A fresh session whose user ID is what the workflows derive when the body has none. */
	function newSession(label: string) {
		counter += 1;
		const sessionId = `${runPrefix}-agent-${label}-${counter}`;
		const userId = `user-${sessionId}`;
		client.track(sessionId, userId);
		return { sessionId, userId };
	}

	/** One successful turn on the parametrised agent. */
	async function turn(body: ChatBody, workflow: CreatedWorkflow = agent): Promise<string> {
		const reply = await sendMessage(workflow.webhooks['Chat Trigger'], body);
		expect(reply.status, reply.body).toBe(200);
		return reply.output ?? '';
	}

	/** One turn that is expected to fail: the response and the execution's error. */
	async function failingTurn(body: ChatBody, workflow: CreatedWorkflow = agent) {
		const { response, execution } = await callWebhookAndWait(
			workflow.id,
			workflow.webhooks['Chat Trigger'],
			{ action: 'sendMessage', ...body },
		);
		return { response, execution, error: executionError(execution) };
	}

	const threeTurns: Array<[string, string]> = [
		['question 1', 'answer 1'],
		['question 2', 'answer 2'],
		['question 3', 'answer 3'],
	];

	beforeAll(async () => {
		agent = await createWorkflow(
			chatAgentWorkflow({
				name: 'E2E chat memory: options from the chat body',
				memory: {
					sessionId: '={{ $json.sessionId }}',
					actorId: '={{ $json.userId ?? ("user-" + $json.sessionId) }}',
					recallLongTermMemories: '={{ $json.recall ?? false }}',
					recallQuery: '={{ $json.recallQuery ?? $json.chatInput }}',
					recallLimit: '={{ $json.recallLimit ?? 5 }}',
					options: {
						windowSize: '={{ $json.windowSize ?? 50 }}',
						includeSummary: '={{ $json.includeSummary ?? true }}',
						namespaceId: '={{ $json.namespaceId ?? "" }}',
						verifyOwner: '={{ $json.verifyOwner ?? false }}',
					},
				},
			}),
		);
		plainAgent = await createWorkflow(
			chatAgentWorkflow({
				name: 'E2E chat memory: default options',
				memory: {
					sessionId: '={{ $json.sessionId }}',
					actorId: "={{ 'user-' + $json.sessionId }}",
					options: {},
				},
			}),
		);
		toolAgent = await createWorkflow(
			chatAgentWorkflow({
				name: 'E2E chat memory: recall with a tool',
				memory: {
					sessionId: '={{ $json.sessionId }}',
					actorId: "={{ 'user-' + $json.sessionId }}",
					recallLongTermMemories: true,
					recallQuery: '={{ $json.chatInput }}',
					options: {},
				},
				tools: [
					{
						name: 'Search memories',
						type: TOOL_NODE_TYPE,
						typeVersion: 1,
						parameters: {
							resource: 'longTermMemory',
							operation: 'search',
							query: "={{ $fromAI('query', 'what to look for', 'string') }}",
							ownerId: toolOwnerId,
							maxResults: 5,
							options: {},
						},
						credentials: AGENT_MEMORY_CREDENTIAL,
					},
				],
			}),
		);
		toggleOnlyAgent = await createWorkflow(
			chatAgentWorkflow({
				name: 'E2E chat memory: recall switch only',
				memory: {
					sessionId: '={{ $json.sessionId }}',
					actorId: "={{ 'user-' + $json.sessionId }}",
					recallLongTermMemories: true,
					options: {},
				},
			}),
		);
		seed = await createWorkflow(memoryManagerWorkflow('E2E chat memory: seed', [SEED_BRANCH]));
	});

	afterAll(async () => {
		for (const workflow of [agent, plainAgent, toolAgent, toggleOnlyAgent, seed]) {
			if (workflow) await deleteWorkflow(workflow.id);
		}
		for (const namespaceId of namespaces) await deleteNamespace(client, namespaceId);
		await client.cleanup();
	});

	describe('Context Window Length', () => {
		it('sends the model only the last stored turn with a window of 1', async () => {
			const session = newSession('window-1');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput, windowSize: 1 });

			expect(await historySentToModel(session.sessionId, chatInput)).toEqual([
				['user', 'question 3'],
				['assistant', 'answer 3'],
			]);
		});

		it('sends the model the last two turns with a window of 2', async () => {
			const session = newSession('window-2');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput, windowSize: 2 });

			expect(await historySentToModel(session.sessionId, chatInput)).toEqual([
				['user', 'question 2'],
				['assistant', 'answer 2'],
				['user', 'question 3'],
				['assistant', 'answer 3'],
			]);
		});

		it('sends the model every retained turn by default', async () => {
			const session = newSession('window-default');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput }, plainAgent);

			expect(await historySentToModel(session.sessionId, chatInput)).toEqual([
				['user', 'question 1'],
				['assistant', 'answer 1'],
				['user', 'question 2'],
				['assistant', 'answer 2'],
				['user', 'question 3'],
				['assistant', 'answer 3'],
			]);
		});

		it('gives the chat widget every turn whatever the window', async () => {
			const session = newSession('window-widget');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);

			const messages = await loadPrevious(agent.webhooks['Chat Trigger'], session.sessionId, {
				windowSize: 1,
			});

			expect(messages.map((m) => [messageType(m), messageText(m)])).toEqual([
				['HumanMessage', 'question 1'],
				['AIMessage', 'answer 1'],
				['HumanMessage', 'question 2'],
				['AIMessage', 'answer 2'],
				['HumanMessage', 'question 3'],
				['AIMessage', 'answer 3'],
			]);
		});

		it('accepts the window as the string "1" from an expression', async () => {
			const session = newSession('window-string');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput, windowSize: '1' });

			expect(await historySentToModel(session.sessionId, chatInput)).toEqual([
				['user', 'question 3'],
				['assistant', 'answer 3'],
			]);
		});

		// An empty value from an expression means the default, like an absent option.
		it('sends every turn, without an error, when the window resolves to ""', async () => {
			const session = newSession('window-empty');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput, windowSize: '' });

			expect(await historySentToModel(session.sessionId, chatInput)).toHaveLength(6);
		});

		// Anything else that is not a whole number of 1 or more is refused
		// before the node touches the store, instead of turning the window off.
		it.each([[0], ['abc']])('fails the run when the window resolves to %j', async (windowSize) => {
			const session = newSession('window-bad');
			const chatInput = `question 1 ${session.sessionId}`;

			const { response, error } = await failingTurn({ ...session, chatInput, windowSize });

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
				message: 'Error in sub-node Redis Agent Chat Memory',
				description: "'Context Window Length' must be a whole number of 1 or more",
				itemIndex: 0,
			});
			expect(await client.getSession(session.sessionId)).toBeUndefined();
		});
	});

	// A fresh session has no server summary: the server writes one in the
	// background after many turns, which the opt-in contract test covers. Here
	// only the absence can be checked, with the option on and off.
	describe('Include Summary', () => {
		it('adds no summary message to a fresh session when the option is on', async () => {
			const session = newSession('summary-on');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput, includeSummary: true });

			const history = await historySentToModel(session.sessionId, chatInput);
			expect(history.some(([, text]) => text.startsWith(SUMMARY_HEADER))).toBe(false);
			expect(history).toHaveLength(6);
		});

		it('adds no summary message to a fresh session when the option is off', async () => {
			const session = newSession('summary-off');
			await seedTurns(seed.webhooks['seed'], session, threeTurns);
			const chatInput = `question 4 ${session.sessionId}`;

			await turn({ ...session, chatInput, includeSummary: false });

			const history = await historySentToModel(session.sessionId, chatInput);
			expect(history.some(([, text]) => text.startsWith(SUMMARY_HEADER))).toBe(false);
			expect(history).toHaveLength(6);
		});
	});

	describe('Namespace ID', () => {
		it('binds the session to the namespace', async () => {
			const session = newSession('namespace-bind');
			const namespaceId = await createNamespace(client, `${runPrefix}-bind`);
			namespaces.push(namespaceId);

			await turn({ ...session, chatInput: `hello ${session.sessionId}`, namespaceId });

			const stored = (await client.getSession(session.sessionId)) as
				| { namespaceRef?: { namespaceId: string }; namespaceScope?: string }
				| undefined;
			expect(stored?.namespaceRef?.namespaceId).toBe(namespaceId);
			expect(stored?.namespaceScope).toBe('SHARED');
		});

		it('recalls only the memories in the namespace when one is set', async () => {
			const session = newSession('namespace-recall');
			const n1 = await createNamespace(client, `${runPrefix}-n1`);
			const n2 = await createNamespace(client, `${runPrefix}-n2`);
			namespaces.push(n1, n2);
			await createMemories(client, [
				{
					id: `${session.userId}-a`,
					ownerId: session.userId,
					text: 'A: likes tea',
					namespaceId: n1,
				},
				{
					id: `${session.userId}-b`,
					ownerId: session.userId,
					text: 'B: likes coffee',
					namespaceId: n2,
				},
				{ id: `${session.userId}-c`, ownerId: session.userId, text: 'C: likes water' },
			]);
			const chatInput = `what do I like to drink ${session.sessionId}`;

			await turn({ ...session, chatInput, namespaceId: n1, recall: true });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toEqual([
				'- A: likes tea',
			]);
		});

		// What the server does for an unscoped search: it returns the user's
		// memories from every namespace and from none.
		it('recalls memories from every namespace and from none when no namespace is set', async () => {
			const session = newSession('namespace-unscoped');
			const n1 = await createNamespace(client, `${runPrefix}-u1`);
			const n2 = await createNamespace(client, `${runPrefix}-u2`);
			namespaces.push(n1, n2);
			await createMemories(client, [
				{
					id: `${session.userId}-a`,
					ownerId: session.userId,
					text: 'A: likes tea',
					namespaceId: n1,
				},
				{
					id: `${session.userId}-b`,
					ownerId: session.userId,
					text: 'B: likes coffee',
					namespaceId: n2,
				},
				{ id: `${session.userId}-c`, ownerId: session.userId, text: 'C: likes water' },
			]);
			const chatInput = `what do I like to drink ${session.sessionId}`;

			await turn({ ...session, chatInput, recall: true });

			const bullets = recallBullets(await historySentToModel(session.sessionId, chatInput));
			expect(bullets?.slice().sort()).toEqual([
				'- A: likes tea',
				'- B: likes coffee',
				'- C: likes water',
			]);
		});
	});

	describe('Recall Long-Term Memories', () => {
		it('adds no memories to the history when the option is off', async () => {
			const session = newSession('recall-off');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
			]);
			const chatInput = `what do I eat ${session.sessionId}`;

			await turn({ ...session, chatInput, recall: false });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toBeUndefined();
		});

		it('puts the recalled memories first, one bullet each, before the history', async () => {
			const session = newSession('recall-on');
			await seedTurns(seed.webhooks['seed'], session, [['question 1', 'answer 1']]);
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
				{ id: `${session.userId}-m2`, ownerId: session.userId, text: 'The user lives in Lisbon' },
			]);
			const chatInput = `tell me about myself ${session.sessionId}`;

			await turn({ ...session, chatInput, recall: true });

			const history = await historySentToModel(session.sessionId, chatInput);
			expect(history).toHaveLength(3);
			const [recall, ...rest] = history;
			expect(recall[0]).toBe('user');
			expect(recall[1].startsWith(`${RECALL_HEADER}\n`)).toBe(true);
			expect(recallBullets(history)?.slice().sort()).toEqual([
				'- The user is vegetarian',
				'- The user lives in Lisbon',
			]);
			expect(rest).toEqual([
				['user', 'question 1'],
				['assistant', 'answer 1'],
			]);
		});

		it('recalls at most Recall Limit memories', async () => {
			const session = newSession('recall-limit');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
				{ id: `${session.userId}-m2`, ownerId: session.userId, text: 'The user lives in Lisbon' },
				{ id: `${session.userId}-m3`, ownerId: session.userId, text: 'The user plays the violin' },
			]);
			const chatInput = `tell me about myself ${session.sessionId}`;

			await turn({ ...session, chatInput, recall: true, recallLimit: 1 });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toHaveLength(1);
		});

		it('skips recall when the Recall Query is blank, even though memories exist', async () => {
			const session = newSession('recall-blank');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
			]);
			const chatInput = `tell me about myself ${session.sessionId}`;

			await turn({ ...session, chatInput, recall: true, recallQuery: '   ' });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toBeUndefined();
		});

		it('searches with the Recall Query, not the chat input, when one is set', async () => {
			const session = newSession('recall-query');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
				{ id: `${session.userId}-m2`, ownerId: session.userId, text: 'The user lives in Lisbon' },
			]);
			const chatInput = `what is the weather like in my city ${session.sessionId}`;

			await turn({
				...session,
				chatInput,
				recall: true,
				recallLimit: 1,
				recallQuery: 'What does the user eat?',
			});

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toEqual([
				'- The user is vegetarian',
			]);
		});

		it("never recalls another user's memories", async () => {
			const session = newSession('recall-other-user');
			const other = newSession('recall-other-user-b');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
				{ id: `${other.userId}-m1`, ownerId: other.userId, text: 'The user eats steak daily' },
			]);
			const chatInput = `what do I eat ${session.sessionId}`;

			await turn({ ...session, chatInput, recall: true });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toEqual([
				'- The user is vegetarian',
			]);
		});

		it('does not store the recalled memories back as session events', async () => {
			const session = newSession('recall-not-stored');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
			]);
			const chatInput = `what do I eat ${session.sessionId}`;

			const output = await turn({ ...session, chatInput, recall: true });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toHaveLength(1);
			expect(await storedEvents(client, session.sessionId)).toEqual([
				['USER', chatInput, session.userId],
				['ASSISTANT', output, session.userId],
			]);
		});

		// The switch and its two fields are top-level parameters, so the Recall
		// Query's default `{{ $json.chatInput }}` applies the moment the switch
		// is on, with nothing else to add.
		it('recalls with the chat input when only the switch is on', async () => {
			const session = newSession('recall-switch-only-wanted');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
			]);
			const chatInput = `what do I eat ${session.sessionId}`;

			await turn({ ...session, chatInput }, toggleOnlyAgent);

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toEqual([
				'- The user is vegetarian',
			]);
		});

		it('recalls with a chat input that carries the session ID as the query', async () => {
			const session = newSession('recall-marker');
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
			]);
			const chatInput = session.sessionId;

			await turn({ ...session, chatInput, recall: true });

			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toEqual([
				'- The user is vegetarian',
			]);
		});
	});

	describe('Verify Session Owner', () => {
		it("refuses a turn by another user in the owner's session when the option is on", async () => {
			const { sessionId } = newSession('owner-refuse');
			const a = `${runPrefix}-owner-a-${counter}`;
			const b = `${runPrefix}-owner-b-${counter}`;
			client.track(sessionId, a);
			client.track(sessionId, b);
			await seedTurns(seed.webhooks['seed'], { sessionId, userId: a }, [['hi from A', 'hello A']]);

			const { response, execution, error } = await failingTurn({
				sessionId,
				chatInput: `hi from B ${sessionId}`,
				userId: b,
				verifyOwner: true,
			});

			expect(response.status).toBe(500);
			expect(execution.status).toBe('error');
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
				message:
					`Session "${sessionId}" belongs to user "${a}", not to the configured User ID "${b}". ` +
					'Use a session ID derived from the user, or turn off "Verify Session Owner" for shared sessions.',
			});
			expect(await storedEvents(client, sessionId)).toEqual([
				['USER', 'hi from A', a],
				['ASSISTANT', 'hello A', a],
			]);
		});

		it("lets another user join the owner's session when the option is off", async () => {
			const { sessionId } = newSession('owner-join');
			const a = `${runPrefix}-owner-a-${counter}`;
			const b = `${runPrefix}-owner-b-${counter}`;
			client.track(sessionId, a);
			client.track(sessionId, b);
			await seedTurns(seed.webhooks['seed'], { sessionId, userId: a }, [['hi from A', 'hello A']]);
			const chatInput = `hi from B ${sessionId}`;

			const output = await turn({ sessionId, chatInput, userId: b, verifyOwner: false });

			expect(await storedEvents(client, sessionId)).toEqual([
				['USER', 'hi from A', a],
				['ASSISTANT', 'hello A', a],
				['USER', chatInput, b],
				['ASSISTANT', output, b],
			]);
			expect((await client.getSession(sessionId))?.ownerId).toBe(a);
		});

		it('creates a session that does not exist yet, owned by the user, when the option is on', async () => {
			const { sessionId } = newSession('owner-new');
			const b = `${runPrefix}-owner-b-${counter}`;
			client.track(sessionId, b);
			const chatInput = `hi from B ${sessionId}`;

			const output = await turn({ sessionId, chatInput, userId: b, verifyOwner: true });

			const stored = await client.getSession(sessionId);
			expect(stored?.ownerId).toBe(b);
			expect(await storedEvents(client, sessionId)).toEqual([
				['USER', chatInput, b],
				['ASSISTANT', output, b],
			]);
		});

		it("accepts the owner's own session when the option is on", async () => {
			const session = newSession('owner-own');
			await seedTurns(seed.webhooks['seed'], session, [['question 1', 'answer 1']]);
			const chatInput = `question 2 ${session.sessionId}`;

			await turn({ ...session, chatInput, verifyOwner: true });

			expect(await historySentToModel(session.sessionId, chatInput)).toEqual([
				['user', 'question 1'],
				['assistant', 'answer 1'],
			]);
			expect(await storedEvents(client, session.sessionId)).toHaveLength(4);
		});
	});

	describe('IDs and strings', () => {
		// n8n wraps an error thrown by supplyData: the editor shows
		// "Error in sub-node <name>" as the message and the node's message as
		// the description. The node's own description is dropped, so the
		// node's message carries the hint itself.
		it('fails the run when the User ID is empty', async () => {
			const { sessionId } = newSession('empty-user');

			const { response, error } = await failingTurn({
				sessionId,
				chatInput: `hello ${sessionId}`,
				userId: '',
			});

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
				message: 'Error in sub-node Redis Agent Chat Memory',
				description: "'User ID' is empty. Set the ID of the user this conversation belongs to.",
				itemIndex: 0,
			});
			expect(await client.getSession(sessionId)).toBeUndefined();
		});

		it('shows the User ID hint when the User ID is empty', async () => {
			const { sessionId } = newSession('empty-user-hint');

			const { error } = await failingTurn({
				sessionId,
				chatInput: `hello ${sessionId}`,
				userId: '',
			});

			expect(`${error?.message} ${error?.description}`).toContain(
				'Set the ID of the user this conversation belongs to',
			);
		});

		// The Chat Trigger accepts an empty session ID and starts the run; the
		// node is what stops it.
		it('fails the run when the Session ID is empty', async () => {
			const { response, error } = await failingTurn({
				sessionId: '',
				chatInput: `hello ${runPrefix}-empty-session`,
			});

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
				message: 'Error in sub-node Redis Agent Chat Memory',
				description:
					"'Session ID' is empty. Set a session ID, for example from the chat trigger output.",
				itemIndex: 0,
			});
		});

		it('shows the Session ID hint when the Session ID is empty', async () => {
			const { error } = await failingTurn({
				sessionId: '',
				chatInput: `hello ${runPrefix}-empty-session-hint`,
			});

			expect(`${error?.message} ${error?.description}`).toContain(
				'Set a session ID, for example from the chat trigger output',
			);
		});

		// The server accepts only A-Z, a-z, 0-9 and hyphens in a session ID and
		// answers anything else with a 400 whose `detail` names the rule. n8n
		// re-wraps the node's NodeApiError for a memory sub-node, so the user
		// sees the generic 400 text; the rule is only in the execution's
		// `context.data`. Nothing is stored, so these sessions are not tracked.
		it("fails the run with the server's 400 for a session ID with spaces and unicode", async () => {
			counter += 1;
			const sessionId = `${runPrefix} agent odd ${counter} ünïcödé 日本語`;

			const { response, error } = await failingTurn({ sessionId, chatInput: `hello ${sessionId}` });

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
				message:
					'SessionID: must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-).',
				description: 'Invalid Request (HTTP 400)',
			});
			expect(error?.context?.data).toMatchObject({
				type: '/errors/invalid-data',
				detail:
					'SessionID: must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-).',
			});
		});

		// A slash is encoded into the path as `%2F`, which the server does not
		// route: a plain-text "404 page not found", not the API's not-found
		// body, so the node fails the run with the generic 404 text.
		it('fails the run with a 404 for a session ID that contains a slash', async () => {
			counter += 1;
			const sessionId = `${runPrefix}-agent-slash/${counter}`;

			const { response, error } = await failingTurn({ sessionId, chatInput: `hello ${sessionId}` });

			expect(response.status).toBe(500);
			expect(error).toMatchObject({
				nodeName: 'Redis Agent Chat Memory',
				type: 'NodeOperationError',
				message: 'The resource you are requesting could not be found',
				description: 'Request failed with status code 404',
			});
		});

		it('tells the user the session ID rule when the ID has an underscore', async () => {
			counter += 1;
			const sessionId = `${runPrefix}_agent_${counter}`;

			const { error } = await failingTurn({ sessionId, chatInput: `hello ${sessionId}` });

			expect(`${error?.message} ${error?.description}`).toMatch(/A-Z, a-z, 0-9|hyphen/);
		});

		it('accepts a numeric session ID from the trigger and stores it as text', async () => {
			const numeric = Date.now();
			const sessionId = String(numeric);
			client.track(sessionId, `user-${sessionId}`);
			const chatInput = `numeric ${sessionId}`;

			const { response, execution } = await callWebhookAndWait(
				agent.id,
				agent.webhooks['Chat Trigger'],
				{ action: 'sendMessage', sessionId: numeric, chatInput },
			);

			expect(response.status).toBe(200);
			expect(nodeOutput(execution, 'Chat Trigger')[0]).toMatchObject({ sessionId: numeric });
			const output = (response.json as { output: string }).output;
			expect(await storedEvents(client, sessionId)).toEqual([
				['USER', chatInput, `user-${sessionId}`],
				['ASSISTANT', output, `user-${sessionId}`],
			]);
			const widget = await loadPrevious(agent.webhooks['Chat Trigger'], numeric);
			expect(widget.map((m) => messageText(m))).toEqual([chatInput, output]);
		});

		it('stores and replays a 20 KB message with emoji, CRLF and JSON byte for byte', async () => {
			const session = newSession('big-message');
			const block = `line with emoji 🙂🚀 and json ${JSON.stringify({ a: 1, b: 'two', c: [3] })}\r\n`;
			const chatInput = `${session.sessionId}\r\n${block.repeat(Math.ceil(20_000 / block.length))}`;
			expect(chatInput.length).toBeGreaterThan(20_000);

			const output = await turn({ ...session, chatInput });
			const nextInput = `and now? ${session.sessionId}`;
			await turn({ ...session, chatInput: nextInput });

			expect(output).toBe(`Echo: ${chatInput}`);
			expect(await storedEvents(client, session.sessionId)).toEqual([
				['USER', chatInput, session.userId],
				['ASSISTANT', output, session.userId],
				['USER', nextInput, session.userId],
				['ASSISTANT', `Echo: ${nextInput}`, session.userId],
			]);
			expect(await historySentToModel(session.sessionId, nextInput)).toEqual([
				['user', chatInput],
				['assistant', output],
			]);
			const widget = await loadPrevious(agent.webhooks['Chat Trigger'], session.sessionId);
			expect(messageText(widget[0])).toBe(chatInput);
		});

		// Sessions are keyed by session ID alone (README, "Who may read a
		// session"): a second user with the same session ID joins the first
		// user's session and the model sees both users' turns.
		it("lets a second user with the same session ID join the first user's session", async () => {
			const { sessionId } = newSession('shared-session');
			const a = `${runPrefix}-shared-a-${counter}`;
			const b = `${runPrefix}-shared-b-${counter}`;
			client.track(sessionId, a);
			client.track(sessionId, b);
			const fromA = `hi from A ${sessionId}`;
			const fromB = `hi from B ${sessionId}`;

			const outputA = await turn({ sessionId, chatInput: fromA, userId: a });
			await turn({ sessionId, chatInput: fromB, userId: b });

			expect(await historySentToModel(sessionId, fromB)).toEqual([
				['user', fromA],
				['assistant', outputA],
			]);
			expect((await client.getSession(sessionId))?.ownerId).toBe(a);
			expect((await storedEvents(client, sessionId)).map(([, , actorId]) => actorId)).toEqual([
				a,
				a,
				b,
				b,
			]);
		});
	});

	describe('Recall together with the action node as a tool', () => {
		it('recalls memories, runs the tool and stores only the question and the answer', async () => {
			const session = newSession('recall-and-tool');
			client.track(session.sessionId, toolOwnerId);
			await createMemories(client, [
				{ id: `${session.userId}-m1`, ownerId: session.userId, text: 'The user is vegetarian' },
			]);
			const chatInput = `use tool Search_memories with {"query":"${session.sessionId}"}`;

			const output = await turn({ ...session, chatInput }, toolAgent);

			expect(output).toMatch(/^The answer is /);
			expect(recallBullets(await historySentToModel(session.sessionId, chatInput))).toEqual([
				'- The user is vegetarian',
			]);
			const requests = await stubRequestsContaining(session.sessionId);
			expect(requests.some((r) => r.messages.some((m) => m.role === 'tool'))).toBe(true);
			expect(await storedEvents(client, session.sessionId)).toEqual([
				['USER', chatInput, session.userId],
				['ASSISTANT', output, session.userId],
			]);
		});
	});
});
