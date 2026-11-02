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
- Memory sub-node "Context Window Length" now defaults to 50 interactions (was 10) and allows up to 500. The server already trims the session, so a small window could hide turns that the summary did not cover yet. The description and the README now explain this.
- A 404 counts as "session does not exist" only when the body is the API's own not-found (`type: /errors/resource-not-found`). Any other 404, such as a plain-text one from a proxy or a wrong URL, now fails the run. Errors that n8n's request helper has already wrapped keep the index of the item they belong to.
- End-to-end tests: each test seeds its own session, so any one of them can run alone and a failure no longer cascades into the later tests.
- `npm run format` and `npm run format:check` (prettier over the TypeScript and JavaScript sources); CI fails on unformatted code. All sources are formatted.
