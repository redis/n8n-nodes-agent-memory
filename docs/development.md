# Development

The repository is a standard n8n community node package built with `@n8n/node-cli`. Guidance for contributors is in [`CONTRIBUTING.md`](https://github.com/redis/n8n-nodes-agent-memory/blob/main/CONTRIBUTING.md); this page is the short version.

## Commands

```bash
npm install
npm run dev        # builds and starts n8n with this node at http://localhost:5678
npm run lint       # n8n community-node lint rules (must pass for verification)
npm run format     # prettier over the TypeScript and JavaScript sources; CI checks this
npm run build
npm run ci         # everything CI runs: ci:build, then ci:e2e
npm run ci:build   # the CI workflow: format:check, lint, typecheck, test:coverage, build
npm test           # unit tests, no network
npm run test:coverage  # the same, with a coverage report in coverage/
npm run e2e:up     # n8n in Docker with this package, for manual testing at http://127.0.0.1:15678
npm run e2e:down   # stop it
npm run ci:e2e     # the E2E workflow: test:contract, then test:e2e
```

`npm run dev` runs n8n in a container from n8n 3.0 onward, so Docker or Podman is required. Use `npx n8n-node dev --external-n8n` to attach to your own instance.

## Constraints

- **No runtime dependencies.** The node calls the Agent Memory REST API through n8n's HTTP helpers, not through the `@redis-iris/agent-memory` SDK. `@n8n/ai-node-sdk` and `n8n-workflow` are peer dependencies provided by n8n.
- **Strict lint rules.** The package passes n8n's Cloud-eligible rules; every lint and type warning is addressed rather than disabled.
- **The node never reads the environment.** Only the test harness does; n8n verification forbids it in nodes.

## Tests

Three layers, from fast to realistic. The full description, including the Docker stack and the LLM stub, is in [`docs/testing.md`](https://github.com/redis/n8n-nodes-agent-memory/blob/main/docs/testing.md).

| Layer | Command | Needs | What it checks |
|---|---|---|---|
| Unit | `npm test` | Nothing | The chat history and memory classes, `supplyData`, the action node's `execute`, and the credential's test request, against fake HTTP |
| Contract | `npm run test:contract` | Agent Memory | The same against the real REST API, without n8n |
| End-to-end | `npm run test:e2e` | Agent Memory, Docker | The built package inside a real n8n, driven through webhooks |
| Manual | `npm run e2e:up` / `npm run e2e:down` | Docker | The same n8n, kept running for you to use in a browser |

Contract and end-to-end tests read `AGENT_MEMORY_SERVER_URL`, `AGENT_MEMORY_STORE_ID` and `AGENT_MEMORY_API_KEY` from the environment or a `.env` file (copy `.env.example`). Without them they skip. Tests that wait for the server's asynchronous work (summaries, summary views, extraction) are opt-in behind `AGENT_MEMORY_SUMMARY_TESTS`, `AGENT_MEMORY_SUMMARY_VIEW_TESTS` and `AGENT_MEMORY_EXTRACTION_TESTS`.

## Documentation

This site is built with [MkDocs](https://www.mkdocs.org/) and the Material theme from `docs/` and `mkdocs.yml`. To preview it:

```bash
uvx --with-requirements docs/requirements.txt mkdocs serve
```

or, with pip, `pip install -r docs/requirements.txt && mkdocs serve`. The `Documentation` workflow builds the site in strict mode on every pull request that touches it and deploys `main` to GitHub Pages with [mike](https://github.com/jimporter/mike) as the `latest` version.

The working documents behind the node live next to the site but are not part of it: [`docs/design-draft.md`](https://github.com/redis/n8n-nodes-agent-memory/blob/main/docs/design-draft.md) holds the background and design decisions, and [`docs/0.3.0-features.md`](https://github.com/redis/n8n-nodes-agent-memory/blob/main/docs/0.3.0-features.md) the feature specifications. `examples/` holds the workflows the [Examples](examples.md) page describes; when a node parameter changes, import them into n8n again to check that they still load and run.

## Releases

Releases are published to npm only from GitHub Actions, with npm provenance and Trusted Publishing; the repository holds no npm token. There is no changelog file: GitHub generates the release notes from the pull request titles since the last release. The steps are in [`CONTRIBUTING.md`](https://github.com/redis/n8n-nodes-agent-memory/blob/main/CONTRIBUTING.md#releasing).
