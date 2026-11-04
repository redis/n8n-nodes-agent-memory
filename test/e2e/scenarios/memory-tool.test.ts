import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentMemoryTestClient } from '../../support/agent-memory-client';
import { agentMemoryConfig, runPrefix, skipReason } from '../../support/env';
import { stubMessageText } from '../harness';
import {
	createWorkflow,
	deleteWorkflow,
	executionError,
	nodeRuns,
	type CreatedWorkflow,
} from '../n8n-api';
import {
	agentWithTools,
	callTool,
	chatTurn,
	fromAI,
	toolName,
	toolResultItems,
	type ToolSpec,
} from './memory-tool-support';

interface MemoryRecord {
	id: string;
	text: string;
	ownerId: string;
	topics?: string[];
	[key: string]: unknown;
}

/**
 * The Redis Agent Memory node as an AI Agent tool, inside a real n8n against
 * the hosted store, with the stub as the model.
 *
 * What n8n does with a tool node, as these tests observe it (n8n 2.42, AI
 * Agent 3.1): the function name is the node name with runs of characters
 * outside `[A-Za-z0-9_-]` replaced by `_`; the description is
 * `<action> in Redis Agent Memory` unless the node sets a manual one; the
 * schema has one required property per `$fromAI` key. A successful run sends
 * the model the node's output items as one JSON array. A failed run marks
 * the tool node red, keeps the execution `success`, and sends the model
 * `[{"error":"<message>"}]`, so the agent answers instead of failing.
 */
