# Changelog

## 0.1.0 (unreleased)

- Initial scaffold generated with `@n8n/node-cli` 0.51.4 (`programmatic/custom-chat-memory` template).
- Redis Agent Memory API credential (server URL, store ID, bearer API key, health-check test).
- Redis Agent Chat Memory sub-node backed by Agent Memory session memory, with optional server-side summary.
- The session summary now reaches only the AI Agent. The Chat Trigger's "Load Previous Session" and the Chat Memory Manager no longer receive it, so it no longer shows in the chat widget or gets stored back as an event.
- Assistant messages that request tool calls are no longer stored as session events.
- Tests: unit tests (vitest), contract tests against a hosted Agent Memory service, and end-to-end tests that run the node inside n8n in Docker, with CI workflows for both.
- Redis Agent Memory action node, usable as an AI Agent tool: Long-Term Memory (Search, Get Many, Create, Get, Update, Delete, Move), Session (Get, Get Many, Delete, Add Event, Delete Event) and Namespace (Create, Get, Get Many, Update, Delete).
- Memory sub-node option "Recall Long-Term Memories" (off by default): searches the user's long-term memories with the current message on every turn and gives the results to the model, before the summary and the recent turns.
- Memory sub-node option "Verify Session Owner" (off by default): fails instead of reading or extending a session the server attributes to another user. The server itself accepts events from any user once a session exists.
- README: how session access and authentication work in n8n, and which Chat Memory Manager operations this backend supports.
- The memory sub-node is displayed as "Redis Agent Chat Memory", so it is told apart from the action node in the node picker. Its internal name is unchanged.
