# Redis Agent Memory for n8n

**Memory for n8n AI Agents, backed by [Redis Agent Memory](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/)**: session history with server-side summaries, long-term memory the agent can search and save, and the operations to manage both from a workflow.

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

---

Installing `@redis/n8n-nodes-agent-memory` adds three entries to n8n's node picker. Two of them are the same node shown in two places.

| Shown in n8n as | Kind | Where you find it | Who runs it |
|---|---|---|---|
| **Redis Agent Chat Memory** | memory sub-node | the AI Agent's **Memory** input (AI → Memory → Other memories) | the AI Agent, on every turn: it loads the history before the model runs and saves the turn after |
| **Redis Agent Memory** | action node | the main node list, wired into the workflow like any other node | the workflow, one operation per execution |
| **Redis Agent Memory Tool** | tool sub-node | the AI Agent's **Tool** input | the model, when it decides a call is needed |

**Redis Agent Memory** and **Redis Agent Memory Tool** are one node: n8n lists an action node that is usable as a tool under both names. **Chat Memory Manager**, mentioned in the guide, is n8n's own node and not part of this package.

- **Redis Agent Chat Memory** holds the conversation. Recent turns go back to the model; the server folds older turns into a summary and extracts lasting facts about the user into long-term memory, which the node can recall on every turn.
- **Redis Agent Memory** manages long-term memories, sessions, namespaces and summary views, one operation per REST call. As **Redis Agent Memory Tool** the same operations are available to the agent, so it can search and save memories when it decides to.

The package calls the Agent Memory REST API through n8n's own HTTP helpers, has no runtime dependencies, and passes n8n's strict (Cloud-eligible) lint rules.

## Documentation

### Getting Started

- [**Installation**](getting-started/installation.md) - supported versions, how to install the community node, and how to create the credential.
- [**Quick Start**](getting-started/quick-start.md) - give an AI Agent memory in five steps and see a fact survive a new conversation.

### User Guide

- [**Users, Sessions and Namespaces**](guide/data-model.md) - the three identifiers that decide who sees what: the User ID that isolates users, the session that holds a conversation, and the namespace that groups memories for sharing.
- [**Chat Memory**](guide/chat-memory.md) - the memory sub-node: what the model is given, how the context window is trimmed, what n8n's Chat Memory Manager node can and cannot do.
- [**Action Node and Tools**](guide/action-node.md) - the resources and operations, how to pin a tool for an agent, and what the simplified output looks like.
- [**Summary Views**](guide/summary-views.md) - standing summaries the server keeps per user, session, namespace or memory type, for hand-off notes, digests and standing briefings.
- [**Memory Sources**](guide/provenance.md) - where a memory came from: the session and the events it was extracted from, for citations, audit and clean-up.

### Examples

- [**Example workflows**](examples.md) - six workflows to import, each built for a gap n8n users ask about: an agent with long-term memory, session lifecycle, shared memory across agents, hand-off packets and digests, tracing and correcting memories, and importing history.

### Reference

- [**Operations**](reference/operations.md) - every resource, operation and field of the action node and the chat memory node.

### Development

- [**Development**](development.md) - building, linting, the three test layers, and where the design notes live.