describe.skipIf(!agentMemoryConfig)(`Redis Agent Memory Tool in an AI Agent ${skipReason}`, () => {
	const client = new AgentMemoryTestClient(agentMemoryConfig!);
	/** The User ID pinned on every tool. */
	const ownerId = `${runPrefix}-tool-owner`;
	/** A user of their own for Get Many, so the count is exact. */
	const listOwnerId = `${runPrefix}-tool-list-owner`;
	const namespacesToDelete: string[] = [];
	let namespaceId: string;
	/** Search and Create, the two tools the README recommends. */
	let pair: CreatedWorkflow;
	/** Every other operation, one tool node each. */
	let extras: CreatedWorkflow;
	/** The Search tool next to the chat memory sub-node. */
	let withMemory: CreatedWorkflow;

	const searchTool = (name: string, owner = ownerId): ToolSpec => ({
		name,
		parameters: {
			resource: 'longTermMemory',
			operation: 'search',
			query: fromAI('query', 'what to look for'),
			ownerId: owner,
			maxResults: 5,
			options: {},
		},
	});

	/** A fresh session ID, tracked for cleanup together with the pinned user. */
	function newSession(label: string): string {
		const sessionId = `${runPrefix}-tool-${label}`;
		client.track(sessionId, ownerId);
		return sessionId;
	}

	/** Creates memories directly, so no test waits for extraction. */
	async function seedMemories(
		memories: Array<{ id: string; text: string; ownerId?: string }>,
	): Promise<void> {
		const created = await client.request<{ created: string[] }>({
			method: 'POST',
			path: '/long-term-memory',
			body: { memories: memories.map((memory) => ({ ownerId, ...memory })) },
		});
		expect(created?.created).toHaveLength(memories.length);
	}

	async function getMemory(id: string): Promise<MemoryRecord | undefined> {
		return await client.request<MemoryRecord>({
			method: 'GET',
			path: `/long-term-memory/${encodeURIComponent(id)}`,
			allowNotFound: true,
		});
	}

	beforeAll(async () => {
		const created = await client.request<{ namespace: { namespaceId: string } }>({
			method: 'POST',
			path: '/namespaces',
			body: { name: `${runPrefix}-tool-ns`, scope: 'SHARED' },
		});
		namespaceId = created!.namespace.namespaceId;
		namespacesToDelete.push(namespaceId);
		client.track(`${runPrefix}-tool-list`, listOwnerId);

		pair = await createWorkflow(
			agentWithTools('E2E tool: search and save', [
				searchTool('Search memories'),
				{
					name: 'Save memory',
					parameters: {
						descriptionType: 'manual',
						toolDescription: 'Remember a fact about the user',
						resource: 'longTermMemory',
						operation: 'create',
						text: fromAI('text', 'the fact to remember'),
						ownerId,
						additionalFields: {},
					},
				},
			]),
		);
		extras = await createWorkflow(
			agentWithTools('E2E tool: other operations', [
				{
					name: 'Search few',
					parameters: {
						resource: 'longTermMemory',
						operation: 'search',
						query: fromAI('query', 'what to look for'),
						ownerId,
						maxResults: fromAI('limit', 'how many memories to return', 'number'),
						options: {},
					},
				},
				{
					name: 'Save tagged memory',
					parameters: {
						resource: 'longTermMemory',
						operation: 'create',
						text: fromAI('text', 'the fact to remember'),
						ownerId,
						additionalFields: {
							topics: fromAI('topics', 'comma-separated topics'),
							namespaceId: fromAI('namespace', 'ID of the namespace to store it in'),
						},
					},
				},
				{
					name: 'Get memory',
					parameters: {
						resource: 'longTermMemory',
						operation: 'get',
						memoryId: fromAI('memoryId', 'ID of the memory'),
					},
				},
				{
					name: 'Delete memory',
					parameters: {
						resource: 'longTermMemory',
						operation: 'delete',
						memoryId: fromAI('memoryId', 'ID of the memory'),
					},
				},
				{
					name: 'Update memory',
					parameters: {
						resource: 'longTermMemory',
						operation: 'update',
						memoryId: fromAI('memoryId', 'ID of the memory'),
						updateFields: { text: fromAI('text', 'the new text') },
					},
				},
				{
					name: 'List memories',
					parameters: {
						resource: 'longTermMemory',
						operation: 'getAll',
						returnAll: true,
						filters: { ownerId: listOwnerId },
					},
				},
				{
					name: 'Add event',
					parameters: {
						resource: 'session',
						operation: 'addEvent',
						// The chat's own session, read from the trigger: works inside a tool.
						sessionId: "={{ $('Chat Trigger').item.json.sessionId }}",
						actorId: ownerId,
						role: 'ASSISTANT',
						text: fromAI('text', 'the message to record'),
						additionalFields: {},
					},
				},
				{
					name: 'Get session',
					parameters: {
						resource: 'session',
						operation: 'get',
						sessionId: "={{ $('Chat Trigger').item.json.sessionId }}",
						options: {},
					},
				},
				{
					name: 'Create namespace',
					parameters: {
						resource: 'namespace',
						operation: 'create',
						name: fromAI('name', 'name of the namespace'),
						scope: 'SHARED',
						additionalFields: {},
					},
				},
			]),
		);
		withMemory = await createWorkflow(
			agentWithTools('E2E tool: with chat memory', [searchTool('Search memories')], {
				memory: { sessionId: '={{ $json.sessionId }}', actorId: ownerId },
			}),
		);
	});

	afterAll(async () => {
		if (pair) await deleteWorkflow(pair.id);
		if (extras) await deleteWorkflow(extras.id);
		if (withMemory) await deleteWorkflow(withMemory.id);
		await client.cleanup();
		for (const id of namespacesToDelete) {
			await client.request({
				method: 'DELETE',
				path: `/namespaces/${encodeURIComponent(id)}`,
				allowNotFound: true,
			});
		}
	});

	describe('Tool definitions', () => {
		it('offers the model one function per tool node, named after the node', async () => {
			const sessionId = newSession('definitions');

			const turn = await callTool(pair, sessionId, toolName('Search memories'), {
				query: 'anything',
			});

			const [first] = turn.requests;
			const functions = Object.fromEntries(
				(first.tools ?? []).map((tool) => [tool.function.name, tool.function]),
			);
			expect(Object.keys(functions).sort()).toEqual(['Save_memory', 'Search_memories']);
			// No manual description: n8n builds one from the operation's action.
			expect(functions.Search_memories.description).toBe('Search memories in Redis Agent Memory');
			expect(functions.Search_memories.parameters).toEqual({
				type: 'object',
				properties: { query: { type: 'string', description: 'what to look for' } },
				required: ['query'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			});
			expect(functions.Save_memory.description).toBe('Remember a fact about the user');
			expect(functions.Save_memory.parameters).toEqual({
				type: 'object',
				properties: { text: { type: 'string', description: 'the fact to remember' } },
				required: ['text'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			});
		});
	});

	describe('Long-Term Memory → Search as a tool', () => {
		it('returns the matching memory text and ID to the model', async () => {
			const sessionId = newSession('search-hit');
			const id = `${runPrefix}-m-search-hit`;
			await seedMemories([{ id, text: 'The user keeps bees on the roof' }]);

			const turn = await callTool(pair, sessionId, 'Search_memories', {
				query: 'What hobby does the user have?',
			});

			expect(turn.response.status).toBe(200);
			expect(turn.toolCall).toEqual({
				name: 'Search_memories',
				arguments: { query: 'What hobby does the user have?' },
			});
			// One JSON array of the API's memory records, as the node outputs them.
			const items = toolResultItems(turn);
			expect(items.find((item) => item.id === id)).toEqual({
				id,
				text: 'The user keeps bees on the roof',
				ownerId,
				memoryType: 'semantic',
				topics: [],
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
			});
			expect(turn.answer).toBe(`The answer is ${turn.toolResult}.`);
		});

		// Today the node outputs no item for an empty search, and the Agent turns
		// zero items into the JSON string `""`: the model gets `""` and answers
		// `The answer is "".`, having learnt nothing. Wanted: a JSON array like
		// every other result, which means the tool must output one item when it
		// found nothing.
		it.fails('tells the model that nothing matched', async () => {
			const sessionId = newSession('search-miss');
			const emptyOwner = `${runPrefix}-tool-empty-owner`;
			client.track(sessionId, emptyOwner);
			const lonely = await createWorkflow(
				agentWithTools('E2E tool: search with no memories', [
					searchTool('Search memories', emptyOwner),
				]),
			);
			try {
				const turn = await callTool(lonely, sessionId, 'Search_memories', {
					query: 'anything at all',
				});

				expect(turn.response.status).toBe(200);
				expect(nodeRuns(turn.execution, 'Search memories')[0]?.executionStatus).toBe('success');
				expect(turn.toolResult).not.toBe('""');
				expect(Array.isArray(JSON.parse(turn.toolResult!))).toBe(true);
			} finally {
				await deleteWorkflow(lonely.id);
			}
		});

		it('keeps the pinned User ID when the model sends another one', async () => {
			const sessionId = newSession('search-pinned');
			const other = `${runPrefix}-tool-other-owner`;
			client.track(sessionId, other);
			await seedMemories([
				{ id: `${runPrefix}-m-pinned-own`, text: 'The user plays the cello' },
				{ id: `${runPrefix}-m-pinned-other`, text: 'The user plays the drums', ownerId: other },
			]);

			const turn = await callTool(pair, sessionId, 'Search_memories', {
				query: 'Which instrument does the user play?',
				ownerId: other,
			});

			// The model did send the extra argument; the tool ignored it.
			expect(turn.toolCall?.arguments).toEqual({
				query: 'Which instrument does the user play?',
				ownerId: other,
			});
			const items = toolResultItems(turn);
			expect(items.map((item) => item.id)).toContain(`${runPrefix}-m-pinned-own`);
			expect(items.map((item) => item.id)).not.toContain(`${runPrefix}-m-pinned-other`);
			expect(items.every((item) => item.ownerId === ownerId)).toBe(true);
		});

		it('turns an empty query from the model into an error item, and the agent still answers', async () => {
			const sessionId = newSession('search-empty');

			const turn = await callTool(pair, sessionId, 'Search_memories', { query: '' });

			expect(turn.toolCall?.arguments).toEqual({ query: '' });
			// What the model gets, and what the chat shows.
			expect(turn.toolResult).toBe('[{"error":"\'Query\' is empty"}]');
			expect(turn.response.status).toBe(200);
			expect(turn.answer).toBe('The answer is [{"error":"\'Query\' is empty"}].');
			// What the editor shows: a green execution with a red tool node.
			expect(turn.execution.status).toBe('success');
			const [run] = nodeRuns(turn.execution, 'Search memories');
			expect(run).toMatchObject({
				executionStatus: 'error',
				error: { name: 'NodeOperationError', message: "'Query' is empty" },
				data: { ai_tool: [[{ json: { error: "'Query' is empty" } }]] },
			});
			expect(executionError(turn.execution)).toMatchObject({
				nodeName: 'Search memories',
				message: "'Query' is empty",
				type: 'NodeOperationError',
				itemIndex: 0,
				lastNodeExecuted: 'AI Agent',
			});
		});

		it('lets the model set Max Results', async () => {
			const sessionId = newSession('search-limit');
			await seedMemories([
				{ id: `${runPrefix}-m-limit-1`, text: 'The user owns a red bicycle' },
				{ id: `${runPrefix}-m-limit-2`, text: 'The user owns a blue bicycle' },
				{ id: `${runPrefix}-m-limit-3`, text: 'The user owns a green bicycle' },
			]);

			const turn = await callTool(extras, sessionId, 'Search_few', {
				query: 'bicycle',
				limit: 1,
			});

			expect(turn.toolCall?.arguments).toEqual({ query: 'bicycle', limit: 1 });
			const items = toolResultItems(turn);
			expect(items).toHaveLength(1);
			expect(items[0].id).toMatch(new RegExp(`^${runPrefix}-m-limit-[123]$`));
		});
	});

	describe('Long-Term Memory → Create as a tool', () => {
		it('stores the text for the pinned user and returns the generated ID', async () => {
			const sessionId = newSession('create');
			const text = `The user was born in Plovdiv (${sessionId})`;

			const turn = await callTool(pair, sessionId, 'Save_memory', { text });

			expect(turn.response.status).toBe(200);
			const [item] = toolResultItems(turn);
			expect(item).toEqual({ id: expect.stringMatching(/^n8n-/), text, ownerId });
			expect(await getMemory(item.id as string)).toMatchObject({ id: item.id, text, ownerId });
			expect(turn.answer).toContain(item.id as string);
		});

		it('stores topics and a namespace the model gives in Additional Fields', async () => {
			const sessionId = newSession('create-tagged');
			const text = `The user likes sour cherries (${sessionId})`;

			const turn = await callTool(extras, sessionId, 'Save_tagged_memory', {
				text,
				topics: 'food, fruit',
				namespace: namespaceId,
			});

			const [item] = toolResultItems(turn);
			expect(item).toEqual({
				id: expect.stringMatching(/^n8n-/),
				text,
				ownerId,
				topics: ['food', 'fruit'],
				namespaceRef: { namespaceId },
			});
			const stored = await getMemory(item.id as string);
			expect(stored).toMatchObject({ text, topics: ['food', 'fruit'] });
			expect(JSON.stringify(stored)).toContain(namespaceId);
		});

		it('stores a long text with emoji and newlines', async () => {
			const sessionId = newSession('create-long');
			const line = `The user wrote this in session ${sessionId} 🐝🍯 and it goes on\n`;
			const text = line.repeat(Math.ceil(5000 / line.length));
			expect(text.length).toBeGreaterThanOrEqual(5000);

			const turn = await callTool(pair, sessionId, 'Save_memory', { text });

			expect(turn.response.status).toBe(200);
			const [item] = toolResultItems(turn);
			// The node trims the text, so the last newline goes.
			expect(item.text).toBe(text.trim());
			expect((await getMemory(item.id as string))?.text).toBe(text.trim());
		});

		it('turns empty text from the model into an error item', async () => {
			const sessionId = newSession('create-empty');

			const turn = await callTool(pair, sessionId, 'Save_memory', { text: '' });

			expect(turn.toolResult).toBe('[{"error":"\'Text\' is empty"}]');
			expect(turn.response.status).toBe(200);
			expect(nodeRuns(turn.execution, 'Save memory')[0]).toMatchObject({
				executionStatus: 'error',
				error: { name: 'NodeOperationError', message: "'Text' is empty" },
			});
		});
	});

	describe('Other operations as tools', () => {
		it('Get returns an existing memory to the model', async () => {
			const sessionId = newSession('get');
			const id = `${runPrefix}-m-get`;
			await seedMemories([{ id, text: 'The user collects stamps' }]);

			const turn = await callTool(extras, sessionId, 'Get_memory', { memoryId: id });

			expect(toolResultItems(turn)).toEqual([
				expect.objectContaining({ id, text: 'The user collects stamps', ownerId }),
			]);
		});

		it("Get for a missing memory gives the model an error item and the editor the API's 404", async () => {
			const sessionId = newSession('get-missing');

			const turn = await callTool(extras, sessionId, 'Get_memory', {
				memoryId: `${runPrefix}-m-does-not-exist`,
			});

			expect(turn.toolResult).toBe('[{"error":"The requested memory was not found"}]');
			expect(turn.response.status).toBe(200);
			expect(turn.execution.status).toBe('success');
			expect(nodeRuns(turn.execution, 'Get memory')[0]).toMatchObject({
				executionStatus: 'error',
				error: {
					name: 'NodeApiError',
					httpCode: '404',
					message: 'The requested memory was not found',
					description: 'Memory Not Found (HTTP 404)',
					context: { data: { title: 'Memory Not Found', type: '/errors/resource-not-found' } },
				},
			});
		});

		it('Get for a missing memory names the memory in the error the model gets', async () => {
			const sessionId = newSession('get-missing-named');

			const turn = await callTool(extras, sessionId, 'Get_memory', {
				memoryId: `${runPrefix}-m-does-not-exist`,
			});

			expect(turn.toolResult).toMatch(/memory/i);
		});

		it('Delete removes the memory the model names', async () => {
			const sessionId = newSession('delete');
			const id = `${runPrefix}-m-delete`;
			await seedMemories([{ id, text: 'The user will forget this' }]);

			const turn = await callTool(extras, sessionId, 'Delete_memory', { memoryId: id });

			expect(turn.toolResult).toBe(`[{"deleted":true,"id":"${id}"}]`);
			expect(await getMemory(id)).toBeUndefined();
		});

		it('Update replaces the text of the memory the model names', async () => {
			const sessionId = newSession('update');
			const id = `${runPrefix}-m-update`;
			await seedMemories([{ id, text: 'The user lives in Sofia' }]);

			const turn = await callTool(extras, sessionId, 'Update_memory', {
				memoryId: id,
				text: 'The user lives in Varna',
			});

			expect(toolResultItems(turn)).toEqual([
				expect.objectContaining({ id, text: 'The user lives in Varna', ownerId }),
			]);
			expect((await getMemory(id))?.text).toBe('The user lives in Varna');
		});

		it('Session → Add Event records the text under the chat session', async () => {
			const sessionId = newSession('add-event');

			const turn = await callTool(extras, sessionId, 'Add_event', {
				text: 'I will remember that',
			});

			expect(toolResultItems(turn)).toEqual([
				expect.objectContaining({
					sessionId,
					actorId: ownerId,
					role: 'ASSISTANT',
					content: [{ text: 'I will remember that' }],
					eventId: expect.any(String),
				}),
			]);
			const session = await client.getSession(sessionId);
			expect(session?.events).toEqual([
				expect.objectContaining({
					role: 'ASSISTANT',
					actorId: ownerId,
					content: [{ text: 'I will remember that' }],
				}),
			]);
		});

		it('Session → Get hands the model the events of the chat session', async () => {
			const sessionId = newSession('get-session');
			await client.request({
				method: 'POST',
				path: '/session-memory/events',
				body: {
					sessionId,
					actorId: ownerId,
					role: 'USER',
					content: [{ text: 'I prefer tea to coffee' }],
					createdAt: new Date().toISOString(),
				},
			});

			const turn = await callTool(extras, sessionId, 'Get_session', {});

			const [session] = toolResultItems(turn);
			expect(session).toMatchObject({ sessionId, ownerId });
			expect(session.events).toEqual([
				expect.objectContaining({ role: 'USER', content: [{ text: 'I prefer tea to coffee' }] }),
			]);
		});

		it('Namespace → Create creates the namespace the model names', async () => {
			const sessionId = newSession('create-namespace');
			const name = `${runPrefix}-tool-made-ns`;

			const turn = await callTool(extras, sessionId, 'Create_namespace', { name });

			const [created] = toolResultItems(turn);
			expect(created).toMatchObject({ name, scope: 'SHARED', state: 'ACTIVE' });
			const id = created.namespaceId as string;
			namespacesToDelete.push(id);
			const fetched = await client.request<{ namespace: { name: string } }>({
				method: 'GET',
				path: `/namespaces/${encodeURIComponent(id)}`,
			});
			expect(fetched?.namespace.name).toBe(name);
		});

		it('Get Many with Return All gives the model every memory as one result', async () => {
			const sessionId = newSession('list');
			await seedMemories(
				[1, 2, 3].map((n) => ({
					id: `${runPrefix}-m-list-${n}`,
					text: `List item ${n}`,
					ownerId: listOwnerId,
				})),
			);

			const turn = await callTool(extras, sessionId, 'List_memories', {});

			// A tool without `$fromAI` has an empty schema; the model sends `{}`.
			expect(turn.toolCall).toEqual({ name: 'List_memories', arguments: {} });
			const items = toolResultItems(turn);
			expect(items.map((item) => item.id).sort()).toEqual([
				`${runPrefix}-m-list-1`,
				`${runPrefix}-m-list-2`,
				`${runPrefix}-m-list-3`,
			]);
			// One tool call, one tool message, two requests to the model in all.
			expect(turn.requests).toHaveLength(2);
			expect(turn.requests[1].messages.filter((m) => m.role === 'tool')).toHaveLength(1);
		});
	});

	describe('Tool and chat memory sub-node in one agent', () => {
		it('stores only the question and the answer, not the tool exchange', async () => {
			const sessionId = newSession('with-memory');
			await seedMemories([{ id: `${runPrefix}-m-with-memory`, text: 'The user likes jazz' }]);

			const turn = await callTool(withMemory, sessionId, 'Search_memories', {
				query: 'What music does the user like?',
			});

			expect(toolResultItems(turn).map((item) => item.id)).toContain(`${runPrefix}-m-with-memory`);
			const session = await client.getSession(sessionId);
			expect(session?.events.map((event) => [event.role, event.content[0].text])).toEqual([
				['USER', turn.chatInput],
				['ASSISTANT', turn.answer],
			]);
		});

		it('shows the first turn to the model on the second turn', async () => {
			const sessionId = newSession('with-memory-2');

			const first = await callTool(withMemory, sessionId, 'Search_memories', {
				query: 'anything from before',
			});
			const second = await chatTurn(withMemory, sessionId, 'hello again');

			expect(second.answer).toBe(`Echo: ${second.chatInput}`);
			const [request] = second.requests;
			const history = request.messages.map((m) => [m.role, stubMessageText(m)]);
			expect(history.map(([role]) => role)).not.toContain('tool');
			expect(history).toContainEqual(['user', first.chatInput]);
			expect(history).toContainEqual(['assistant', first.answer]);
			expect(history.at(-1)).toEqual(['user', second.chatInput]);
		});
	});

	describe('Two tool calls in one session', () => {
		it('runs a different tool on each turn', async () => {
			const sessionId = newSession('two-tools');

			const saved = await callTool(pair, sessionId, 'Save_memory', {
				text: `The user owns a parrot (${sessionId})`,
			});
			const searched = await callTool(pair, sessionId, 'Search_memories', {
				query: 'Does the user own a pet?',
			});

			expect(nodeRuns(saved.execution, 'Save memory')).toHaveLength(1);
			expect(nodeRuns(saved.execution, 'Search memories')).toHaveLength(0);
			expect(nodeRuns(searched.execution, 'Search memories')).toHaveLength(1);
			expect(nodeRuns(searched.execution, 'Save memory')).toHaveLength(0);
			expect(toolResultItems(saved)[0]).toMatchObject({ ownerId });
			expect(toolResultItems(searched).every((item) => item.ownerId === ownerId)).toBe(true);
		});
	});
});
