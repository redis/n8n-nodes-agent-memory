# Changelog

## 0.1.0 (unreleased)

- Initial scaffold generated with `@n8n/node-cli` 0.51.4 (`programmatic/custom-chat-memory` template).
- Redis Agent Memory API credential (server URL, store ID, bearer API key, health-check test).
- Redis Agent Memory memory sub-node backed by Agent Memory session memory, with optional server-side summary.
- The session summary now reaches only the AI Agent. The Chat Trigger's "Load Previous Session" and the Chat Memory Manager no longer receive it, so it no longer shows in the chat widget or gets stored back as an event.
- Assistant messages that request tool calls are no longer stored as session events.
- Tests: unit tests (vitest), contract tests against a hosted Agent Memory service, and end-to-end tests that run the node inside n8n in Docker, with CI workflows for both.
