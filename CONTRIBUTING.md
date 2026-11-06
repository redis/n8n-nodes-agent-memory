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

The repository keeps no changelog file. `npm run release` generates the GitHub
release notes from the commit list, so write each commit subject as the line a
user would read in the release notes.

## Pull requests

- Keep a pull request to one change. Open an issue first for a larger one.
- Add or update tests for the behavior you change.
- Run `npm run ci` before you push, or `npm run ci:build` if you have no
  Agent Memory store or Docker.
- CI runs the unit checks on every pull request. The contract and end-to-end
  tests need the `AGENT_MEMORY_*` repository secrets, so they skip on pull
  requests from forks; a maintainer runs them before merging.

## Releasing

Releases are published to npm **only** from GitHub Actions
([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) with npm
provenance, which n8n requires for verification from 1 May 2026. The
workflow authenticates with npm Trusted Publishing (OIDC); the repository
holds no npm token. The package's settings on npmjs.com name this repository
and `publish.yml` as the trusted publisher.

`version` in `package.json` on `main` is always the version under
development, the one the next release publishes. The workflow keeps it that
way: after each release it opens a pull request that bumps `main` to the next
minor version.

1. Check that `version` in `package.json` on `main` is the version you are
   about to release. If it is not (a patch instead of the prepared minor, or
   the bump pull request was never merged), open a pull request that sets it
   and merge it first.
2. Read the pull request titles since the last tag; GitHub turns them into
   the release notes. Edit any title that would not make sense to a user.
3. On GitHub, open **Releases → Draft a new release**. Create a new tag named
   with the bare version (`0.3.0`, not `v0.3.0`) on `main`, title it
   `Release <version>`, click **Generate release notes**, and tidy the list.
   Tick **Set as a pre-release** only to publish under the npm dist-tag
   `next`; a pre-release opens no bump pull request.
4. Click **Publish release**. Watch **Actions → Publish**: the `publish` job
   refuses to run when the tag and `package.json` disagree, then lints,
   builds and publishes with provenance; the `bump` job opens the
   next-version pull request.
5. Check the result and merge the bump pull request:

   ```bash
   npm view @redis/n8n-nodes-agent-memory@<version> version dist.attestations
   ```

   The npm package page shows the provenance badge and "Published via GitHub
   Actions". Workflows do not run on a pull request opened with
   `GITHUB_TOKEN`, so the bump pull request has no CI checks unless the
   repository has a `RELEASE_PR_TOKEN` secret (see the workflow header).

If the `publish` job fails before `npm publish`, delete the release and its
tag, fix `main`, and publish the release again. npm never accepts the same
version twice, so a failure after a successful publish needs a new version.

Do not run `npm run release` on your machine. Outside GitHub Actions it runs
release-it, which bumps, commits, tags and pushes a tag; a pushed tag creates
no GitHub release, so nothing is published, and `main` ends up one version
ahead of npm.
