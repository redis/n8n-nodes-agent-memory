# Contributing

## Prerequisites

- Node.js LTS (22 or later, the version n8n 2 runs on) and npm
- Docker or Podman, for `npm run dev` and the end-to-end tests
- Access to a Redis Agent Memory store, for the contract and end-to-end tests

## Setup

```bash
npm install
```

## Quick validation

One command runs everything the `CI` and `E2E` workflows run, in the same
order, and stops at the first failure:

```bash
npm run ci
```

It needs an Agent Memory store and Docker for the second half (see
[Tests](#tests)). The two halves also run on their own:

```bash
npm run ci:build   # the CI workflow: format:check, lint, typecheck, test:coverage, build
npm run ci:e2e     # the E2E workflow: test:contract, then test:e2e
```

Fix every lint and type error before opening a pull request. The lint rules
are n8n's strict (Cloud-eligible) rules; disable one only with a comment that
says why, and never in code that ships in `dist`.

## Lint and format

```bash
# Check (same as CI)
npm run lint
npm run format:check

# Auto-fix
npm run lint:fix
npm run format
```

## Type checking

```bash
npm run typecheck
```

This type-checks the node and the tests. vitest does not type-check.

## Tests

The tests come in three layers, from fast to realistic. See
[docs/testing.md](docs/testing.md) for the details of each.

| Layer | Command | Needs |
|---|---|---|
| Unit | `npm test` | Nothing |
| Contract | `npm run test:contract` | Agent Memory |
| End-to-end | `npm run test:e2e` | Agent Memory, Docker |

### Unit tests

```bash
npm test
npm run test:watch
npm run test:coverage   # also writes coverage/lcov.info; CI uploads it to Codecov
```

### Contract and end-to-end tests

Both need a hosted Agent Memory service. Copy `.env.example` to `.env` (git
ignores it) and fill in:

| Variable | Purpose |
|---|---|
| `AGENT_MEMORY_SERVER_URL` | Base URL of the service |
| `AGENT_MEMORY_STORE_ID` | Store the tests write to |
| `AGENT_MEMORY_API_KEY` | API key for that store |

Without them, these tests skip. Each run prefixes the IDs it creates and
deletes its data at the end, so concurrent runs on a shared store don't see
each other.

```bash
npm run test:contract
npm run test:e2e
npm run ci:e2e    # both, in the order the E2E workflow runs them
```

The E2E workflow also sets `AGENT_MEMORY_SUMMARY_TESTS=true`; set it in
`.env` to match it locally.

To run one end-to-end test:

```bash
npx vitest run --project e2e -t "tool runs"
```

### Manual testing in n8n

```bash
npm run dev        # n8n with this node at http://localhost:5678
npm run e2e:up     # the end-to-end stack, kept running at http://127.0.0.1:15678
npm run e2e:down   # stop it
```

`npm run dev` runs n8n in a container from n8n 3.0 onward. Use
`npx n8n-node dev --external-n8n` to attach to your own instance instead.
`e2e:up` prints the login; the stack listens on 127.0.0.1 only.

## Documentation

- `README.md` is the user-facing documentation and is shown on npm.
- `docs/testing.md` describes the test layers and the end-to-end stack.
- `docs/design-draft.md` holds the background and design decisions.
- `examples/` holds workflows the README points to. When a node parameter changes, import them into n8n again to check that they still load and run.
- `AGENTS.md` and `.agents/` guide coding agents and contributors.

Every user-visible change gets a line in `CHANGELOG.md` under the unreleased
version.

## Pull requests

- Keep a pull request to one change. Open an issue first for a larger one.
- Add or update tests for the behavior you change.
- Run `npm run ci` before you push, or `npm run ci:build` if you have no
  Agent Memory store or Docker.
- CI runs the unit checks on every pull request. The contract and end-to-end
  tests need the `AGENT_MEMORY_*` repository secrets, so they skip on pull
  requests from forks; a maintainer runs them before merging.

## Releasing

Releases are published to npm **only** from GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) with npm provenance. n8n requires this for verification from 1 May 2026.

1. Configure npm Trusted Publishing for `redis/n8n-nodes-agent-memory` → `publish.yml`, or set an `NPM_TOKEN` secret.
2. Before releasing, move the entries under `## Unreleased` in `CHANGELOG.md` to a heading for the new version. `npm run release` does not edit that file: release-it's `auto-changelog` step writes to the ignored `.auto-changelog.md` (see `.auto-changelog`), and the GitHub release notes it generates are a commit list.
3. In a checkout whose `origin` is `redis/n8n-nodes-agent-memory`, with dependencies installed (`npm ci`) and a `GITHUB_TOKEN` in the environment for the GitHub release, run `npm run release`. It lints, builds, bumps the version, commits, tags and pushes; the tag triggers the publish workflow, which publishes with provenance.
