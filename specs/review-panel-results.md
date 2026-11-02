# Review panel results

- **Date:** 2026-10-28
- **Scope:** `HEAD` (commit 52b79b9, "Implement the Iris Agent Memory node")
- **Method:** `review-panel` workflow: 10 parallel reviewers, findings grouped by root cause, then an adversarial check of each blocker. 12 agents in total.
- **Result:** 3 blockers (all confirmed, 0 refuted), 14 decision-relevant findings, 4 refactoring proposals. 9 decision-relevant findings and the 4 proposals remain open.
- **Status (2026-10-29):** The 3 blockers and D2 are fixed and have been removed from this file. Item numbers are kept as in the original run. Line numbers refer to commit 52b79b9 and may have shifted since.
- **Decisions (2026-10-30):** Each remaining decision-relevant finding ends with the options considered and a recommendation.
- **Status (2026-11-02):** D1, D3, D7 and D14 are addressed and removed. D1: a probe showed the server sets `ownerId` from the first event and accepts events from any actor, so the node gained an opt-in "Verify Session Owner" option (off by default, to behave like the other memory nodes) and the README explains that the trigger authenticates callers. D3/D7: the README documents the Chat Memory Manager modes, "Insert > Override All" has an e2e test, and the new action node offers *Session → Delete Event* as the supported way to trim a session. D14: `docs/research.md` is the one research document; `specs/research.md` is gone. Background and the revised recommendations are in `docs/research.md` §7, §9.3, §9.4 and §12.

## Notes on this run

- The "C++/CMake" platform profile wasn't detected. The workflow script hardcodes it, and every reviewer got it. This is a TypeScript n8n community node. The reviewers read the TypeScript code anyway, and their findings cite real n8n and LangChain sources.
- The script also passed a placeholder line instead of the project rules, so the reviewers weren't given AGENTS.md. They could still read it from the repository.
- 9 of the 10 reviewers ran. The performance reviewer reported no issues. The problem-fit reviewer was skipped because the run had no change brief.
- Findings were grouped by the first 50 characters of each claim, so findings with the same root cause may appear more than once (for example D3 and D7, D4 and D6, D13 and P4).

## Decision-relevant findings

### D4. The node always cuts history to the last `windowSize * 2` events (default 20). Retained events that fall outside that window but are not yet in the server summary reach neither the model nor the summary. The parameter description does not warn about this, against the design decision recorded in the research notes.

**Locations:** `nodes/RedisAgentMemoryChatMemory/memory.ts:174; RedisAgentMemoryChatMemory.node.ts:88-97`

**Evidence:**

specs/research.md:79 says the response holds the *retained* events plus a summary of *older* turns. specs/research.md:304 says 'treat the server as the main control. Keep a generous default window and say in the parameter description that older turns live in the summary.' The implementation keeps the template default of 10, and the description reads only 'How many past interactions the model receives as context'. README.md:89 says 'Recent turns are replayed to the model, older turns are summarized', which implies no gap between the two.

**Anchors:** `const windowed = messages.slice(-this.memoryOptions.windowSize * 2);`

**Options:**

1. **Generous default and an honest description.** Raise the Context Window Length default from 10 to 50, raise the maximum, and change the description to say the server already trims the session and that turns outside the window are only in the summary. In the README, advise setting it at least as high as the number of events the store retains before summarizing, so no turn falls between the two. This is what the research notes (§9.3) decided.
2. **Drop the parameter.** Send every retained event plus the summary, and let the server's retention and the Agent's token trimming control the size. No gap by construction, but it removes a control that every other n8n memory node has, and a store with summarization turned off would send the whole history.
3. **Allow "0 = no limit".** Keep the parameter, default it to 0, and skip the slice when it is 0. Same effect as option 2 by default, while keeping the control for users who want it.

**Recommendation:** Option 1. It keeps the node's parameters in line with the other memory nodes and fixes the gap in the default configuration. Option 3 is a good fallback if a user reports that the window hides turns in practice; option 2 removes a control users expect. Whichever is chosen, the description must state the trade-off, because the parameter name suggests the window is the only limit.

### D5. Every 404 on GET and DELETE is treated as 'session does not exist'. A wrong Store ID, or a Server URL with a path suffix such as '/v1', therefore loads an empty history and reports a successful clear instead of a configuration error.

**Locations:** `nodes/RedisAgentMemoryChatMemory/RedisAgentMemoryChatMemory.node.ts:155; memory.ts:85,146`

**Evidence:**

