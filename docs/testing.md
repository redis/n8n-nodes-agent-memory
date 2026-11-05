# Testing

The tests come in three layers, from fast to realistic. The background and the
survey of how other community nodes test are in
[`design-draft.md`](design-draft.md), §11.

| Layer | Command | Needs | What it checks |
|---|---|---|---|
| Unit | `npm test` | Nothing | The chat history and memory classes, `supplyData`, the action node's `execute`, and the credential's test request, against fake HTTP |
| Contract | `npm run test:contract` | Agent Memory | The chat history class, the action node and the credential's test request against the real REST API, without n8n |
| End-to-end | `npm run test:e2e` | Agent Memory, Docker | The built package inside a real n8n, driven through webhooks |
| Manual | `npm run e2e:up` / `npm run e2e:down` | Docker | The same n8n, kept running for you to use in a browser |

`npm run typecheck` type-checks the tests as well as the node. vitest does not
type-check.

## Connecting to Agent Memory

Contract and end-to-end tests use a hosted Agent Memory service. Set these
variables in the environment, or copy [`.env.example`](../.env.example) to
`.env` (git ignores it) and fill it in:

| Variable | Purpose |
|---|---|
| `AGENT_MEMORY_SERVER_URL` | Base URL of the service |
| `AGENT_MEMORY_STORE_ID` | Store the tests write to |
| `AGENT_MEMORY_API_KEY` | API key for that store |

Without them, those tests skip. Only the test harness reads these variables:
the node never reads the environment, which n8n verification forbids.

One contract test is opt-in: with `AGENT_MEMORY_SUMMARY_TESTS=true` it writes
40 events to a fresh session, waits for the server's background summary (on
the hosted store this took about 20 seconds; the test allows 90) and checks
that the summary reaches the model and not the chat widget. CI sets the
variable. The same wire shape is also pinned without the network:
`test/unit/fixtures/session-with-summary.json` is a recorded
`GET …/sessions/{sessionId}` response with a real summary, and a unit
test maps it through the node's classes.

Every run prefixes the session and user IDs it creates with `it-<run>-<random>`,
and deletes its sessions and the long-term memories of its users at the end.
Concurrent runs on the shared store don't see each other's data. Long-term
memories are extracted asynchronously, so one extracted after cleanup can
survive; the prefix keeps it out of other runs.

## End-to-end tests

Before the tests, `test/e2e/global-setup.ts` calls `startStack()` in
[`test/e2e/stack.ts`](../test/e2e/stack.ts), which does the following:

1. Runs `npm run build`, then copies `package.json` and `dist` to
   `test/e2e/.work/nodes/node_modules/@redis/n8n-nodes-agent-memory`. That
   folder is mounted as n8n's `~/.n8n/nodes`, where n8n finds community
   packages at startup. Node types are therefore package-qualified, as in a
   real install, and `@n8n/ai-node-sdk` comes from n8n.
2. Writes `test/e2e/.work/fixtures/credentials.json` from the variables above,
   plus an OpenAI credential that points at the stub.
3. Seeds n8n with its CLI, before the server starts:
   `n8n import:credentials`, `n8n import:workflow`, then
   `n8n publish:workflow` for each workflow. n8n registers webhooks only at
   startup.
4. Starts the stack in [`test/e2e/docker-compose.yml`](../test/e2e/docker-compose.yml)
   and waits until the chat webhook answers.

The stack has two services:

- **n8n**, the stock `n8nio/n8n` image, pinned to 2.42.6 (`N8N_IMAGE_TAG`
  overrides it).
- **llm-stub** ([`test/e2e/llm-stub/server.mjs`](../test/e2e/llm-stub/server.mjs)),
  a stand-in for the OpenAI Chat Completions API. It answers
  deterministically and records each request, so tests can check which
  history the AI Agent sent to the model.

The workflows are in `test/e2e/fixtures/workflows/`:

- **Chat Memory Manager**: three webhooks (insert, load, clear), each driving a
  Chat Memory Manager that uses this node. No model is involved.
- **Chat agent**: Chat Trigger → AI Agent, with the stub model, this node as
  memory, and a Calculator tool. The node is also connected to the Chat
  Trigger, for "Load Previous Session".

The tests in [`test/e2e/memory.test.ts`](../test/e2e/memory.test.ts) cover
insert and load, separate sessions, clearing, Insert with Override All, a
second turn that sees the first, a turn with a tool call, loading a previous
session without the summary, and history that survives an n8n restart. They
also read the stored events straight from the Agent Memory API.
[`test/e2e/action-node.test.ts`](../test/e2e/action-node.test.ts) drives the
action node through webhooks, and asks n8n's own REST endpoint for the
Namespace locator's list, which runs the node's `searchNamespaces` with the
credential. Both files end with a group of tests that pin the fixes from the
design verification below, one per fix.

Two small helpers serve those tests. `harness.ts` can log in to n8n as the
preset owner and read the saved execution of a webhook call, so a test can
assert the `message`, `description`, `httpCode` and node name the editor shows
on a failed node; a webhook alone answers only `500 Error in workflow`. And a
chat message of the form `use tool <name> with <json-object>` makes the stub
model call that tool with those arguments (n8n names a tool after its node,
with spaces as `_`, so "Search memories" is `Search_memories`), which is how a
test makes the AI Agent run the action node as a tool.

