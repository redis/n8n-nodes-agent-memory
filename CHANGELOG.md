# Changelog

## Unreleased

**Breaking.** The nodes now call the unified Iris API (`/iris/data/v1/agent-memory/stores/{storeId}/…`), which the hosted Agent Memory service switched to on 2026-11-04. Servers that still serve `/v1/stores/{storeId}/…` are no longer supported. See `docs/iris-api-migration.md` for the full map.

- The credential's **Server URL** stays the host only; the nodes add the API path. The credential test names the Server URL when the server answers 404, and an empty 404 on any call now says the same.
- Long-Term Memory → Create uses the upsert (`PUT /memories/{memoryId}`), so a given Memory ID creates or replaces the memory as the field describes. Delete uses `POST /memories/bulk-delete`.
- Simplified memory output names the ID `memoryId` (was `id`); Delete and Move output `memoryId` too. Raw output follows the API: `memoryId`, flat `namespaceId` (was `namespaceRef`), and a `revision`.
- Session → Get Many returns one object per session (`sessionId`, `ownerId`, `namespaceId`, `createdAt`, `updatedAt` when the server has them) instead of the bare ID.
- Search sends `query` and `minScore` (the Similarity Threshold option) instead of `text` and `similarityThreshold`; lists page with `cursor`/`nextCursor`.
- Every create and update sends a fresh `idempotencyKey`, which stores with ingestion hooks require.
- Session → Add Event and the chat memory post to `/sessions/{sessionId}/events`; the server still creates the session on its first event.
- New resource **Summary View** on the action node: Get Result (one group's summary, with Wait For Result polling), Refresh, Create, Get, Get Many, Update and Delete. The View field lists the store's views. Summary views must be enabled on the store.
- Memory sub-node option "Summary View ID" (empty by default): when set, each turn also reads that view's summary of the user and gives it to the model, before the session summary.

## 0.2.0 (2026-11-04)

First release on npm, published from GitHub Actions with provenance.

- Initial scaffold generated with `@n8n/node-cli` 0.51.4 (`programmatic/custom-chat-memory` template).
- Redis Agent Memory API credential (server URL, store ID, bearer API key, health-check test).
- Redis Agent Chat Memory sub-node backed by Agent Memory session memory, with optional server-side summary.
- The session summary now reaches only the AI Agent. The Chat Trigger's "Load Previous Session" and the Chat Memory Manager no longer receive it, so it no longer shows in the chat widget or gets stored back as an event.
- Assistant messages that request tool calls are no longer stored as session events.
- Tests: unit tests (vitest), contract tests against a hosted Agent Memory service, and end-to-end tests that run the node inside n8n in Docker, with CI workflows for both.
- Redis Agent Memory action node, listed as Redis Agent Memory Tool in the AI Agent's Tool picker: Long-Term Memory (Search, Get Many, Create, Get, Update, Delete, Move), Session (Get, Get Many, Delete, Add Event, Delete Event) and Namespace (Create, Get, Get Many, Update, Delete).
- Memory sub-node option "Recall Long-Term Memories" (off by default): searches the user's long-term memories with the current message on every turn and gives the results to the model, before the summary and the recent turns.
- Memory sub-node option "Verify Session Owner" (off by default): fails instead of reading or extending a session the server attributes to another user. The server itself accepts events from any user once a session exists.
- README: how session access and authentication work in n8n, and which Chat Memory Manager operations this backend supports.
- The memory sub-node is displayed as "Redis Agent Chat Memory", so it is told apart from the action node in the node picker. Its internal name is unchanged.
- Memory sub-node "Context Window Length" now defaults to 50 interactions (was 10) and allows up to 500. The server already trims the session, so a small window could hide turns that the summary did not cover yet. The description and the README now explain this.
- A 404 counts as "session does not exist" only when the body is the API's own not-found (`type: /errors/resource-not-found`). Any other 404, such as a plain-text one from a proxy or a wrong URL, now fails the run. Errors that n8n's request helper has already wrapped keep the index of the item they belong to.
- End-to-end tests: each test seeds its own session, so any one of them can run alone and a failure no longer cascades into the later tests.
- `npm run format` and `npm run format:check` (prettier over the TypeScript and JavaScript sources); CI fails on unformatted code. All sources are formatted.
- Tests: a recorded session response with a real server summary pins the summary wire shape, and an opt-in contract test (`AGENT_MEMORY_SUMMARY_TESTS=true`, on in CI) waits for a real summary and checks that it reaches the model and not the chat widget.
- The credential test URL-encodes the Store ID, as the nodes do. A unit test resolves the credential test request with n8n's expression evaluator, and a contract test sends it to the real service.
- The memory class extends the SDK's `BaseChatMemory` and owns its window rule, instead of extending `WindowedChatMemory` and overriding its only logic. No change in behaviour.
- README states the tested n8n version (2.42.6, and nightly the latest release) instead of an untested minimum; `@n8n/ai-node-sdk` peer dependency is `>=0.32.4`.
- Unit tests assert the error type and HTTP status of failed API calls instead of only that something threw.
- The session wire types are exported from the memory module and the test client uses them, so the tests check the shape the node parses.
- Code coverage: `npm run test:coverage` reports unit-test coverage of the node sources with `@vitest/coverage-v8`; CI uploads it to Codecov.
- API errors now show the server's reason. The Agent Memory API answers every refusal with Problem Details; the node puts its `detail` in the error message (for example `SessionID: must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-).` or `The requested memory was not found`) and its `title` with the status in the description (`Invalid Request (HTTP 400)`, `Memory Not Found (HTTP 404)`), instead of n8n's text for the status code. A model that calls the node as a tool gets the same reason. Answers without Problem Details, such as the gateway's 403 page, keep n8n's text.
- Long-Term Memory → Search no longer offers "Filter Match". The API applies one conjunction to every filter field, so "Any Filter" also ORed the User ID away and returned other users' memories. Search now always needs every filter, ignores a `filterOp` left in a saved workflow, and refuses to pass on a result whose owner is not the User ID. The memory sub-node's recall drops such a result too.
- Tests: the nodes were verified inside n8n with a one-off scenario matrix (every option of both nodes and the tool face, against existing, missing and foreign data, namespaces, and valid and invalid strings; see docs/testing.md, "How the design was verified"). The fixes it led to are pinned by new tests in the two end-to-end files. For them, the e2e harness can read the saved execution of a webhook call, to assert what the editor shows on a failed node, and the stub model answers `use tool <name> with <json>` with a call to that tool.
- Memory sub-node: "Recall Long-Term Memories", "Recall Query" and "Recall Limit" are top-level parameters; the query and the limit show only when the switch is on. Switching recall on is now enough, since the query defaults to the current message. Before, the switch alone did nothing unless "Recall Query" was also added under Options. Recall settings left under Options by an older workflow are ignored.
- Memory sub-node: an empty Session ID or User ID carries its hint in the message (`'User ID' is empty. Set the ID of the user this conversation belongs to.`), because n8n shows only the message for a sub-node error.
- Memory sub-node: a Context Window Length that does not resolve to a whole number of 1 or more fails the run with `'Context Window Length' must be a whole number of 1 or more`, instead of silently sending every turn; an empty value means the default of 50.
- Memory sub-node: the "Verify Session Owner" refusal is an n8n error on the memory node, with the item index, under the AI Agent and the Chat Memory Manager alike. It was a plain error that n8n attributed to the calling node.
- Namespace → Create: a child namespace sends only its name and Parent ID, so nesting works; the child inherits its parent's scope. Before, the node always sent `scope`, which the API refuses for a child.
- Namespace → Create with Scope "Personal" and no User ID fails before calling the API: `A personal namespace needs a User ID`.
- Namespace → Update: the State dropdown (Active/Archived) is replaced by an "Archive" switch, since the API cannot make an archived namespace active again. Saved workflows that set `state` must switch to `archive`.
- Session → Get Many without a User ID lists every session (`includeAll=true`); before, the API refused the unfiltered request.
- Session → Add Event: a Created At that is not a date fails with `'Created At' is not a date: "…"` and an ISO 8601 hint, instead of a bare `Invalid time value`.
- Long-Term Memory → Get Many with no filter, and Update with no Update Fields (memory and namespace), fail before calling the API with a message that names the parameter, instead of a server 400.
- Long-Term Memory → Search: a Max Results set by an expression is checked (a whole number from 1 to 100) before the request, as is Get Many's Limit (1 or more).
- Long-Term Memory → Create: the Memory ID description says that creating the same ID again replaces the memory's text, type and topics.
- As an AI Agent tool, Long-Term Memory → Search and Get Many output `{ message: 'No memories matched' }` when nothing matched, so the model receives a JSON array it can read instead of `""`.
- A 403 from the gateway tells the user to check the Server URL and Store ID as well as the API Key, in the node error's description and in the credential test (`Forbidden: check the API Key, Server URL and Store ID`). The gateway answers a wrong URL path, store or key alike.
- README: what *Delete Messages → Last N* in the Chat Memory Manager does to the kept turns (new event IDs; `actorId` and the session owner become the deleting user).
- An example workflow, `examples/agent-with-long-term-memory.json`: Chat Trigger, AI Agent, Redis Agent Chat Memory with recall on, and the Search memories and Save memory tools, with a note on how to see long-term memory work across two chats.
- The description shown when a bulk endpoint answers without the memory's ID no longer uses the word "error", per n8n's UX guidelines.
- A **Simplify** switch, on by default, on every operation that returns records: Long-Term Memory → Search, Get Many, Get, Create and Update return `{ id, text, ownerId, memoryType, topics, namespaceId, sessionId, createdAt }`; Namespace → Create, Get, Get Many and Update return `{ namespaceId, name, scope, state, parentId, ownerId }`; Session → Get returns `{ sessionId, ownerId, namespaceId, summary, events }` with one `text` per event. Off, the node returns the API's object as before. Create now maps its echo through the same rule, so Create and Get agree.
- The **Namespace** of Namespace → Get, Update and Delete and of Long-Term Memory → Move is a resource locator: pick one of the store's namespaces from a searchable list, or give an ID or expression. The Namespace ID fields inside Filters, Additional Fields and Options stay plain strings. Saved workflows with a string value still run.