`allowNotFound` turns any NodeApiError with httpCode 404 into `undefined`, whatever the response body says. The Chat Trigger's 'Load Previous Session' and the Memory Manager's load and clear operations then succeed silently against a store that does not exist. Only the later POST in `addMessage` fails loudly. To avoid swallowing misconfiguration, check the error body for a session-not-found code, or check the store once at supply time.

**Anchors:** `if (allowNotFound && String(apiError.httpCode) === '404') return undefined;`

**Options:**

1. **Swallow only the session-not-found error.** Read the 404 body and return `undefined` only when it carries the API's session-not-found code; rethrow every other 404. Needs the error body shape, which is not yet recorded; a contract test can pin it by comparing a missing session with a wrong store ID.
2. **Check the store once per execution.** Call `GET /v1/stores/{storeId}/health` in `supplyData` and fail with a clear configuration error. One extra request per workflow run, and a wrong Server URL suffix also fails there.
3. **Leave it to the credential test.** Rely on D10's credential test to catch a wrong store or URL when the credential is saved. Users can skip that test, and a store deleted later is never caught.

**Recommendation:** Option 1 if the API's 404 bodies differ for a missing session and a missing store, with a contract test that pins both. If they do not differ, option 2, since one `GET` per execution is cheap next to the model call and gives a readable error. Option 3 alone is not enough. Both options should keep the `clear()` path tolerant of a missing session, which is the one 404 that is not an error.

### D6. The window is applied to the events the server keeps after the summary. When the server keeps more than windowSize*2 events (20 by default), the turns between the summary point and the window are silently dropped: they are not in the summary and not in the window. The spec's fix for this was to treat the server as the main control and to say in the parameter description that older turns live in the summary. Neither was done: the default is still 10 and the description is unchanged.

**Locations:** `nodes/RedisAgentMemoryChatMemory/memory.ts:174`

**Evidence:**

memory.ts:174 messages.slice(-this.memoryOptions.windowSize * 2) runs on session.events, which per specs/research.md:79 are the retained events after summarizedUpToEventId. The code never reads summarizedUpToEventId. specs/research.md:304 calls for a generous default window and a description noting that older turns live in the summary. RedisAgentMemoryChatMemory.node.ts:91-92 still has default 10 and 'How many past interactions the model receives as context'.

**Anchors:** `SummaryAwareWindowedChatMemory.loadMessages windowing`

**Options and recommendation:** same root cause as D4; see the decision there.

### D8. The 'AI Agent with the Chat Trigger' tests share one session and depend on running in file order, so a single test cannot run alone and one failure cascades into misleading failures in later tests.

**Locations:** `test/e2e/memory.test.ts:101`

**Evidence:**

`const sessionId = newChatSession('chat')` is created once in the describe body. 'sends the earlier turn...' (l.124) expects 'My name is Ada.' that only l.115 writes. 'returns the history to the chat widget...' (l.150) asserts exactly four messages written by l.115 and l.124. 'keeps the history across an n8n restart' (l.162) expects length 4 and 'My name is Ada.'. If you run `-t "sends the earlier turn"` alone, or l.115 fails, later tests fail with toContainEqual or length mismatches that do not point to the missing setup. Each test could seed its own session, for example through the Memory Manager insert webhook, or the dependency could be made explicit with `describe.sequential` and a seeding beforeAll.

**Anchors:** `const sessionId = newChatSession('chat');`

**Options:**

1. **Each test seeds its own session.** The read-only tests ("returns the history to the chat widget", "keeps the history across an n8n restart") insert their turns through the Memory Manager insert webhook that the fixtures already provide, then assert. The two chat-turn tests become one two-turn test, since the second turn is the scenario under test.
2. **Make the order explicit.** `describe.sequential` plus a `beforeAll` that sends the first turn. Tests still share one session, but a failing setup fails once, in the hook, with its own name.
3. **One long test with named steps.** Simplest to write; one failure hides the later steps, and a single `it` cannot be run or skipped in parts.

**Recommendation:** Option 1. The insert webhook makes seeding cheap, each test can run alone with `-t`, and a failure points at the test that owns the data. Keep the restart test as its own `describe` because it is slow and restarts the container; seed it the same way.

### D9. The summary feature (on by default) is never checked against the real service. Only canned unit data asserts the wire field `summary.text`, and the contract and e2e tests that touch this path cannot fail if the summary is missing or misread.

**Locations:** `nodes/RedisAgentMemoryChatMemory/memory.ts:100`

