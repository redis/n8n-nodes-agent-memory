# Testing

The tests come in four layers, from fast to realistic. The background and the
survey of how other community nodes test are in
[`research.md`](research.md), §11.

| Layer | Command | Needs | What it checks |
|---|---|---|---|
| Unit | `npm test` | Nothing | The chat history and memory classes, `supplyData`, the action node's `execute`, and the credential's test request, against fake HTTP |
| Contract | `npm run test:contract` | Agent Memory | The chat history class, the action node and the credential's test request against the real REST API, without n8n |
| End-to-end | `npm run test:e2e` | Agent Memory, Docker | The built package inside a real n8n, driven through webhooks: the short suite, run on every pull request |
| Scenarios | `npm run test:e2e:scenarios` | Agent Memory, Docker | The same n8n, the full matrix: every option of both nodes and of the tool face, string data, item handling, and what the editor and a tool-calling model see on failure. Nightly and on demand |
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
`GET …/session-memory/{sessionId}` response with a real summary, and a unit
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

Each test seeds its own session: the read-only ones write their turns through
the insert webhook first. So any test can run alone, for example
`npx vitest run --project e2e -t "tool runs"`, and a failure points at the test
that owns the data. The restart test is its own `describe` at the end of the
file, since it restarts the container.

### Scenario tests and the n8n REST client

Tests under `test/e2e/scenarios/` are the vitest project `e2e-scenarios`
(`npm run test:e2e:scenarios`). They take about ten minutes and write a few
hundred records to the store, so pull requests run only `test:e2e`; the
nightly run and a manual run with "Run everything" run them. Known defects
are pinned as `it.fails` tests that assert the wanted behaviour: when a fix
lands, its marker starts failing and is flipped to `it`. The matrix, the
findings and the suggested fixes are in
[`complete-e2e-report.md`](complete-e2e-report.md).

The files do not depend on the fixture workflows. Each
file creates the workflows it needs inside the running n8n, through
[`test/e2e/n8n-api.ts`](../test/e2e/n8n-api.ts), and deletes them in
`afterAll`. The client logs in as the preset owner and offers:

- `createWorkflow(spec)` / `deleteWorkflow(id)`: the spec has the shape of a
  fixture file (`nodes`, `connections`, `settings`). Webhook node paths get a
  per-workflow prefix, so files never clash; the returned `webhooks` map gives
  the path for each trigger node. `createWorkflow` publishes the workflow and
  returns once its webhooks answer.
- `callWebhook(path, body)`: the status and body, without throwing, so a test
  can assert a 500. `callWebhookAndWait(workflowId, path, body)` also returns
  the execution the call produced.
- `executions(workflowId)`, `execution(id)`, `waitForExecution(workflowId,
  match)`: the saved executions, with the run data parsed.
- `executionError(execution)`: the error the editor shows on the failed node
  (`nodeName`, `message`, `description`, `httpCode`, `itemIndex`, `type`).
  `nodeOutput(execution, nodeName)` gives a node's output items.

To drive the AI Agent, send the chat message
`use tool <name> with <json-object>`: the stub answers with a call to that
tool, with those arguments, and after the tool result it replies
`The answer is <result>.`. n8n names a tool after its node, with spaces
replaced by `_`, so a node called "Search memories" is the tool
`Search_memories`. `stubRequestsContaining(marker)` in `harness.ts` returns
only the requests that mention a marker of your own (a session ID or a unique
query), so files that share the stub need not reset it.
[`test/e2e/scenarios/harness-smoke.test.ts`](../test/e2e/scenarios/harness-smoke.test.ts)
shows all of this.

With `E2E_REUSE_STACK=true`, a run uses a stack that is already up and leaves
it running, which makes a second run start in seconds:

```bash
npm run e2e:up                                   # once
E2E_REUSE_STACK=true npx vitest run --project e2e-scenarios test/e2e/scenarios/my.test.ts
```

If no stack answers, the run starts one as usual and still leaves it running.

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
  a running one, unless `E2E_REUSE_STACK=true` is set. Run `e2e:up` again
  afterwards.
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
| `E2E_REUSE_STACK` | unset | Set to `true` to run the tests against a stack that is already up, without rebuilding it, and leave it running; if none answers, the run starts one |
| `E2E_CREDENTIAL_TESTS` | unset | Set to `true` to run `credential-conditions.test.ts`, which sends wrong credentials to the gateway (six requests). The nightly run sets it; a wrong key sent often earns a Cloudflare ban |
| `E2E_N8N_LOG_LEVEL` | `info` | n8n log level |

After each test run and each `e2e:down`, the container logs are in
`test/e2e/.work/docker-compose.log`.

## CI

- [`ci.yml`](../.github/workflows/ci.yml) runs lint, type check, unit tests and
  the build on every push and pull request.
- [`e2e.yml`](../.github/workflows/e2e.yml) runs the contract tests and the
  short end-to-end suite on pull requests and on pushes to `main`. The nightly
  run, and a manual run with "Run everything", run every layer: unit,
  contract, end-to-end and the scenario matrix, with the wrong-credential
  scenarios enabled, and also against the latest n8n release
  (`npm run ci:nightly` is the same sequence without the credential
  scenarios). It needs the three
  `AGENT_MEMORY_*` repository secrets; without them, for example on pull
  requests from forks, the tests skip. On failure it uploads the container
  logs.

## Lint exceptions

`n8n-node lint` applies n8n's Cloud rules to every TypeScript file, and strict
mode forbids changing `eslint.config.mjs`. Some harness files read the
environment, spawn `docker`, print to the console, or hold the test owner's
password, so each disables the specific rules it needs, with a comment saying
why: `test/support/env.ts`, `test/e2e/harness.ts`, `test/e2e/stack.ts`,
`test/e2e/stack-cli.ts`, `test/e2e/global-setup.ts` and `test/e2e/n8n-api.ts`.
None of them is published: the package ships only `dist`.
