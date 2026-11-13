# Redis Agent Memory for n8n

Memory for n8n AI Agents, backed by [Redis Agent Memory](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/): session history with server-side summaries, and long-term memory that the agent can search and save.

[![CI](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/ci.yml)
[![E2E](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/redis/n8n-nodes-agent-memory/actions/workflows/e2e.yml)
[![Coverage](https://codecov.io/gh/redis/n8n-nodes-agent-memory/branch/main/graph/badge.svg)](https://codecov.io/gh/redis/n8n-nodes-agent-memory)
[![npm version](https://img.shields.io/npm/v/%40redis%2Fn8n-nodes-agent-memory?logo=npm&logoColor=white)](https://www.npmjs.com/package/@redis/n8n-nodes-agent-memory)
[![npm downloads](https://img.shields.io/npm/dm/%40redis%2Fn8n-nodes-agent-memory?label=downloads%2Fmonth)](https://www.npmjs.com/package/@redis/n8n-nodes-agent-memory)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[![Discord](https://img.shields.io/discord/697882427875393627.svg?style=social&logo=discord)](https://discord.gg/redis)
[![YouTube](https://img.shields.io/badge/YouTube-redisinc-red?style=social&logo=youtube)](https://www.youtube.com/redisinc)
[![Twitter](https://img.shields.io/twitter/follow/redisinc?style=social)](https://twitter.com/redisinc)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-redisinc-blue?style=social&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iIzBBNjZDMiIgZD0iTTIwLjQ0NyAyMC40NTJoLTMuNTU0di01LjU2OWMwLTEuMzI4LS4wMjctMy4wMzctMS44NTItMy4wMzctMS44NTMgMC0yLjEzNiAxLjQ0NS0yLjEzNiAyLjkzOXY1LjY2N0g5LjM1MVY5aDMuNDE0djEuNTYxaC4wNDZjLjQ3Ny0uOSAxLjYzNy0xLjg1IDMuMzctMS44NSAzLjYwMSAwIDQuMjY3IDIuMzcgNC4yNjcgNS40NTV2Ni4yODZ6TTUuMzM3IDcuNDMzYy0xLjE0NCAwLTIuMDYzLS45MjYtMi4wNjMtMi4wNjUgMC0xLjEzOC45Mi0yLjA2MyAyLjA2My0yLjA2MyAxLjE0IDAgMi4wNjQuOTI1IDIuMDY0IDIuMDYzIDAgMS4xMzktLjkyNSAyLjA2NS0yLjA2NCAyLjA2NXptMS43ODIgMTMuMDE5SDMuNTU1VjloMy41NjR2MTEuNDUyek0yMi4yMjUgMEgxLjc3MUMuNzkyIDAgMCAuNzc0IDAgMS43Mjl2MjAuNTQyQzAgMjMuMjI3Ljc5MiAyNCAxLjc3MSAyNGgyMC40NTFDMjMuMiAyNCAyNCAyMy4yMjcgMjQgMjIuMjcxVjEuNzI5QzI0IC43NzQgMjMuMiAwIDIyLjIyMiAwaC4wMDN6Ii8%2BPC9zdmc%2B)](https://www.linkedin.com/company/redisinc/)
[![Instagram](https://img.shields.io/badge/Instagram-redisinc-blue?style=social&logo=instagram)](https://www.instagram.com/redisinc/)

[![n8n community node](https://img.shields.io/badge/n8n-community%20node-EA4B71?logo=n8n&logoColor=white)](https://docs.n8n.io/integrations/community-nodes/)
[![Docs](https://img.shields.io/badge/docs-Redis%20Agent%20Memory-DC382D?logo=redis&logoColor=white)](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/)
[![Guide](https://img.shields.io/badge/mkdocs-guide-526CFE?logo=materialformkdocs&logoColor=white)](https://redis.github.io/n8n-nodes-agent-memory/)

### Features

- **[Drop-in chat memory](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/chat-memory/)** — attach **Redis Agent Chat Memory** to an AI Agent's Memory input. The model gets the recent turns; the server folds older turns into a summary.
- **[Long-term memory](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/chat-memory/#what-the-model-receives)** — the server extracts lasting facts from each conversation. They are searchable by meaning across sessions, and the sub-node can recall them on every turn.
- **[Memory as a tool](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/action-node/#using-the-node-as-a-tool)** — **Redis Agent Memory Tool** lets the agent search and save memories when it decides to.
- **[Every REST operation](https://redis.github.io/n8n-nodes-agent-memory/latest/reference/operations/)** — the **Redis Agent Memory** action node manages long-term memories, sessions, namespaces and summary views from a workflow, one operation per REST call.
- **[Summary views](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/summary-views/)** — standing summaries the server keeps per user, session, namespace or memory type, for briefings and digests.
- **[Memory sources](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/provenance/)** — trace a memory to the session events it was extracted from, then correct or delete it.
- **[Per-user isolation](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/data-model/#user-id)** — a pinned **User ID** keeps one user's memories away from another; an optional owner check refuses sessions that belong to someone else.
- **No runtime dependencies** — the package calls the Agent Memory REST API through n8n's HTTP helpers and passes n8n's strict (Cloud-eligible) lint rules.

### Requirements

| Dependency           | Supported versions                                                                                                        |
|----------------------|---------------------------------------------------------------------------------------------------------------------------|
| n8n                  | 2.42.6, tested by the end-to-end suite, and nightly on the latest release; older releases that ship `@n8n/ai-node-sdk` may work but are not tested |
| `@n8n/ai-node-sdk`   | 0.32.4+, provided by n8n                                                                                                  |
| Redis Agent Memory   | a store on an Agent Memory service, with an API key                                                                       |

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Nodes

Installing the package adds three entries to n8n's node picker. Two of them are the same node shown in two places.

| Shown in n8n as | Kind | Where you find it | Who runs it |
|---|---|---|---|
| [Redis Agent Memory](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/action-node/) | action node | the main node list | the workflow, one operation per execution |
| [Redis Agent Chat Memory](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/chat-memory/) | memory sub-node | the AI Agent's **Memory** input | the AI Agent, on every turn, loads and saves the history |
| [Redis Agent Memory Tool](https://redis.github.io/n8n-nodes-agent-memory/latest/guide/action-node/#using-the-node-as-a-tool) | tool sub-node | the AI Agent's **Tool** input | the model, when it decides a call is needed |

**Redis Agent Memory** and **Redis Agent Memory Tool** are one node: n8n lists an action node that is usable as a tool under both names. The [Operations](https://redis.github.io/n8n-nodes-agent-memory/latest/reference/operations/) reference lists every parameter and output.

## Usage

1. Create a **Redis Agent Memory API** credential with your store's server URL, store ID and API key. The guide shows [where to find them](https://redis.github.io/n8n-nodes-agent-memory/latest/getting-started/installation/#create-the-credential).
2. Add an **AI Agent** node, triggered by a **Chat Trigger**.
3. Attach **Redis Agent Chat Memory** to the Agent's **Memory** input.
4. Set **User ID** to a stable identifier for the end user, taken from the authenticated trigger (a JWT claim, a Telegram or Slack sender ID), not from the request body.
5. Chat. Recent turns are replayed to the model, older turns are summarized, and facts about the user accumulate in long-term memory.
6. To bring those facts back in later conversations, either turn on **Recall Long-Term Memories** on the memory sub-node (every turn, no wiring), or attach a **Redis Agent Memory Tool** set to Long-Term Memory → Search (the agent decides when to look). Both can be combined.

The [Quick Start](https://redis.github.io/n8n-nodes-agent-memory/latest/getting-started/quick-start/) walks through these steps. The [Example Workflows](https://redis.github.io/n8n-nodes-agent-memory/latest/examples/) page explains the ready-to-import workflows in [`examples/`](examples/).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