**Evidence:**

memory.ts:100 reads `session.summary?.text || undefined`, so a different field name silently yields no summary. specs/research.md:79 documents `summarizedUpToEventId` and `summarizedEvents` but not `text`. The contract test 'windows the turns the model receives' (test/contract/session-memory.test.ts:114) filters out system messages before asserting, so it ignores the summary. The e2e test 'returns the history to the chat widget without system messages' (test/e2e/memory.test.ts:150) asserts no SystemMessage on a four-message session that has no summary, so it passes whether or not the leak exists, which specs/research.md:440 asks it to guard. Unit tests only feed fake `{ text: 'Earlier turns' }` objects.

**Anchors:** `return { summary: session.summary?.text || undefined, messages };`

**Options:**

1. **Contract test with a real summary.** Write enough turns to a fresh session, poll until the server's summary appears, then assert that `loadMessages()` starts with it and `getMessages()` does not. Depends on the store's summarization threshold and on the background job's timing, so it may be slow or need a store configured for testing.
2. **Fixture session in the test store.** Keep one session with a known summary in the hosted store and read it in a contract test. Fast and deterministic, but the fixture is state outside the repository that someone has to create and keep.
3. **Recorded real response.** Capture one real `GET …/session-memory/{sessionId}` response that includes a summary, commit it as a JSON fixture, and run the unit mapping against it. Also confirm the `summary.text` field against the API reference, since the research notes list only `summarizedUpToEventId` and `summarizedEvents`.
4. **Accept unit-only coverage.**

**Recommendation:** Option 3 now, option 1 as an opt-in contract test gated on an environment variable that names a store with a low summarization threshold. Option 3 pins the wire shape in the repository and costs nothing per run; option 1 is the only test that fails when the service changes. Option 2 trades flakiness for hidden state. Also change the e2e "without system messages" test to use a session that has a summary, or drop the claim it makes.

### D10. No test covers the credential test request (the store health check that README.md:46 promises), and its URL is built differently from the node's: it does not URL-encode storeId.

**Locations:** `credentials/RedisAgentMemoryApi.credentials.ts:61`

**Evidence:**

`url: '=/v1/stores/{{$credentials.storeId}}/health'` puts the raw storeId in the path, while the node uses `encodeURIComponent(credentials.storeId)` (RedisAgentMemoryChatMemory.node.ts, baseUrl), and unit tests use storeId 'store/1' to check that encoding. No unit, contract or e2e test calls `/health` or the credential `test` block, so a wrong path or an auth mismatch here would ship unnoticed. A contract test against `GET /v1/stores/{storeId}/health` would cover it.

**Anchors:** `url: '=/v1/stores/{{$credentials.storeId}}/health',`

**Options:**

1. **Encode in the expression.** `url: '=/v1/stores/{{ encodeURIComponent($credentials.storeId) }}/health'`. n8n's expression sandbox exposes `encodeURIComponent`, and the test already uses a method call for the trailing slash.
2. **Test `GET /health` without the store.** Avoids the encoding question but no longer checks the store ID, which is what the README promises.
3. **Share the URL builder.** Not possible for the credential test: `ICredentialTestRequest` is declarative and cannot call TypeScript. P3's shared builder can serve the node only.

**Recommendation:** Option 1, plus two tests: a unit test that builds the credential test URL with a store ID such as `store/1` and asserts the encoded path, and a contract test that calls `GET /v1/stores/{storeId}/health` with the real credential so an auth or path mismatch fails in CI. Option 2 weakens the test for a problem option 1 solves.

### D11. 'fails the run for other API errors' asserts only that something throws, so it cannot tell the intended NodeApiError for a 401 from any other error, such as a TypeError in the request adapter.

**Locations:** `test/unit/node.test.ts:136`

**Evidence:**

`await expect(memory.loadMemoryVariables({})).rejects.toThrow();` has no matcher. The behavior under test is the adapter's branch: wrap in NodeApiError, return undefined only for 404 when allowNotFound, otherwise rethrow. A regression that threw for an unrelated reason would still pass. Asserting `toBeInstanceOf(NodeApiError)` and `httpCode: '401'` (or `toMatchObject`) would pin the behavior and make failures readable.

**Anchors:** `await expect(memory.loadMemoryVariables({})).rejects.toThrow();`

**Options:**

1. `await expect(...).rejects.toBeInstanceOf(NodeApiError)` and `rejects.toMatchObject({ httpCode: '401' })`.
2. `rejects.toThrow(NodeApiError)` only: pins the type, not the status.

