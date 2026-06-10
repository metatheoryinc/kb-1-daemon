# Chunk 001: Daemon Scaffold

## Purpose

Establish the initial KB-2 implementation scaffold: a pnpm/Nx monorepo with a
runnable local daemon that can be developed, tested, and packaged through the
same project conventions we expect to use long term.

This chunk is not about implementing vault semantics yet. It is about proving
the basic local runtime shape: a daemon process can start, load configuration in
the expected order, manage a configurable KB-2 home directory, write and read a
small piece of daemon state, and expose a minimal health endpoint.

## Starting Context

The repository currently contains product and architecture documents only.

KB-2's local runtime should be inspired by established patterns in KB-1 and
Fleet Control:

- pnpm workspace
- Nx task orchestration
- TypeScript
- Vitest
- Hono-style HTTP service boundary
- pm2-friendly local dev process conventions
- checked-in root `.env` behavior that keeps Nx from implicitly loading env
  files out of order
- pnpm minimum release age protection for supply-chain resilience

The first runtime package should be named around the daemon concept:

- app directory: `apps/daemon`
- package name: `@kb-2/daemon`
- eventual binary name: `kb2d`

The daemon is the long-running local authority for one or more KB-2 vaults. In
this chunk it does not need to know how to host vaults yet.

## Desired End State

When this chunk is complete, KB-2 has a working TypeScript monorepo and a minimal
daemon process that can be run locally.

The daemon can:

- resolve a configurable KB-2 home directory
- default that home directory to a user-level location such as `~/.kb2`
- accept an override such as `KB2_HOME=/tmp/kb2-smoke`
- create its managed daemon directory if it does not exist
- write a harmless daemon status/sentinel file
- read that daemon status back for its health endpoint
- expose a local health endpoint that proves the daemon and filesystem round
  trip are working

The scaffold also makes room for future distribution:

- Docker image packaging
- npm CLI/package publishing
- local development through pnpm/Nx
- pm2-style process management for developer workflows

## Invariants

- KB-2 uses pnpm and Nx at the repo root.
- The workspace uses TypeScript from the beginning.
- The daemon is a Node process, not a Cloudflare Worker.
- The daemon app is named `daemon`, not `local-server`.
- The package is named `@kb-2/daemon`.
- The eventual daemon binary name is `kb2d`.
- The root `.env` is checked in and preserves the KB-1 convention of disabling
  Nx's implicit env loading with `NX_LOAD_DOT_ENV_FILES=false`.
- Env loading order is explicit and owned by KB-2 code/scripts, not by Nx
  default behavior.
- pnpm minimum release age protection is enabled in `pnpm-workspace.yaml`.
- Tests and manual verification must use configurable temp/home directories,
  never an accidental real user vault path.
- The daemon may create/write inside its configured KB-2 home directory.
- The daemon must not implement vault read/edit/move/search semantics in this
  chunk.
- The daemon must not contact a cloud relay in this chunk.
- The scaffold should be compatible with Docker packaging and npm CLI packaging,
  even if full release automation is deferred.

## Proposed Runtime Shape

The implementation can choose details, but the expected shape is roughly:

```text
apps/
  daemon/
    src/
      main.ts
packages/
  ...
```

The daemon home should have an initial structure similar to:

```text
$KB2_HOME/
  daemon/
    status.json
```

The exact status file schema can evolve, but it should include enough information
to verify that startup state was written by the current daemon process. Example
fields:

- service name, such as `kb2d`
- started timestamp
- daemon home path
- process id when available

## Acceptance Criteria

The chunk is complete when all of the following are true:

1. The repo has a pnpm workspace and Nx configuration.
2. The workspace includes a daemon app at `apps/daemon`.
3. The daemon package is named `@kb-2/daemon`.
4. The daemon can be run in development through pnpm, for example with a command
   equivalent to `pnpm --filter @kb-2/daemon dev`.
5. The daemon starts a local HTTP service.
6. The daemon exposes a health endpoint.
7. The health endpoint returns a successful response when the daemon is running.
8. The health response includes evidence that daemon state was read from the
   configured filesystem home.
9. A configurable home directory can be supplied with an environment variable
   such as `KB2_HOME`.
10. When started with a temp `KB2_HOME`, the daemon creates the expected managed
    directory and writes a daemon status/sentinel file.
11. Manual verification can show the status/sentinel file exists and contains
    current daemon metadata.
12. Automated tests are wired through Vitest.
13. At least one unit test covers internal config/home resolution behavior.
14. At least one integration-style test exercises the health endpoint without
    requiring a real user home or real vault.
15. The repo has a root `check` command that runs the meaningful scaffold checks,
    including typecheck and tests.
16. The scaffold includes package manager supply-chain hardening via pnpm's
    minimum release age settings.
17. The scaffold includes the root `.env` convention needed for explicit env
    loading order in an Nx workspace.
18. There is a documented path for Docker packaging, even if a fully optimized
    production image is deferred.
19. There is a documented path for npm CLI packaging with the future `kb2d`
    binary, even if publishing is deferred.
20. No vault content semantics are implemented beyond the daemon home sentinel.

## Manual Verification

A reviewer should be able to run an equivalent smoke flow:

```bash
pnpm install
pnpm check
KB2_HOME=/tmp/kb2-smoke pnpm --filter @kb-2/daemon dev
curl http://localhost:<port>/health
cat /tmp/kb2-smoke/daemon/status.json
```

The expected world after the smoke flow:

- the daemon process is running
- the health endpoint returns OK
- `/tmp/kb2-smoke/daemon/status.json` exists
- the status file identifies the daemon and configured home
- no real user vault was touched

## Testing Expectations

This chunk should establish the testing lanes, not test future vault behavior.

Required coverage:

- config/home resolution unit test
- health endpoint integration test
- temp directory usage for filesystem-touching tests

Deferred coverage:

- vault discovery
- Markdown reads
- splice edits
- filesystem materialization
- file watcher/direct write flares
- cloud relay behavior
- Yjs concurrent edit behavior

## Packaging Expectations

Docker and npm CLI distribution should be planned from the scaffold.

The implementation should make it plausible to run the same daemon code as:

- a development process from pnpm/Nx
- a Docker container
- an npm-installed CLI binary named `kb2d`

This chunk does not need a polished release pipeline. It should avoid choices
that would make those paths awkward later.

## Non-Goals

- No vault model.
- No search.
- No splice edit API.
- No move or rename API.
- No `.kb2` per-vault metadata format.
- No Git integration.
- No cloud relay connection.
- No auth or API key registration.
- No Yjs document runtime.
- No web UI.

## Open Questions

- Which port should the daemon use by default?
- Should local API auth be added immediately or in a later chunk?
- Should the first Docker artifact be a runnable Dockerfile, a documented plan,
  or both?
- Should pm2 process management copy KB-1's generated worktree-specific wrapper,
  Fleet Control's simpler ecosystem config, or start with scripts only?
- Should config be JSON, YAML, env-only, or layered?
