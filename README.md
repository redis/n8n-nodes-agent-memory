# @redis/n8n-nodes-agent-memory

This is an n8n community node. It lets you use [Redis Agent Memory](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/) as the memory for n8n AI Agents.

Redis Agent Memory is a memory service for AI agents. It keeps the conversation history for each session and summarizes older turns in the background. It also extracts lasting facts into long-term memory that is searchable across sessions.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

> **Status: 0.1.0, unreleased.** Both nodes are implemented: **Redis Agent Chat Memory** (memory sub-node) and **Redis Agent Memory** (action and tool node). See [docs/research.md](docs/research.md) for background and design decisions.

[Installation](#installation) · [Nodes](#nodes) · [Credentials](#credentials) · [Compatibility](#compatibility) · [Usage](#usage) · [Development](#development) · [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Nodes

### Redis Agent Chat Memory (memory sub-node)

Connects to the **Memory** input of an AI Agent.

- **Loading history.** Returns the session's recent turns to the AI Agent. When enabled, they are preceded by the server-maintained summary of older turns and by long-term memories recalled for the current message. The Chat Trigger's "Load Previous Session" and the Chat Memory Manager get the turns only.
- **Saving history.** Appends each user and assistant message as a session event. Tool calls and tool results are not stored. Agent Memory then extracts long-term memories from the events asynchronously.

| Parameter | Description |
|---|---|
| Session ID | Conversation identifier. Defaults to `{{ $json.sessionId }}` from the Chat Trigger. |
| User ID | The user the conversation belongs to. Extracted long-term memories are owned by this user. |
| Options → Context Window Length | How many past interactions are sent to the model (default 50, max 500). Keep it at least as high as the number of turns the server retains; see below. |
| Options → Include Summary | Whether to prepend the summary of older turns (default on). |
| Options → Namespace ID | Binds the session to a namespace, so extracted memories land in it and recall searches only it. |
| Options → Recall Long-Term Memories | Whether to search the user's long-term memories on every turn and give the results to the model (default off). |
| Options → Recall Query | Text to search with. Defaults to `{{ $json.chatInput }}`, the current message. |
| Options → Recall Limit | Max memories to recall per turn (default 5). |
| Options → Verify Session Owner | Whether to refuse a session that the server says belongs to another user (default off). |

**Who may read a session.** Anyone who sends a session ID can read and extend that session; the node cannot tell a client from another. Authentication belongs to the trigger (Webhook with header or JWT auth, Chat Trigger with Basic or n8n user auth, Telegram or Slack sender IDs), and the workflow should take the Session ID from that authenticated context or derive it from the user. The server records the first writer as the session's owner but accepts events from any user after that. Turn on **Verify Session Owner** when every session belongs to one user: the node then fails instead of mixing two users' turns. Leave it off for shared sessions, such as group chats.

**Context window.** The history is trimmed in up to three places. The server keeps the recent turns of a session and folds older ones into the summary. The node then sends the model the last **Context Window Length** turns of what the server kept, preceded by the summary. The AI Agent may trim once more, by tokens, if you set its *Max Tokens From Memory*. The server is the main control: a turn it has retained but the summary does not cover yet is sent only if it falls inside the node's window. So keep **Context Window Length** at least as high as the number of turns your store retains before summarizing. The default of 50 is chosen for that; lower it only if your store retains fewer turns.

**Chat Memory Manager.** *Get Many Messages* and *Insert Messages* work. *Insert Messages* with *Override All Messages* replaces the session: the summary is dropped and the new messages are extracted as new content. *Delete Messages* with *All Messages* deletes the session. *Delete Messages* with *Last N* is not supported: n8n implements it by deleting the session and re-inserting the kept turns, which drops the summary and may extract the same facts again. To trim a session, use the action node's **Session → Delete Event**; to correct or remove what was learned, use **Long-Term Memory → Search** and **Delete**.

### Redis Agent Memory (action and tool node)

Manages what the memory sub-node writes, and lets an AI Agent search and save memories on purpose. Each operation is one REST call on the credential's store.

| Resource | Operations |
|---|---|
| Long-Term Memory | Search (by meaning, for one user), Get Many (by filters), Create, Get, Update, Delete, Move (to another namespace) |
| Session | Get, Get Many, Delete, Add Event, Delete Event |
| Namespace | Create, Get, Get Many, Update, Delete |

**As an AI Agent tool.** Attach one instance per operation to the Agent's **Tool** input and pin everything but the content: set **Resource**, **Operation** and **User ID** yourself, and let the model fill **Query** (Search) or **Text** (Create) with *Let the model define this parameter*. Two instances cover most agents:

- *Search memories*: Long-Term Memory → Search, User ID fixed. The agent calls it when it needs something it was told before.
- *Save memory*: Long-Term Memory → Create, User ID fixed. The agent calls it to remember a fact right away, without waiting for extraction.

Never let the model fill **User ID**: that is what keeps one user's memories away from another. Extraction is asynchronous, so a fact said in this turn may not be searchable until the next one.

## Credentials

Create a **Redis Agent Memory API** credential with:

- **Server URL**: the base URL of your Agent Memory service.
- **Store ID**: the store to use.
- **API Key**: the credential issued for your Agent Memory service or store. It is sent as a bearer token.

The credential test calls the store health endpoint.

## Compatibility

- Requires an n8n version that ships `@n8n/ai-node-sdk` (n8n ≥ 2.16).
- Built with `@n8n/node-cli` 0.51 and strict (Cloud-eligible) lint rules.

## Usage

1. Add an **AI Agent** node, triggered by a **Chat Trigger**.
2. Attach **Redis Agent Chat Memory** to the Agent's **Memory** input.
3. Set **User ID** to a stable identifier for the end user, taken from the authenticated trigger (a JWT claim, a Telegram or Slack sender ID), not from the request body.
4. Chat. Recent turns are replayed to the model, older turns are summarized, and facts about the user accumulate in long-term memory.
5. To bring those facts back in later conversations, either turn on **Options → Recall Long-Term Memories** on the memory sub-node (every turn, no wiring), or attach the action node as a **Search memories** tool (the agent decides when to look). Both can be combined.

## Development

```bash
npm install
npm run dev        # builds and starts n8n with this node at http://localhost:5678
npm run lint       # n8n community-node lint rules (must pass for verification)
npm run format     # prettier over the TypeScript and JavaScript sources; CI checks this
npm run build
npm test           # unit tests, no network
npm run e2e:up     # n8n in Docker with this package, for manual testing at http://127.0.0.1:15678
npm run e2e:down   # stop it
```

Contract and end-to-end tests run against a hosted Agent Memory service, and the end-to-end tests run the node inside a real n8n in Docker. See [docs/testing.md](docs/testing.md).

Notes:

- `npm run dev` runs n8n in a container from n8n 3.0 onward, so Docker or Podman is required. Use `npx n8n-node dev --external-n8n` to attach to your own instance instead.
- This package must have **no runtime dependencies**. It calls the Agent Memory REST API through n8n's HTTP helpers, not through the `@redis-iris/agent-memory` SDK. `@n8n/ai-node-sdk` and `n8n-workflow` are peer dependencies provided by n8n.
- Guidance for coding agents and contributors is in [AGENTS.md](AGENTS.md) and `.agents/`. These files were generated by `n8n-node`.

### Releasing

Releases are published to npm **only** from GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) with npm provenance. n8n requires this for verification from 1 May 2026.

1. Configure npm Trusted Publishing for `redis/n8n-nodes-agent-memory` → `publish.yml`, or set an `NPM_TOKEN` secret.
2. Run `npm run release` locally. It bumps the version, updates the changelog and pushes a tag. The tag triggers the publish workflow.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Redis Agent Memory documentation](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/)
- [Agent Memory REST API reference](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/api-reference/)
- [Research notes for this node](docs/research.md)

## License

[MIT](LICENSE)