**Recommendation:** Option 1. Two lines, and a wrong error type or a swallowed status code both fail with a readable diff. Apply the same pattern to the 404 tests in the unit suite where they assert on behavior rather than on the error.

### D12. The README promises n8n >= 2.16, but the code is checked only against @n8n/ai-node-sdk 0.32.4, and e2e runs only on n8n 2.42.6 and latest. The SDK is a peerDependency that the host n8n supplies at runtime, so the node's behavior depends on the host's SDK version. Nothing tests the stated minimum.

**Locations:** `README.md:50`

**Evidence:**

package.json peerDependencies '@n8n/ai-node-sdk': '*'. node_modules/@n8n/ai-node-sdk is 0.32.4. .github/workflows/e2e.yml:46 matrix is ["2.42.6", "latest"] (nightly) or 2.42.6. The tool-call filter in addMessage (memory.ts, 'tool-call' / 'invalid-tool-call') relies on the host SDK's fromLcMessage putting AIMessage.tool_calls into content parts (ai-utilities converters/message.js:215-227). If an older host SDK does not do this, tool-request text such as 'Calling X with input' gets stored as ASSISTANT events, the very case the CHANGELOG says is fixed. Either add the 2.16 floor to the e2e matrix or raise the documented minimum to a tested version.

**Anchors:** `- Requires an n8n version that ships `@n8n/ai-node-sdk` (n8n ≥ 2.16).`

**Options:**

1. **Test the floor.** Add the 2.16 n8n image to the e2e matrix (nightly at least). One more Docker job; the harness's CLI steps (`import:workflow`, `publish:workflow`) and the SDK's `fromLcMessage` may behave differently there, which is the point of the test.
2. **Document the tested version.** Change the README to "n8n ≥ 2.42.6" (the version the e2e suite runs on), and set `peerDependencies['@n8n/ai-node-sdk']` to the tested range as documentation. Narrower claim, fully backed.
3. **Unit-test older SDK versions.** Install older `@n8n/ai-node-sdk` releases in CI and run the unit tests. Checks our code against the SDK's types, not the host's behavior.

**Recommendation:** Option 2 now. A minimum nobody tests is a promise the README cannot keep. Widen the claim only when option 1 backs it: add the older image to the nightly matrix when a user needs it or when the Cloud verification asks for a floor, and lower the README number to whatever passes. Option 3 adds CI time without testing the thing that varies.

### D13. SummaryAwareWindowedChatMemory extends WindowedChatMemory but overrides loadMessages(), which is the parent's only real logic. It re-implements the window slice and keeps a second copy of windowSize. The windowSize passed to super() is never read, because the parent's field is private and only its overridden loadMessages() uses it. The subclass inherits only saveTurn() and clear(), both a few lines each.

**Locations:** `nodes/RedisAgentMemoryChatMemory/memory.ts:164-185`

**Evidence:**

node_modules/@n8n/ai-utilities/dist/esm/memory/windowed-chat-memory.js: loadMessages() does `allMessages.slice(-this.windowSize * 2)` and is the only reader of the private `windowSize`. memory.ts:169 calls `super(agentMemoryHistory, { windowSize: memoryOptions.windowSize })`, and memory.ts:174 repeats `messages.slice(-this.memoryOptions.windowSize * 2)`. The override itself is justified: calling super.loadMessages() would issue a second GET to fetch the summary. But the inheritance now only looks like reuse. If the SDK changes its windowing rule (for example, trimming to whole turns), this class will silently diverge, and the dead super config hides that. Two options: extend BaseChatMemory and own windowSize, saveTurn, and clear outright, or document that the parent's windowing is replaced on purpose.

**Anchors:** `const windowed = messages.slice(-this.memoryOptions.windowSize * 2);`

**Options:**

- **A. Extend `BaseChatMemory`.** Own `loadMessages`, `saveTurn` and `clear` (the last two are a few lines each, copied from the SDK) and put the window rule in one named helper. The dead `windowSize` passed to `super()` goes away.
- **B. Keep `WindowedChatMemory`, cache the session.** `AgentMemoryChatHistory` caches the last `getSession()` result for one call, so `loadMessages()` can call `super.loadMessages()` for the window and read the cached summary without a second `GET`. Adds cache invalidation (a `saveTurn` after a `loadMessages` in one run must not serve stale data) to reuse five lines.
- **C. Keep the inheritance and document it.** A comment that the parent's windowing is replaced on purpose. The dead constructor argument stays.