Each test seeds its own session: the read-only ones write their turns through
the insert webhook first. So any test can run alone, for example
`npx vitest run --project e2e -t "tool runs"`, and a failure points at the test
that owns the data. The restart test is its own `describe` at the end of the
file, since it restarts the container.

## Manual testing in a browser

The same stack can stay running, so you can try the node in the n8n editor:

```bash
npm run e2e:up     # build the package, start a fresh stack, print how to log in
npm run e2e:down   # stop the stack and delete its data
```

`e2e:up` prints the address and login:

- **Editor:** <http://127.0.0.1:15678>
- **Login:** `e2e@example.com` / `E2e-test-password1`. `docker-compose.yml`
  presets this owner through n8n's `N8N_INSTANCE_OWNER_*` settings. The
  stack listens on 127.0.0.1 only and holds only test data.
- **Workflows:** "E2E: Chat agent" (open it and click **Open chat**) and
  "E2E: Chat Memory Manager". Both are active, so their webhooks also work.
- **Model:** replies come from the stub, which echoes your message, or calls the
  Calculator for "calculate 2+2". <http://127.0.0.1:18080/_requests> shows what
  the agent sent to the model, including the history loaded from memory.

The Agent Memory credential is filled from the `AGENT_MEMORY_*` variables. If
they are missing, the stack still starts with an empty "Agent Memory (e2e)"
credential, which you can fill in from the editor.

Things to know:

- **Code changes:** run `npm run e2e:up` again. It rebuilds the package and
  starts a fresh stack, so changes made in the editor are lost.
- **One stack at a time:** `npm run test:e2e` uses the same stack and replaces
  a running one. Run `e2e:up` again afterwards.
- **After a test run:** `E2E_KEEP_STACK=true npm run test:e2e` leaves the stack
  running for inspection; stop it with `npm run e2e:down`.
- **Data you create** in the stack stays in Agent Memory after `e2e:down`. Only
  the automated tests clean up after themselves.

### Options

| Variable | Default | Purpose |
|---|---|---|
| `N8N_IMAGE_TAG` | `2.42.6` | n8n image to test against |
| `E2E_N8N_PORT` | `15678` | Host port for n8n |
| `E2E_LLM_STUB_PORT` | `18080` | Host port for the stub |
| `E2E_KEEP_STACK` | unset | Set to `true` to leave the stack running after the tests; stop it with `npm run e2e:down` |
| `E2E_N8N_LOG_LEVEL` | `info` | n8n log level |

After each test run and each `e2e:down`, the container logs are in
`test/e2e/.work/docker-compose.log`.

## CI

- [`ci.yml`](../.github/workflows/ci.yml) runs lint, type check, unit tests and
  the build on every push and pull request.
- [`e2e.yml`](../.github/workflows/e2e.yml) runs the contract and end-to-end
  tests on pull requests, on pushes to `main`, nightly and on demand. The
  nightly run also tests the latest n8n release. It needs the three
  `AGENT_MEMORY_*` repository secrets; without them, for example on pull
  requests from forks, the tests skip. On failure it uploads the container
  logs.

## How the design was verified

On 2026-11-03 a one-off scenario suite ran the nodes inside n8n against the
hosted store: 217 tests in nine files, built as a matrix of every option of
the memory sub-node, the action node and its tool face against conditions
such as existing or missing data, another user's data, namespaces, valid
strings of every kind (emoji, CRLF, 20 KB, JSON as text, numbers from
expressions) and invalid input. Each file created its own workflows through
n8n's REST API and read the saved executions, so it could assert what the
editor shows on a failed node and what a tool-calling model receives. It did
not wait for the server's extraction or summaries.

It found nine defects and ten usability problems in the node. All were fixed
on 2026-11-04 except one that sits in `@n8n/ai-utilities` (the Chat Memory
Manager's Simplify Output returns content parts, not strings). Among the
defects: Search with "Filter Match = Any" returned other users' memories;
"Recall Long-Term Memories" did nothing unless Recall Query was also added;
a child namespace could never be created; Session → Get Many and Long-Term
Memory → Get Many failed without a filter; and every server error reached the
user as n8n's generic status text. Each fix was verified the same way: unit
tests written first and failing, the fix, the tests passing; the matching
e2e test failing against the previous build and passing after a rebuild.

The suite itself was then retired to keep the test setup small. The tests that
verify the fixes live on in the two e2e files, and the server's input rules it
established are in [`design-draft.md`](design-draft.md), §11.5.

## Lint exceptions

`n8n-node lint` applies n8n's Cloud rules to every TypeScript file, and strict
mode forbids changing `eslint.config.mjs`. Some harness files read the
environment, spawn `docker`, print to the console, or hold the test owner's
password, so each disables the specific rules it needs, with a comment saying
why: `test/support/env.ts`, `test/e2e/harness.ts`, `test/e2e/stack.ts`,
`test/e2e/stack-cli.ts` and `test/e2e/global-setup.ts`. None of them is
published: the package ships only `dist`.
