# End-to-end scenario suite: complete report

_Date: 2026-11-03. Target: `@redis/n8n-nodes-agent-memory` 0.1.0 (branch `topic/tishun/tidy-up-repo`), n8n 2.42.6, the hosted Agent Memory QA store._

This report covers the end-to-end scenario suite built on 2026-11-03: what it tests, how it is run, what it found, and what to change in the node. Background on the test layers is in [`testing.md`](testing.md); the research behind the node is in [`research.md`](research.md), §11.

The suite is **not committed** and **not in CI**. Every file sits in the working tree under `test/e2e/`.

## Contents

1. [Summary](#1-summary)
2. [Scope and method](#2-scope-and-method)
3. [Infrastructure added](#3-infrastructure-added)
4. [The scenario files](#4-the-scenario-files)
5. [Results](#5-results)
6. [Findings](#6-findings)
7. [Server behaviours the suite had to accommodate](#7-server-behaviours-the-suite-had-to-accommodate)
8. [Limitations](#8-limitations)
9. [Suggested fixes](#9-suggested-fixes)
10. [Before committing the suite](#10-before-committing-the-suite)

---

## 1. Summary

- **217 tests in 9 files**, run inside a real n8n against the hosted store: **195 pass, 22 are expected failures** (`it.fails`), each pinning a defect or a usability problem in the node. One sequential run of the whole directory takes about 7 minutes on a running stack. `npm run typecheck`, `npm run lint` and `npm run format:check` are clean.
- The suite tests **our integration, not the server**: that the node builds the right request for every option, handles every answer, carries any valid string through unchanged, and shows the user something useful when input or server say no. No test waits for memory extraction or a server summary.
- **Nine defects** in the node, ranked in §6. The two that matter most: *Search with Filter Match = Any returns other users' memories*, and *Recall Long-Term Memories does nothing unless Recall Query is also added*. Three operations can never succeed as shipped (nesting a namespace, Session → Get Many without a filter, Long-Term Memory → Get Many without a filter).
- One cross-cutting problem drives ten of the pinned failures: **the server's error detail never reaches the user**. Every 400, 404 and 409 shows n8n's generic text; the server's `detail` (`SessionID: must contain only alphanumeric characters…`, `Memory Not Found`) sits only in `context.data`, which the editor does not show. One change in `nodes/shared/agentMemoryRequest.ts` clears them all (§9, fix 1).

## 2. Scope and method

**Nodes under test.** The three faces the user meets: **Redis Agent Chat Memory** (memory sub-node, through the AI Agent and the Chat Memory Manager), **Redis Agent Memory** (action node, 17 operations across three resources) and **Redis Agent Memory Tool** (the same node in the Agent's Tool picker).

**What counts as a scenario.** For each operation, the matrix is _options × conditions_: every parameter the user can set, each alone and in the combinations users are likely to pick; against data that exists, does not exist, or belongs to another user; with and without a namespace; with inputs that are valid strings of every kind (emoji, CJK, right-to-left, combining marks, CRLF, 8–20 KB, quotes, backslashes, markup, JSON as text, surrounding whitespace, numbers arriving from expressions) and inputs that are not valid (empty, whitespace-only, garbage dates, IDs the server refuses, limits above the cap). For every failure the test reads what the user would see on the node in the editor.

**How a test observes.** Each test file creates its own workflows through n8n's REST API in `beforeAll` and deletes them in `afterAll`. A test calls a webhook, then reads the saved execution: the node's output items (even when the webhook answered 500), or the error with `message`, `description`, `httpCode`, `itemIndex` and node name. For the AI Agent paths the stub model records every request, so a test can read the exact history, recall message and tool definitions the model received, and the tool result the model got back. The store is read directly through the test client to check what was written.

**Pinning rule.** Where the behaviour is a defect or a usability problem in the node, the test asserts the behaviour we _want_ and is marked `it.fails(...)`, with a comment saying what happens today. The suite stays green, and when the defect is fixed the marker starts failing and is flipped to `it`. Where the current behaviour is acceptable but worth knowing, a passing test pins it as is.

**Hygiene.** Every ID carries the run prefix from `test/support/env.ts`; sessions, memories, namespaces, workflows and extra n8n credentials are deleted in `afterAll`. The credential-failure file makes one request per test and was run three times in total.

## 3. Infrastructure added

All under `test/e2e/`. Documented in [`testing.md`](testing.md), "Scenario tests and the n8n REST client".

| File | Change |
|---|---|
| `n8n-api.ts` (new) | REST client for n8n 2.42.6: `POST /rest/login` (cookie cached in `.work/n8n-auth-cookie`, 429 retry, one re-login on 401); `createWorkflow(spec)` creates, activates (`POST /rest/workflows/:id/activate` with `versionId`) and waits until each webhook is registered (activation returns ~100 ms before that); `deleteWorkflow` (deactivate, archive, delete); `callWebhook` and `callWebhookAndWait` (never throw, return status and the finished execution); `executions`, `execution` (run data unflattened by a 20-line parser verified against `flatted`), `waitForExecution`; `executionError`, `nodeRuns`, `nodeOutput`. No new dependency. |
| `llm-stub/server.mjs` | `use tool <Name> with {json}` makes the stub call exactly that tool with those arguments; `The answer is <tool content>.` after a tool result; `GET /_requests?contains=<text>`; last 1000 requests kept. |
| `harness.ts` | `stubRequestsContaining(text)`; `StubRequest` gains `tools` and `tool_call_id`. |
| `global-setup.ts` | `E2E_REUSE_STACK=true` reuses a running stack and leaves it running. |
| `stack.ts`, `stack-cli.ts` | Workflow IDs discovered from the fixture files; `e2e:up` prints the reuse command. |
| `scenarios/harness-smoke.test.ts` | Proves the chain: a REST-created workflow, an empty-parameter error, a 404, and a tool call through the Agent. |

Verified facts worth keeping: the tool node type is `@redis/n8n-nodes-agent-memory.redisAgentMemoryTool`, typeVersion 1; n8n names the function after the node name with every run of characters outside `[A-Za-z0-9_-]` replaced by `_` ("Search memories" → `Search_memories`); the auto description is `<operation action> in Redis Agent Memory`; the schema's required keys are exactly the `$fromAI` keys, including keys nested in a collection; `$('Chat Trigger').item.json.sessionId` resolves inside a tool node; the Chat Trigger passes extra JSON fields of a `sendMessage` body through to `$json`, so one workflow with option expressions can drive a matrix.

Run one file with:

```bash
npm run e2e:up                      # once; builds and starts the stack
E2E_REUSE_STACK=true npx vitest run --project e2e test/e2e/scenarios/<file>
```

## 4. The scenario files

| File | Tests | Area |
|---|---|---|
| `long-term-memory.test.ts` | 38 | Create, string data, Get, Update, Delete, Move |
| `long-term-memory-search.test.ts` | 29 | Search, Get Many (incl. 105-item paging), several input items |
| `session.test.ts` | 37 | Add Event, Get, Get Many, Delete, Delete Event |
| `namespace.test.ts` | 30 | Create, Get, Get Many, Update, Delete |
| `credential-conditions.test.ts` | 6 | Server URL, API key and Store ID conditions; the credential test |
| `chat-memory-agent.test.ts` | 38 | Sub-node under the AI Agent: every option, IDs and strings, recall with a tool |
| `chat-memory-manager.test.ts` | 14 | Sub-node under the Chat Memory Manager |
| `memory-tool.test.ts` | 22 | The node as an Agent tool |
| `harness-smoke.test.ts` | 3 | Infrastructure |

Support files: `action-node-support.ts` (the action-node workflow builder, shared by the long-term-memory, session, namespace and credential files; it replaced two near-twin files on 2026-11-04), `chat-memory-support.ts`, `memory-tool-support.ts`.

### 4.1 `long-term-memory.test.ts`

| Operation | Test | Result |
|---|---|---|
| Create | stores text for a user and generates an `n8n-` ID | pass |
| | creating the same Memory ID twice leaves one memory and no error | pass |
| | a second create with the same ID overwrites the record | pass (pins F15) |
| | accepts the built-in types `semantic` and `episodic` | pass |
| | shows the server reason for a memory type the store does not know | pass |
| | tells the user why the memory type was refused | **it.fails** (F1) |
| | places the memory in a namespace | pass |
| | records the session the memory came from | pass |
| | splits topics on commas, trims them and drops blanks, but keeps duplicates | pass |
| | stores all additional fields together | pass |
| String data | keeps emoji, CJK, right-to-left text and combining marks | pass |
| | keeps line breaks, including CRLF | pass |
| | keeps an 8 KB text whole | pass |
| | keeps quotes, backslashes, markup and JSON as plain text | pass |
| | trims the text and the user ID at both ends | pass |
| | refuses whitespace-only text before calling the API | pass |
| | turns a numeric user ID into the string "42" | pass |
| | shows the server rule when the user ID has spaces or accents | pass |
| Get | returns the stored record | pass |
| | shows a not-found error for a missing ID | pass |
| | names the missing resource in the error the editor shows | **it.fails** (F1) |
| | encodes IDs that need it and still reaches the API (`a b`, `a%2Fb`, `ünïcode`) | pass |
| | gets a plain-text 404 from the server router for an ID with a slash | pass |
| | refuses an empty Memory ID before calling the API | pass |
| Update | changes the text and leaves the rest | pass |
| | changes the type, the session and the namespace one at a time | pass |
| | replaces the topics instead of merging them | pass |
| | moves the memory to another user when the User ID changes | pass |
| | changes every field at once | pass |
| | with no Update Fields fails with a 400 from the server | pass |
| | with no Update Fields tells the user to add a field, or returns the record unchanged | **it.fails** (F7) |
| | shows a not-found error for a missing memory | pass |
| Delete | deletes an existing memory and reports its ID | pass |
| | reports success again for a memory that is already gone | pass |
| | refuses an empty Memory ID before calling the API | pass |
| Move | moves a memory to a namespace | pass |
| | shows a not-found error for a namespace that does not exist | pass |
| | refuses an empty Namespace ID before calling the API | pass |

### 4.2 `long-term-memory-search.test.ts`

| Operation | Test | Result |
|---|---|---|
| Search | finds a memory for its user and nothing for another user | pass |
| | with Always Output Data, no hits become one empty item and a 200 | pass |
| | returns at most Max Results memories (6 stored, max 3) | pass |
| | filters by memory type | pass |
| | filters by namespace | pass |
| | filters by session | pass |
| | filters by topics, where any listed topic matches | pass |
| | drops far matches with a high Similarity Threshold and keeps them at 0 | pass |
| | with Filter Match = All needs every filter, with Any needs one | pass |
| | never returns another user's memories, even with Filter Match = Any | **it.fails** (F2) |
| | refuses a whitespace-only query before calling the API | pass |
| | with Max Results above 100 from an expression fails with the server limit | pass |
| | names Max Results when an expression sets it above 100 | **it.fails** (F10) |
| Get Many | lists every memory of a user (8) | pass |
| | filters by memory type / namespace / session / topics | pass (4) |
| | filters by session alone, without a user | pass |
| | stops at the limit (5 of 8) | pass |
| | 105 memories: returns 50 by default | pass |
| | 105 memories: returns all 105 with Return All | pass |
| | 105 memories: returns exactly 100 with limit 100 and 101 with limit 101 | pass |
| | with no filter at all fails with a 400 from the server | pass |
| | with no filter at all lists memories across the store | **it.fails** (F6) |
| Several items | stops at the item that fails and keeps what came before it | pass |
| | with On Error = Continue, puts an error item in place of the failed one | pass |
| | with On Error = Continue (using error output), routes the failed item to the error output | pass |
| | with On Error = Continue, an API failure becomes an error item with only the message | pass (pins F14) |

### 4.3 `session.test.ts`

| Operation | Test | Result |
|---|---|---|
| Add Event | stores a USER, an ASSISTANT and a SYSTEM event and returns each one | pass |
| | round-trips emoji, CJK, several lines, quotes and backslashes | pass |
| | round-trips a text of about 8 KB | pass |
| | trims leading and trailing whitespace from the text | pass |
| | rejects whitespace-only text with `'Text' is empty` | pass |
| | rejects an empty user id with `'User ID' is empty` | pass |
| | accepts Created At as a full ISO timestamp with a zone | pass |
| | reads Created At without a zone as UTC (the container's zone) | pass |
| | reads a date-only Created At as midnight UTC | pass |
| | accepts Created At from an n8n date expression | pass |
| | names 'Created At' in the error for a value that is not a date | **it.fails** (F8) |
| | binds the session to the namespace given | pass |
| | accepts a numeric session id from the input item | pass |
| | surfaces the server's 400 for the session ids `a b`, `a/b`, `ünïcode`, `q?x=1&y=2` | pass (4) |
| | shows the server's reason when it rejects a session id | **it.fails** (F1) |
| | reports the gateway's plain 404, not the API not-found, for a Get with a slash in the id | pass |
| | accepts an event from a second user and keeps the first user as owner | pass |
| Get | returns the owner and the events in the order they were added | pass |
| | returns the same events with Include Summarized Events on a session without a summary | pass |
| | surfaces the API's not-found for a session that does not exist | pass |
| | rejects an empty session id | pass |
| Get Many | returns every session of the filtered user with Return All (3 for A, 1 for B) | pass |
| | returns two items of shape `{ sessionId }` with a limit of 2 | pass |
| | returns only the sessions of the filtered user with the default limit | pass |
| | lists sessions without a filter | **it.fails** (F5) |
| Delete | deletes a session, after which Get reports not found | pass |
| | reports `deleted: true` again for a session that is already gone | pass |
| | rejects an empty session id | pass |
| Delete Event | deletes the first of two events and keeps the second | pass |
| | surfaces the API's not-found for a well-formed event id that does not exist | pass |
| | surfaces the API error for an event id of the wrong length | pass |
| | tells the user that the event id has the wrong length | **it.fails** (F1) |
| | surfaces the API's not-found for an event id that belongs to another session | pass |
| | rejects an empty event id | pass |

### 4.4 `namespace.test.ts`

| Operation | Test | Result |
|---|---|---|
| Create | creates a SHARED namespace when Scope is left at its default | pass |
| | creates a PERSONAL namespace for the user given | pass |
| | surfaces the server's 400 for PERSONAL without a User ID | pass |
| | tells the user that a PERSONAL namespace needs a User ID | **it.fails** (F1) |
| | nests a namespace under the parent given | **it.fails** (F4) |
| | surfaces the server's 400 when Parent ID is given (today's behaviour) | pass |
| | surfaces the API's not-found for a parent that does not exist | **it.fails** (masked by F4) |
| | surfaces the server's 400 for a name with non-ASCII characters / with 200 characters | pass (2) |
| | accepts a name of 64 letters, digits, underscores and hyphens | pass |
| | rejects an empty name | pass |
| | surfaces the server's 409 for the same name twice | pass |
| Get | returns the namespace with its id, name, scope and state | pass |
| | surfaces the API's not-found for a namespace that does not exist | pass |
| | surfaces the server's 400 for an id with a space | pass |
| | reports the gateway's plain 404 for an id with a slash | pass |
| | rejects an empty id | pass |
| Get Many | returns at most 2 items with a limit of 2 | pass |
| | returns every namespace, including all of this run, with Return All | pass |
| Update | renames a namespace and leaves its state alone | pass |
| | archives a namespace | pass |
| | surfaces the server's refusal to make an archived namespace active again | pass (pins F9) |
| | renames and archives in one call | pass |
| | surfaces the server's 400 for an update with no fields | pass |
| | tells the user that an update needs at least one field | **it.fails** (F7) |
| | surfaces the API's not-found for a namespace that does not exist | pass |
| Delete | deletes an empty namespace, after which Get reports not found | pass |
| | surfaces the server's 409 for a namespace that still holds a memory | pass |
| | surfaces the API's not-found for a namespace that does not exist | pass |
| | rejects an empty id | pass |

### 4.5 `credential-conditions.test.ts`

| Test | Result |
|---|---|
| a Server URL with a trailing slash behaves like the plain one: the API's 404 | pass |
| a Server URL with `/v1` appended shows the gateway's 403 as a credential problem | pass (pins F16) |
| a wrong API key shows the gateway's 403 as a credential problem | pass |
| a wrong but well-formed Store ID shows the gateway's 403 as a credential problem | pass (pins F16) |
| credential test: passes for the correct credential (`Connection successful!`) | pass |
| credential test: fails for a wrong API key with the bare word `Forbidden` | pass (pins F16) |

### 4.6 `chat-memory-agent.test.ts`

| Option | Test | Result |
|---|---|---|
| Context Window Length | sends the model only the last stored turn with a window of 1 | pass |
| | sends the model the last two turns with a window of 2 | pass |
| | sends the model every retained turn by default | pass |
| | gives the chat widget every turn whatever the window | pass |
| | accepts the window as the string `"1"` from an expression | pass |
| | sends every turn, without an error, when the window resolves to `0` / `""` / `"abc"` | pass (3, pins F13) |
| Include Summary | adds no summary message to a fresh session, option on / off | pass (2) |
| Namespace ID | binds the session to the namespace | pass |
| | recalls only the memories in the namespace when one is set | pass |
| | recalls memories from every namespace and from none when no namespace is set | pass |
| Recall | adds no memories to the history when the option is off | pass |
| | puts the recalled memories first, one bullet each, before the history | pass |
| | recalls at most Recall Limit memories | pass |
| | skips recall when the Recall Query is blank, even though memories exist | pass |
| | searches with the Recall Query, not the chat input, when one is set | pass |
| | never recalls another user's memories | pass |
| | does not store the recalled memories back as session events | pass |
| | does no recall when only the switch is on and no Recall Query was added | pass (pins F3) |
| | recalls with the chat input when only the switch is on | **it.fails** (F3) |
| | recalls with a chat input that carries the session ID as the query | pass |
| Verify Session Owner | refuses a turn by another user in the owner's session when on | pass |
| | lets another user join the owner's session when off | pass |
| | creates a session that does not exist yet, owned by the user, when on | pass |
| | accepts the owner's own session when on | pass |
| IDs and strings | fails the run when the User ID is empty | pass (pins F11) |
| | shows the User ID hint when the User ID is empty | **it.fails** (F11) |
| | fails the run when the Session ID is empty | pass |
| | shows the Session ID hint when the Session ID is empty | **it.fails** (F11) |
| | fails the run with the server's 400 for a session ID with spaces and unicode | pass |
| | fails the run with a 404 for a session ID that contains a slash | pass |
| | tells the user the session ID rule when the ID has an underscore | **it.fails** (F1) |
| | accepts a numeric session ID from the trigger and stores it as text | pass |
| | stores and replays a 20 KB message with emoji, CRLF and JSON byte for byte | pass |
| | lets a second user with the same session ID join the first user's session | pass |
| Recall + tool | recalls memories, runs the tool and stores only the question and the answer | pass |

### 4.7 `chat-memory-manager.test.ts`

| Mode | Test | Result |
|---|---|---|
| Insert | stores system, user and ai messages as SYSTEM, USER and ASSISTANT events | pass |
| | replays a stored system message to the model as a user message | pass |
| | creates the session with Override All when it does not exist yet | pass |
| Delete | does not fail with All Messages on a session that does not exist | pass |
| | with Last N, rewrites the session under the deleting user (not supported, see README) | pass (pins F17) |
| Get Many | with Simplify Output, groups each turn into a sender/content pair | pass (pins F12) |
| | with Simplify Output, gives the text of each message as a string | **it.fails** (F12) |
| | returns an empty group for a session that does not exist | pass |
| Several items | writes each item to the session and user of that item | pass |
| | fails at the item whose User ID is empty and leaves the later items unwritten | pass |
| Numeric IDs | coerces a numeric session ID and user ID to text | pass |
| Verify owner on insert | refuses to insert into another user's session | pass |
| | shows the owner mismatch on the memory sub-node | **it.fails** (F18) |
| | inserts into the owner's own session | pass |

### 4.8 `memory-tool.test.ts`

| Theme | Test | Result |
|---|---|---|
| Definitions | offers the model one function per tool node, named after the node | pass |
| Search | returns the matching memory text and ID to the model | pass |
| | tells the model that nothing matched | **it.fails** (F19) |
| | keeps the pinned User ID when the model sends another one | pass |
| | turns an empty query from the model into an error item, and the agent still answers | pass |
| | lets the model set Max Results (`$fromAI('limit', …, 'number')`) | pass |
| Create | stores the text for the pinned user and returns the generated ID | pass |
| | stores topics and a namespace the model gives in Additional Fields | pass |
| | stores a long text (~5 KB, emoji, newlines) | pass |
| | turns empty text from the model into an error item | pass |
| Other operations | Get returns an existing memory to the model | pass |
| | Get for a missing memory gives the model an error item and the editor the API's 404 | pass |
| | Get for a missing memory names the memory in the error the model gets | **it.fails** (F1) |
| | Delete removes the memory the model names | pass |
| | Update replaces the text of the memory the model names | pass |
| | Session → Add Event records the text under the chat session | pass |
| | Session → Get hands the model the events of the chat session | pass |
| | Namespace → Create creates the namespace the model names | pass |
| | Get Many with Return All gives the model every memory as one result | pass |
| Tool + sub-node | stores only the question and the answer, not the tool exchange | pass |
| | shows the first turn to the model on the second turn | pass |
| Two tools | runs a different tool on each turn | pass |

## 5. Results

```
E2E_REUSE_STACK=true npx vitest run --project e2e test/e2e/scenarios
 Test Files  9 passed (9)
      Tests  195 passed | 22 expected fail (217)
   Duration  424 s
```

`npm run typecheck`, `npm run lint` (0 problems) and `npm run format:check` pass. The 13 pre-existing e2e tests still pass with the changed harness.

How the user sees things, as measured:

| Situation | Webhook answer | In the editor (`resultData.error`) |
|---|---|---|
| Our own validation (`'Session ID' is empty`) on the action node | 500 `Error in workflow` | `NodeOperationError`, message `'Session ID' is empty`, `itemIndex` |
| The same on the sub-node under the AI Agent | 500 | message `Error in sub-node Redis Agent Chat Memory`, description `'User ID' is empty` (our description lost) |
| API 404 | 500 | `NodeApiError`, `httpCode "404"`, message `The resource you are requesting could not be found`, description `Request failed with status code 404`; `title`/`detail` only in `context.data` |
| API 400 | 500 | message `Bad request - please check your parameters`, description `Request failed with status code 400`; `detail` only in `context.data` |
| API 409 | 500 | message `Your request is invalid or could not be processed by the service` |
| Gateway 403 (wrong key, store or URL path) | 500 | message `Forbidden - perhaps check your credentials?`, no body |
| Node outputs no items (search with no hits) | 500 `No item to return was found` | execution `success`; with Always Output Data one `{}` item and 200 |
| Tool node fails inside the Agent | 200, `The answer is [{"error":"<message>"}].` | execution `success`; the tool node's run is red with the full error; the model gets only `message` |
| On Error = Continue | 200 | item `{ error: "<message>" }`; on the error output n8n merges the input item in |

## 6. Findings

Ranked by impact. "Pinned by" names the `it.fails` test, or the passing test that records today's behaviour.

### Defects

**F1. Server error detail never reaches the user.** For every 400, 404 and 409 the editor shows n8n's generic text; the server's Problem Details `title` and `detail` sit only in `context.data`. Observed details that a user would need: `SessionID: must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-).`, `EventID: the length must be exactly 32.`, `memories[0]: memory type "SEMANTIC" is not registered on this store`, `Limit: must be between 1 and 100.`, `cannot be blank` (PERSONAL namespace without User ID), `name must contain 1-64 letters, numbers, underscores, or hyphens`, `state can only be ARCHIVED`, `Request body is required but was empty or missing.`, `An exact root or sibling namespace already exists`, `A namespace with children or placed memories cannot be deleted`, and `Memory Not Found` / `Session Not Found` / `Namespace Not Found` / `Event Not Found`, which also tell apart the two IDs of a Move. The model, as a tool caller, gets the same generic text. Pinned by ten `it.fails` tests across five files (§4). Fix 1.

**F2. Search with Filter Match = Any returns other users' memories.** `memoryFilter()` puts `ownerId` into the same `filter` object as the optional filters, and `filterOp: 'any'` ORs them all. A search as user A with `filterOp: 'any'` and a topic filter returned user B's memory with that topic, though the User ID field promises "Only memories owned by this user are searched". Security-relevant. Pinned by `long-term-memory-search.test.ts` → `never returns another user's memories, even with Filter Match = Any`. Fix 2.

**F3. "Recall Long-Term Memories" alone does nothing.** Switching the option on without also adding Recall Query (the natural thing to do in the editor) gives `options.recallQuery === undefined`, `supplyData` turns it into `''`, and `loadMessages` skips a blank query. No recall, no warning. The README's "Defaults to `{{ $json.chatInput }}`" holds only when the user adds that option by hand. Pinned by `chat-memory-agent.test.ts` → `recalls with the chat input when only the switch is on`. Fix 3.

**F4. Nesting a namespace can never succeed.** The node always sends `scope` (default `SHARED`) together with `parentId`; the server answers 400 `a child cannot specify scope or ownerId`. The same request without `scope` succeeds and the child inherits the parent's scope. Pinned by `namespace.test.ts` → `nests a namespace under the parent given` (and the masked not-found case). Fix 4.

**F5. Session → Get Many without a filter always fails.** The server needs `filterOwnerId`, `namespaceRef` or `includeAll=true`; the node sends none when User ID is empty. `GET /session-memory?includeAll=true` works. Pinned by `session.test.ts` → `lists sessions without a filter`. Fix 5.

**F6. Long-Term Memory → Get Many without a filter always fails.** `{ filter: {} }` → 400 `Filter: at least one filter field is required.` Pinned by `long-term-memory-search.test.ts` → `with no filter at all lists memories across the store`. Fix 6.

**F7. Update with no Update Fields fails with a server 400.** The node builds `{}`; n8n's request helper sends no body for an empty object; the server answers `Request body is required but was empty or missing.` Same for Namespace → Update. Pinned by the two `tells the user that an update needs at least one field` tests. Fix 6.

**F8. A Created At that is not a date gives a bare `Invalid time value`.** `new Date('yesterday').toISOString()` throws a `RangeError`; the user sees that message with no field name, type or description. Pinned by `session.test.ts` → `names 'Created At' in the error for a value that is not a date`. Fix 7.

**F9. Namespace → Update → State offers "Active", which the server never accepts** (`state can only be ARCHIVED`). Pinned by `surfaces the server's refusal to make an archived namespace active again`. Fix 8.

### Usability

**F10. Max Results from an expression bypasses the 1–100 cap**; the server refuses with a detail the user does not see. Pinned by `names Max Results when an expression sets it above 100`. Fix 9.

**F11. Empty Session ID / User ID under the AI Agent loses our hint.** n8n wraps the sub-node error as `Error in sub-node Redis Agent Chat Memory` and demotes our message to the description; our description (`Set the ID of the user this conversation belongs to`) is dropped. Pinned by two `it.fails` in `chat-memory-agent.test.ts`. Fix 10.

**F12. Chat Memory Manager with Simplify Output returns content parts, not strings:** `{ human: [{ type: 'text', text: '…' }], ai: [...] }` where n8n's own memories give `{ human: '…', ai: '…' }`. The conversion is the SDK's. Pinned by `gives the text of each message as a string`. Fix 11.

**F13. Context Window Length from an expression that resolves to `0`, `""` or `"abc"` silently turns the window off** (`slice(-NaN)`/`slice(0)` returns everything). Below 50 retained turns this is indistinguishable from the default. Pinned as current behaviour. Fix 12.

**F14. Continue-on-fail error items carry only the message.** `{ error: 'The resource you are requesting could not be found' }` says nothing about which ID or why. Fix 1 improves the message; the error output already merges the input item. Pinned as current behaviour.

**F15. Create with an existing Memory ID overwrites silently** (text, type, topics and `createdAt` replaced). The description says only "does not create a duplicate". Pinned by `a second create with the same ID overwrites the record`. Fix 13.

**F16. Every gateway 403 reads as a key problem.** A Server URL with an extra path segment, a wrong Store ID and a wrong key all show `Forbidden - perhaps check your credentials?`; the credential test says the bare word `Forbidden`. Pinned in `credential-conditions.test.ts`. Fix 14.

**F17. Delete Messages → Last N does more than the README says.** n8n clears the session and re-inserts the kept turns through our node: new event IDs, `actorId` and the session's `ownerId` become the deleting user. The README mentions only summary loss and re-extraction. Pinned by `with Last N, rewrites the session under the deleting user`. Fix 15.

**F18. Owner mismatch on the Memory Manager path is attributed to the manager node.** `SessionOwnerMismatchError` is a plain `Error`, so n8n reports it on the node that called `getMessages()`, with no `itemIndex`. Under the AI Agent it lands on the memory node. Pinned by `shows the owner mismatch on the memory sub-node`. Fix 16.

**F19. A Search tool with no hits hands the model `""`.** Zero output items become `JSON.stringify('')`; the Agent answers from nothing. Pinned by `memory-tool.test.ts` → `tells the model that nothing matched`. Fix 17.

### Observations, no action needed

- The server records the first writer as a session's `ownerId` and accepts events from any actor; two users who send the same session ID share one session, and the second user's model request contains the first user's turns. This is the behaviour the README documents and Verify Session Owner guards against.
- Unscoped recall returns the user's memories from every namespace and from none; scoped recall returns only the namespace's. `GET /session-memory/{id}` exposes `namespaceRef { namespaceId, name, path }` and `namespaceScope`.
- Add Event's output is the event alone; the namespace binding shows only through Session → Get.
- Delete of a missing session reports `deleted: true` (server 204); a missing namespace is a 404. Acceptable, but the two resources differ.
- `DELETE /long-term-memory` lists every requested ID under `deleted`, so the node's `was not deleted` check never fires today.
- Create returns what it sent, not the stored record: no `createdAt`/`updatedAt`, no server default `memoryType: 'semantic'`.
- A 20 KB message with emoji, CRLF and JSON survives store, model replay and widget byte for byte. Stored SYSTEM events reach the model as `user` messages, and the AI Agent 3.1 with empty options sends no system message of its own on 2.42.6.
- The Chat Memory Manager processes items in order and stops at the first failure: item 1 stored, items 2 and 3 not, `itemIndex: 1`.
- In the tool-plus-sub-node workflow the sub-node shows two `loadMemoryVariables` runs per turn in run data; n8n's doing, no visible effect.

## 7. Server behaviours the suite had to accommodate

- Session IDs, user IDs and memory IDs allow only `[A-Za-z0-9-]`. So the planned "URL-encoding round trip" cases (`a b`, `ünïcode`, `q?x=1`) became "server rejects, user cannot see why" cases; they still prove the node encodes and routes correctly, because the server's own validator answers. A `/` becomes `%2F`, which the gateway decodes before routing: plain-text `404 page not found`, with no Problem Details body, so `context.data` is empty.
- Event IDs are exactly 32 characters. Built-in memory types are lower case `semantic` and `episodic`. Namespace names are 1–64 of `[A-Za-z0-9_-]`; duplicates at the same level are 409; a namespace with children or memories cannot be deleted (409).
- Bulk create takes at most 100 records per call, so the 105-memory fixture is written in two calls. Search `limit` must be 1–100.
- Created At without a zone is read in the container's zone (UTC); a date-only value is midnight UTC.
- The hosted store's search returns a user's memories up to the limit even for an unrelated query (no default similarity cut-off); the "Recall Query is used" test relies on ranking with limit 1 and passed in every run.
- The Chat Trigger accepts a JSON-number session ID and an empty string; our node is what stops the empty one.

## 8. Limitations

- **Summaries.** A fresh session has none, so the Include Summary tests assert only that no summary message appears. The opt-in contract test (`AGENT_MEMORY_SUMMARY_TESTS=true`) covers a real summary. A window test above 50 turns was not run for the same reason: the server would start summarising the seed.
- **Extraction** is never awaited; recall fixtures are written directly to long-term memory.
- Not covered as tools: Move, Namespace Get/Update/Delete, Session Get Many/Delete/Delete Event (same code path as the covered ones). Several tool calls in one model turn were not tested: the stub calls one tool per message, so two turns were used.
- User ID character rules were not probed separately from session IDs. `retryOnFail` on a tool node was not tried.
- The credential-failure file is budgeted to run rarely; the earlier Cloudflare rate-limit ban came from repeated bad-key requests.

## 9. Suggested fixes

Ordered to match the findings. Each names the file and the pinned test that will flip from `it.fails` to `it` when it lands. Fixes 1 and 2 were applied on 2026-11-04 (see their **Status** lines); the rest are open.

**Fix 1 — surface the server's Problem Details (F1, helps F14).**

_Status: applied 2026-11-04._ `agentMemoryRequest.ts` now reads the Problem Details body after wrapping: `detail` becomes the message, `title` and the status the description (`Invalid Request (HTTP 400)`, `Memory Not Found (HTTP 404)`); a body without Problem Details keeps n8n's text. Verified fail-before/pass-after: 4 new unit tests in `test/unit/agent-memory-request.test.ts` and 6 flipped e2e tests. Two pins listed under F1 in the first version of this report do not flip with this fix alone, because the server's detail does not name the field: `tells the user that a PERSONAL namespace needs a User ID` (detail is `cannot be blank`) needs a node-side check (fix 6 family), and `names Max Results when an expression sets it above 100` needs fix 9. The 32 tests that pinned the old generic strings were updated to the server's words. The original proposal follows.

In `nodes/shared/agentMemoryRequest.ts`, after wrapping, read the parsed body and pass it on:

```ts
const body = apiError.context.data as { title?: string; detail?: string; type?: string } | undefined;
if (body && typeof body.type === 'string' && body.type.startsWith('/errors/')) {
	// Keep n8n's status text as the headline; put the server's reason where the editor shows it.
	apiError.description = body.detail
		? `${body.title ? `${body.title}: ` : ''}${body.detail}`
		: (body.title ?? apiError.description);
}
```

Better still for the model-as-caller case (tools get only `message`): when `title` is one of the not-found titles, use it as the `message` (`Memory Not Found`) and keep `detail` as the description. Flips: `tells the user why the memory type was refused`, `names the missing resource in the error the editor shows`, `names Max Results when an expression sets it above 100` (with fix 9), `shows the server's reason when it rejects a session id`, `tells the user that the event id has the wrong length`, `tells the user that a PERSONAL namespace needs a User ID`, `tells the user that an update needs at least one field` (×2, with fix 6), `tells the user the session ID rule when the ID has an underscore`, `Get for a missing memory names the memory in the error the model gets`. Add a unit test in `test/unit/agent-memory-request.test.ts` with a recorded Problem Details body.

**Fix 2 — keep the owner out of Filter Match (F2).**

_Status: applied 2026-11-04._ Both SDK versions were read: 0.3.1 (the live server's shape) has a request-level `filterOp: all | any`, 1.0.0 moves it to `filter.op: ALL | ANY`; in both it is one flat conjunction over every filter field, `ownerId` included, with no nested groups. The server therefore cannot express *owner AND (any of the rest)*, and no request shape makes "Any Filter" safe. The option was removed from Search (the node never sends `filterOp`, and ignores one left in a saved workflow), and a guard refuses to pass on a result whose `ownerId` is not the pinned user; the sub-node's recall drops such a result. The alternative, one search per optional filter merged client-side, was rejected: the live server returns no score, so the merged ranking would be a guess. Verified fail-before/pass-after: 3 new unit tests (`action-node.test.ts`, `memory.test.ts`) and the flipped e2e test. The original proposal follows.

In `RedisAgentMemory.node.ts`, `search`: do not let `filterOp` apply to `ownerId`. First check whether the SDK's filter model (`@redis-iris/agent-memory`, see the `agent-memory-api-sources` note) allows composing `and`/`or` groups; if it does, send `{ and: [ { ownerId: { eq } }, { or: [optional filters] } ] }`. If it does not, the safe fallback is to drop the "Any Filter" option, or to post-filter the page by `ownerId` and refetch until `maxResults` are found. Either way, add an item-level guard: throw a `NodeOperationError` if any returned record has an `ownerId` other than the requested one, so a server change can never leak again. Flips `never returns another user's memories, even with Filter Match = Any`. Add a unit test with a fake page that includes a foreign owner.

**Fix 3 — make recall work with the switch alone (F3).** Preferred: move `recallLongTermMemories`, `recallQuery` and `recallLimit` out of the Options collection to top-level properties, with `displayOptions: { show: { recallLongTermMemories: [true] } }` on the query and the limit. Top-level defaults are always evaluated, so `={{ $json.chatInput }}` applies the moment the switch is on, and the two fields appear only when relevant. Cheaper alternative inside `supplyData`: when `options.recallQuery` is `undefined`, fall back to `String(this.evaluateExpression('{{ $json.chatInput ?? "" }}', itemIndex) ?? '')`. Update the README row. Flips `recalls with the chat input when only the switch is on`.

**Fix 4 — omit scope and owner for child namespaces (F4).** In `namespace` → `create`: when `parentId` is set, send `{ name, parentId }` only. Change the Scope description to "Ignored when Parent ID is set: a child inherits its parent's scope." Flips `nests a namespace under the parent given` and `surfaces the API's not-found for a parent that does not exist`; retire `surfaces the server's 400 when Parent ID is given`.

**Fix 5 — list all sessions when no user is given (F5).** In `session` → `getAll`: add `includeAll: true` to `qs` when `ownerId` is empty. Flips `lists sessions without a filter`. (Optionally add a Namespace ID filter here too: the server accepts `namespaceRef`.)

**Fix 6 — refuse empty filters and empty updates with a clear message (F6, F7).** In `longTermMemory` → `getAll`: if `memoryFilter(filters)` is empty, throw `NodeOperationError("Add at least one filter", { description: 'The API needs a User ID, Memory Type, Namespace ID, Session ID or Topics filter to list memories' })`. In both `update` operations: if the record/body is empty, throw `"'Update Fields' is empty"` with a description. These replace server 400s with messages that name the parameter. Flips the two `tells the user that an update needs at least one field` tests; the Get Many `it.fails` should then be rewritten to assert the clear message instead (the server gives no wildcard).

**Fix 7 — validate Created At (F8).** In `session` → `addEvent`:

```ts
const parsed = createdAt ? Date.parse(createdAt) : Date.now();
if (Number.isNaN(parsed)) {
	throw new NodeOperationError(this.node, `'Created At' is not a date: "${createdAt}"`, {
		itemIndex: this.itemIndex,
		description: 'Use an ISO 8601 timestamp, for example 2024-03-15T10:00:00Z',
	});
}
```

Flips `names 'Created At' in the error for a value that is not a date`.

**Fix 8 — replace the State dropdown (F9).** In `NamespaceDescription.ts`, replace Update Fields → State with a boolean `archive` ("Archive", description: "Archiving cannot be undone through the API"), and send `state: 'ARCHIVED'` only when true. Adjust the operation's description ("Rename or archive a namespace" already says this).

**Fix 9 — clamp or validate limits that arrive from expressions (F10).** In `search` and `paging()`: if `maxResults`/`limit` is not an integer between 1 and 100, throw `NodeOperationError("'Max Results' must be between 1 and 100")` (or clamp and say so in the description). Flips `names Max Results when an expression sets it above 100`.

**Fix 10 — fold the hint into the message on the sub-node (F11).** In `RedisAgentMemoryChatMemory.node.ts`, n8n shows only the message for a sub-node error, so make it carry the hint: `"'User ID' is empty. Set the ID of the user this conversation belongs to."` (and the same for Session ID). Flips the two `shows the … hint` tests.

**Fix 11 — Simplify Output strings (F12).** The conversion from `Message.content` parts to LangChain messages is in `@n8n/ai-node-sdk`. Report it upstream with the observed shape; if a local fix is wanted, check whether the SDK accepts a string `content` for text-only messages and, if so, emit one in `getSession()`.

**Fix 12 — validate the window (F13).** In `supplyData`: `const windowSize = Number(options.windowSize); use Number.isInteger(windowSize) && windowSize >= 1 ? windowSize : DEFAULT_WINDOW_SIZE` and, for a value that is present but not a positive integer, throw `"'Context Window Length' must be a whole number of 1 or more"`. Pin with a unit test; the e2e test `sends every turn, without an error, when the window resolves to…` then changes to expect the error.

**Fix 13 — say "replaces" (F15).** Memory ID description: "Creating the same ID again replaces the memory's text, type and topics."

**Fix 14 — tell apart the gateway 403 (F16).** In `agentMemoryRequest.ts`, when `httpCode` is 403 and the body is not JSON, set the description to "The gateway refused the request. Check the API Key, and also the Server URL and Store ID: a wrong store or an extra path segment is refused the same way." In the credential, add a rule so the test says the same:

```ts
rules: [{ type: 'responseCode', properties: { value: 403, message: 'Forbidden: check the API Key, Server URL and Store ID' } }]
```

**Fix 15 — document Delete Last N fully (F17).** README, "Chat Memory Manager" paragraph: add that the kept turns are re-inserted with new event IDs under the deleting user, who also becomes the session's owner.

**Fix 16 — make the owner check an n8n error (F18).** Give `AgentMemoryChatHistoryOptions` a `node: INode` (and `itemIndex`) from `supplyData`, and throw `new NodeOperationError(node, message, { itemIndex, description })` instead of the plain `SessionOwnerMismatchError` (keep the class name in `message` or as a `cause` if the tests rely on it). Flips `shows the owner mismatch on the memory sub-node`.

**Fix 17 — give the model something on a miss (F19).** When the node runs as a tool (`this.getNode().type.endsWith('Tool')`) and `search`/`getAll` return no items, output one item such as `{ memories: [], message: 'No memories matched' }`; the Agent then sends the model a JSON array it can read. The action-node face keeps "no items" (n8n's convention, and `alwaysOutputData` exists). Flips `tells the model that nothing matched`.

## 10. Before committing the suite

- ~~Merge `action-support.ts` and `long-term-memory-support.ts` into one.~~ Done 2026-11-04: `action-node-support.ts`.
- `AgentMemoryTestClient.cleanup()` throws, and fails a whole file in `afterAll`, when a tracked session ID is one the server rejects; ignore 400 and body-less 404 there.
- ~~Give the scenarios their own vitest project.~~ Done 2026-11-04: project `e2e-scenarios`, `npm run test:e2e:scenarios`; `test:e2e` is the short suite again. The nightly `e2e.yml` runs unit, contract, e2e and scenarios; pull requests run contract and e2e. The suite was also pruned on 2026-11-04 (217 → about 180 cases): per-operation pins of the server's own rules were collapsed or dropped, every `it.fails` pin was kept, and the tests that pinned n8n's generic error text now assert the server's words (fix 1).
- ~~Make `credential-conditions.test.ts` opt-in.~~ Done 2026-11-04: `E2E_CREDENTIAL_TESTS=true`, set by the nightly run only.
- Each `it.fails` carries a comment naming the finding; when a fix lands, flip the marker and delete the comment. A fix that does not flip its marker is not done.