**Recommendation:** Option A. The class already owns the only logic the parent has; making that explicit removes the dead argument and the risk of silent divergence from the SDK's rule. Option B buys reuse of five lines with a cache that has its own failure mode. Choosing A also closes P4.

## Refactoring proposals

### P1. `nodes/RedisAgentMemoryChatMemory/memory.ts:7-35 and nodes/RedisAgentMemoryChatMemory/RedisAgentMemoryChatMemory.node.ts:138-158`

**What to reshape:** The REST layer is split across two files. memory.ts holds the private wire types and the AgentMemoryRequest type. The node file builds the base URL from the credential, calls httpRequestWithAuthentication, maps errors to NodeApiError, and turns 404 into undefined. AgentMemoryChatHistory then hand-builds the session paths and event bodies.

**Why:** docs/research.md:282 and README.md:34 plan an action/tool node with a Session resource (Get, Delete, Add Event). Those are the three calls AgentMemoryChatHistory makes now. As things stand, that node would have to copy the base-URL code, the 404 handling and the wire types, or import them from inside a sibling node's folder. A small typed client gives the memory sub-node and the action node one shared contract.

**Target sketch:** Add a shared module, for example nodes/shared/agentMemoryApi.ts. It exports the wire types (SessionEvent, SessionResponse), a createAgentMemoryRequest(ctx: ISupplyDataFunctions | IExecuteFunctions, itemIndex) factory that holds the code from node.ts:138-158, and a thin AgentMemoryClient with getSession(id), appendEvent({sessionId, actorId, role, content, namespaceId}) and deleteSession(id). AgentMemoryChatHistory then only maps Message <-> SessionEvent and calls the client. supplyData shrinks to reading parameters, building the client, and wiring the history and memory.

### P2. `test/support/agent-memory-client.ts:15-26,38-59`

**What to reshape:** The test client redeclares the session wire types (StoredSessionEvent, StoredSession), which already exist privately in memory.ts:13-27. It also rebuilds the /v1/stores/{storeId} prefix and the session paths.

**Why:** The contract and e2e tests should check the same wire shape the node sends and parses. With two copies, a field rename in the API can be fixed in one file and missed in the other, and the tests would still pass against the stale copy. Once the client from proposal 1 exists, the test client needs only to supply a fetch-based AgentMemoryRequest; it can reuse the shared types and AgentMemoryClient for getSession and deleteSession.

**Target sketch:** Export the wire types and the path helpers (sessionPath(id), EVENTS_PATH) from the shared API module. The test client imports them, keeps only its fetch transport, and adds only the test-specific helpers (track, cleanup, deleteLongTermMemories).

### P3. `credentials/RedisAgentMemoryApi.credentials.ts:58-63 vs nodes/RedisAgentMemoryChatMemory/RedisAgentMemoryChatMemory.node.ts:141-143`

**What to reshape:** The credential test and the node each build the base URL, in different ways. The node strips trailing slashes and URL-encodes storeId. The credential test strips slashes but puts storeId into the path without encoding it.

**Why:** If a store ID contains characters that need encoding, the credential test and the real node calls hit different URLs, so the test can pass while the node fails, or the other way round. One canonical place to build the URL keeps the two in step.

**Target sketch:** Either encode storeId in the test expression ('=/v1/stores/{{encodeURIComponent($credentials.storeId)}}/health'), or have the credential's authenticate block set the base URL so the node and the test share it. Put the node's version in the shared createAgentMemoryRequest from proposal 1.

### P4. `nodes/RedisAgentMemoryChatMemory/memory.ts:164-185`

**What to reshape:** SummaryAwareWindowedChatMemory extends WindowedChatMemory but replaces loadMessages entirely. It keeps its own copies of the history (agentMemoryHistory) and windowSize (memoryOptions) and re-implements the windowSize * 2 slice from the SDK. From the parent it really reuses only saveTurn and clear.

**Why:** This is a small coupling cost. If the SDK changes how WindowedChatMemory windows messages (for example, by counting turns rather than messages), this subclass will drift from it without notice, while still looking like a windowed memory. Pick one: own the windowing outright, or reuse the parent's.

**Target sketch:** Option A: extend BaseChatMemory, implement loadMessages, saveTurn and clear directly, and name the window rule in one helper. Option B: have AgentMemoryChatHistory cache the last getSession() result for one call, so loadMessages can call super.loadMessages() for the window and read the cached summary without a second GET.
