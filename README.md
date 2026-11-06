# Redis Agent Memory for n8n

Memory for n8n AI Agents, backed by [Redis Agent Memory](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/): session history with server-side summaries, and long-term memory that the agent can search and save.

[![CI](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/ci.yml)
[![E2E](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/e2e.yml)
[![Coverage](https://codecov.io/gh/redis/n8n-nodes-agent-memory/branch/main/graph/badge.svg)](https://codecov.io/gh/redis/n8n-nodes-agent-memory)
[![npm version](https://img.shields.io/npm/v/%40redis%2Fn8n-nodes-agent-memory?logo=npm&logoColor=white)](https://www.npmjs.com/package/@redis/n8n-nodes-agent-memory)
[![n8n community node](https://img.shields.io/badge/n8n-community%20node-EA4B71?logo=n8n&logoColor=white)](https://docs.n8n.io/integrations/community-nodes/)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Prettier](https://img.shields.io/badge/code%20style-prettier-F7B93E?logo=prettier&logoColor=white)](https://prettier.io/)
[![npm downloads](https://img.shields.io/npm/dm/%40redis%2Fn8n-nodes-agent-memory?label=downloads%2Fmonth)](https://www.npmjs.com/package/@redis/n8n-nodes-agent-memory)
[![Docs](https://img.shields.io/badge/docs-Redis%20Agent%20Memory-DC382D?logo=redis&logoColor=white)](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/)

[![Discord](https://img.shields.io/discord/697882427875393627.svg?style=social&logo=discord)](https://discord.gg/redis)
[![Twitch](https://img.shields.io/twitch/status/redisinc?style=social)](https://www.twitch.tv/redisinc)
[![YouTube](https://img.shields.io/youtube/channel/views/UCD78lHSwYqMlyetR0_P4Vig?style=social)](https://www.youtube.com/redisinc)
[![Twitter](https://img.shields.io/twitter/follow/redisinc?style=social)](https://twitter.com/redisinc)

### Features

- **Drop-in agent memory** — attach **Redis Agent Chat Memory** to an AI Agent's Memory input. Recent turns are replayed to the model; the server folds older turns into a summary.
- **Long-term memory** — Agent Memory extracts lasting facts from each conversation. They are searchable by meaning across sessions, and the sub-node can recall them on every turn.
- **Memory as a tool** — **Redis Agent Memory Tool** lets the agent search and save memories when it decides to. The same node, as the **Redis Agent Memory** action node, manages memories, sessions and namespaces from a workflow.
- **Full REST coverage** — long-term memories, sessions and namespaces, one operation per REST call on the credential's store.
- **Per-user isolation** — a pinned **User ID** keeps one user's memories away from another; an optional owner check refuses sessions that belong to someone else.
- **No runtime dependencies** — calls the Agent Memory REST API through n8n's HTTP helpers, and passes n8n's strict (Cloud-eligible) lint rules.

### Requirements

| Dependency           | Supported versions                                                      |
|----------------------|-------------------------------------------------------------------------|
| n8n                  | 2.42.6 tested; releases that ship `@n8n/ai-node-sdk`                    |
| `@n8n/ai-node-sdk`   | 0.32.4+, provided by n8n                                                |
| Redis Agent Memory   | a store on an Agent Memory service, with an API key                     |

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

> **Status: 0.1.0, unreleased.** Both nodes are implemented: **Redis Agent Chat Memory** (memory sub-node) and **Redis Agent Memory** (action node, listed as **Redis Agent Memory Tool** in the AI Agent's Tool picker).

[Installation](#installation) · [Nodes](#nodes) · [Credentials](#credentials) · [Compatibility](#compatibility) · [Usage](#usage) · [Development](#development) · [Resources](#resources) · [Contributing](#contributing) · [Security](#security)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Nodes

### Redis Agent Chat Memory (memory sub-node)

Connects to the **Memory** input of an AI Agent.

- **Loading history.** Returns the session's recent turns to the AI Agent. When enabled, they are preceded by the server-maintained summary of older turns, by a summary view's briefing on the user, and by long-term memories recalled for the current message. The Chat Trigger's "Load Previous Session" and the Chat Memory Manager get the turns only.
- **Saving history.** Appends each user and assistant message as a session event. Tool calls and tool results are not stored. Agent Memory then extracts long-term memories from the events asynchronously.

| Parameter | Description |
|---|---|
| Session ID | Conversation identifier. Defaults to `{{ $json.sessionId }}` from the Chat Trigger. |
| User ID | The user the conversation belongs to. Extracted long-term memories are owned by this user. |
| Recall Long-Term Memories | Whether to search the user's long-term memories on every turn and give the results to the model (default off). The switch alone is enough: the query defaults to the current message. |
| Recall Query | Text to search with; shown when recall is on. Defaults to `{{ $json.chatInput }}`, the current message. |
| Recall Limit | Max memories to recall per turn (default 5); shown when recall is on. |
| Options → Context Window Length | How many past interactions are sent to the model (default 50, max 500). Keep it at least as high as the number of turns the server retains; see below. An expression must resolve to a whole number of 1 or more, or the run fails; an empty value means the default. |
| Options → Include Summary | Whether to prepend the summary of older turns (default on). |
| Options → Namespace ID | Binds the session to a namespace, so extracted memories land in it and recall searches only it. |
| Options → Summary View ID | ID of a summary view grouped by user (see the action node's Summary View resource). When set, the view's summary of the User ID is given to the model on every turn, before the session summary, once the server has computed it; until then, and if the view is gone, nothing is added. Adds one request per turn. Empty by default. |
| Options → Verify Session Owner | Whether to refuse a session that the server says belongs to another user (default off). |

**Who may read a session.** Anyone who sends a session ID can read and extend that session; the node cannot tell a client from another. Authentication belongs to the trigger (Webhook with header or JWT auth, Chat Trigger with Basic or n8n user auth, Telegram or Slack sender IDs), and the workflow should take the Session ID from that authenticated context or derive it from the user. The server records the first writer as the session's owner but accepts events from any user after that. Turn on **Verify Session Owner** when every session belongs to one user: the node then fails instead of mixing two users' turns. Leave it off for shared sessions, such as group chats.

**Context window.** The history is trimmed in up to three places. The server keeps the recent turns of a session and folds older ones into the summary. The node then sends the model the last **Context Window Length** turns of what the server kept, preceded by the summary. The AI Agent may trim once more, by tokens, if you set its *Max Tokens From Memory*. The server is the main control: a turn it has retained but the summary does not cover yet is sent only if it falls inside the node's window. So keep **Context Window Length** at least as high as the number of turns your store retains before summarizing. The default of 50 is chosen for that; lower it only if your store retains fewer turns.

**Chat Memory Manager.** *Get Many Messages* and *Insert Messages* work. *Insert Messages* with *Override All Messages* replaces the session: the summary is dropped and the new messages are extracted as new content. *Delete Messages* with *All Messages* deletes the session. *Delete Messages* with *Last N* is not supported: n8n implements it by deleting the session and re-inserting the kept turns through this node, which drops the summary and may extract the same facts again. The kept turns also get new event IDs, their `actorId` becomes the user of the deleting workflow, and that user becomes the session's owner. To trim a session, use the action node's **Session → Delete Event**; to correct or remove what was learned, use **Long-Term Memory → Search** and **Delete**.

### Redis Agent Memory (action node) and Redis Agent Memory Tool

One node with two faces. In the node list it is **Redis Agent Memory**, an action node that manages what the memory sub-node writes. In an AI Agent's Tool picker n8n lists the same node as **Redis Agent Memory Tool**, and there it lets the agent search and save memories on purpose. Each operation is one REST call on the credential's store.

| Resource | Operations |
|---|---|
| Long-Term Memory | Search (by meaning, for one user), Get Many (by filters), Create, Get, Get Sources (the sessions or documents a memory came from), Update, Delete, Move (to another namespace) |
| Session | Get, Get Many, Delete, Add Event, Delete Event |
| Namespace | Create, Get, Get Many, Update, Delete |
| Summary View | Get Result (one group's summary), Refresh, Create, Get, Get Many, Update, Delete |

**Redis Agent Memory Tool.** Attach one **Redis Agent Memory Tool** per operation to the Agent's **Tool** input and pin everything but the content: set **Resource**, **Operation** and **User ID** yourself, and let the model fill **Query** (Search) or **Text** (Create) with *Let the model define this parameter*. Two instances cover most agents:

- *Search memories*: Long-Term Memory → Search, User ID fixed. The agent calls it when it needs something it was told before.
- *Save memory*: Long-Term Memory → Create, User ID fixed. The agent calls it to remember a fact right away, without waiting for extraction.

Never let the model fill **User ID**: that is what keeps one user's memories away from another. Extraction is asynchronous, so a fact said in this turn may not be searchable until the next one.

**Summary views.** A summary view is a standing summary the server keeps over long-term memories, one per group: per user, session, namespace or memory type. Create one with **Summary View → Create** (name, **Group By**, text or structured output, optional instructions and filters), then read a group with **Get Result**, giving the keys the view groups by under **Scope**, for example the User ID. A view with **Refresh Mode** *Manual* computes a summary only after **Refresh**; *Continuous* recomputes whenever the memories change, at a model call per change. A result's `status` is `COLD` or `PENDING` until it is computed, then `READY`, `EMPTY` or `FAILED`; **Wait For Result** polls every two seconds until one of those, up to **Max Wait** seconds, and a `FAILED` result is returned as an item with its `errorCode`. As a tool, pin the view and the User ID scope so the agent can ask for what is known about the current user in one call. Summary views must be enabled on the store.

**Output and namespaces.** Every operation that returns records has a **Simplify** switch, on by default. A memory keeps `memoryId`, `text`, `ownerId`, `memoryType`, `topics`, `namespaceId`, `sessionId` and `createdAt`, and on Search, Get and Get Many with **Include Sources** on, `sources`: `sourceId`, `kind`, `sessionId` or `documentId`, and `eventIds`; a source from Get Sources keeps `sourceId`, `kind`, `sessionId`, `documentId`, `revision`, `eventIds` (every event behind the source, in one list), `evidenceCount` (the number of evidence entries, not of events) and `capturedAt` (when the first evidence entry was recorded); a namespace keeps `namespaceId`, `name`, `scope`, `state`, `parentId` and `ownerId`; Session → Get keeps `sessionId`, `ownerId`, `namespaceId`, the `summary` text and the `events`, each with `eventId`, `actorId`, `role`, `text` and `createdAt`. A summary view keeps `viewId`, `name`, `visibility`, `groupBy`, `state`, `format`, `refreshMode` and `updatedAt`; its result keeps `viewId`, `status`, `stale`, the `text` or `data`, `computedAt`, `sourceMemoryCount`, `summarizedMemoryCount`, `truncated` and, when present, `sourceMemoryIds` and `errorCode`. Switch it off for the API's object as it came. The **Namespace** field of Namespace → Get, Update, Delete and Long-Term Memory → Move offers the store's namespaces from a list, or takes an ID or expression; the **View** field of Summary View does the same for the store's views.

## Credentials

Create a **Redis Agent Memory API** credential with:

- **Server URL**: found in the `AI Services / Iris / Agent Memory` page, `Configuration` tab, `General Settings` section. Enter the host only (`https://…`), without a path: the nodes add `/iris/data/v1/agent-memory` themselves.
- **Store ID**: found in the `AI Services / Iris / Agent Memory` page, `Configuration` tab, `General Settings` section
- **API Key**: found in the `AI Services / Iris / Agent Memory` page, `API Keys` tab

The credential test calls the store health endpoint.

## Compatibility

- Tested on n8n 2.42.6 by the end-to-end suite, and nightly on the latest n8n release. Older versions that ship `@n8n/ai-node-sdk` may work but are not tested; `@n8n/ai-node-sdk` ≥ 0.32.4 is the version range this node is built against.
- Built with `@n8n/node-cli` 0.51 and strict (Cloud-eligible) lint rules.

## Usage

1. Add an **AI Agent** node, triggered by a **Chat Trigger**.
2. Attach **Redis Agent Chat Memory** to the Agent's **Memory** input.
3. Set **User ID** to a stable identifier for the end user, taken from the authenticated trigger (a JWT claim, a Telegram or Slack sender ID), not from the request body.
4. Chat. Recent turns are replayed to the model, older turns are summarized, and facts about the user accumulate in long-term memory.
5. To bring those facts back in later conversations, either turn on **Recall Long-Term Memories** on the memory sub-node (every turn, no wiring), or attach a **Redis Agent Memory Tool** set to Long-Term Memory → Search (the agent decides when to look). Both can be combined.

### Example workflow

[`examples/agent-with-long-term-memory.json`](examples/agent-with-long-term-memory.json) is a workflow you can import: a Chat Trigger, an AI Agent with an OpenAI model, **Redis Agent Chat Memory** with *Recall Long-Term Memories* on, and two **Redis Agent Memory Tools**, *Search memories* and *Save memory*. Import it, select your Redis Agent Memory and OpenAI credentials, and chat: "I'm vegetarian and I live in Sofia." Then start a new chat, which is a new session, and ask "What should I cook tonight?" The answer uses what you said in the first conversation: the agent saved it with *Save memory*, the server also extracts such facts from the conversation on its own, and the memory node recalled it for the new turn. The example pins the User ID to `demo-user` in an Edit Fields node; in your workflow, take it from the authenticated trigger.

## Development

```bash
npm install
npm run dev        # builds and starts n8n with this node at http://localhost:5678
npm run lint       # n8n community-node lint rules (must pass for verification)
npm run format     # prettier over the TypeScript and JavaScript sources; CI checks this
npm run build
npm run ci         # everything CI runs: ci:build, then ci:e2e
npm run ci:build   # the CI workflow: format:check, lint, typecheck, test:coverage, build
npm test           # unit tests, no network
npm run test:coverage  # the same, with a coverage report in coverage/
npm run e2e:up     # n8n in Docker with this package, for manual testing at http://127.0.0.1:15678
npm run e2e:down   # stop it
npm run ci:e2e     # the E2E workflow: test:contract, then test:e2e
```

Contract and end-to-end tests run against a hosted Agent Memory service, and the end-to-end tests run the node inside a real n8n in Docker. See [docs/testing.md](docs/testing.md).

Notes:

- `npm run dev` runs n8n in a container from n8n 3.0 onward, so Docker or Podman is required. Use `npx n8n-node dev --external-n8n` to attach to your own instance instead.
- This package must have **no runtime dependencies**. It calls the Agent Memory REST API through n8n's HTTP helpers, not through the `@redis-iris/agent-memory` SDK. `@n8n/ai-node-sdk` and `n8n-workflow` are peer dependencies provided by n8n.
- Guidance for coding agents and contributors is in [AGENTS.md](AGENTS.md) and `.agents/`. These files were generated by `n8n-node`.
- [CONTRIBUTING.md](CONTRIBUTING.md) lists the checks CI runs, the test layers and the release process.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Redis Agent Memory documentation](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/)
- [Agent Memory REST API reference](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/api-reference/)
- [Design draft for this node](docs/design-draft.md)

## License

[MIT](LICENSE)
