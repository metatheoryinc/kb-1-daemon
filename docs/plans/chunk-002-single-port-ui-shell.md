# Chunk 002: Single-Port UI Shell

## Purpose

Add the first local web surface without adding vault behavior yet.

The daemon should serve both the local API and a SvelteKit client app from one
port. This gives future work one local product URL and proves that the daemon can
host the API and UI together in host-machine and Docker flows.

## Starting Context

Chunk 001 established the daemon scaffold, health endpoint, configurable
`KB2_HOME`, tests, Docker direction, and npm CLI direction.

The next step is a minimal SvelteKit UI shell that talks to the daemon API. We
use SvelteKit for frontend routing and build tooling, not because this local app
needs server-side rendering.

## Desired End State

One daemon port serves:

```text
/api/*  -> Hono daemon API
/*      -> built SvelteKit local UI
```

The local UI can load in a browser and render daemon status from the local API.
The API remains available under `/api/*`.

## Invariants

- One daemon port hosts both API and local UI.
- SvelteKit is client-side/static for this local UI; SSR is not required.
- The local UI talks to the daemon API; it does not read local files directly.
- The daemon remains the process users run locally or in Docker.
- This chunk does not implement vaults, Markdown editing, Yjs, MCP, or relay.
- The web scaffold should preserve the Storybook/component invariant for future
  UI work, even if Storybook itself lands in a later chunk.

## Acceptance Criteria

The chunk is complete when all of the following are true:

1. A SvelteKit local UI app exists at `apps/web`.
2. The UI app is configured for client-side/static output suitable for daemon
   hosting.
3. The daemon serves API routes under `/api/*`.
4. The daemon serves the built UI for non-API routes.
5. The local UI renders at `/` from the daemon port.
6. The local UI calls a daemon API endpoint, such as `/api/health`, and displays
   live daemon status.
7. Browser refresh on a client route still serves the UI shell.
8. Host-machine development flow is documented and works.
9. Docker flow is documented and works.
10. `pnpm check` covers the new UI and daemon changes.
11. Tests prove the routing split: an API route returns JSON and `/` returns the
    UI shell.
12. No vault content semantics are introduced.
13. No cloud relay, auth, users, orgs, or presence are introduced.

## Testing Expectations

Required coverage:

- daemon routing test for `/api/health`
- daemon static/UI fallback test for `/`
- typecheck/build coverage for the SvelteKit app
- root `pnpm check` includes the relevant daemon and web checks

Deferred coverage:

- browser automation
- Storybook visual review
- vault file reads
- editor behavior
- WebSocket/Yjs behavior

## Manual Verification

A reviewer should be able to run an equivalent host-machine flow:

```bash
pnpm install
pnpm check
KB2_HOME=/tmp/kb2-ui-smoke KB2_PORT=8787 pnpm --filter @kb-2/daemon dev
curl http://localhost:8787/api/health
open http://localhost:8787/
```

The expected world:

- the daemon process is running
- `/api/health` returns daemon health/status JSON
- `/` loads the local UI from the same port
- the UI displays health/status data fetched from the API

A reviewer should also be able to run the documented Docker flow and load the
same UI/API from the exposed daemon port.

## Non-Goals

- No Markdown editor.
- No file tree.
- No vault root configuration beyond existing daemon config.
- No Yjs.
- No WebSocket document server.
- No MCP tools.
- No cloud relay.
- No auth, users, orgs, billing, or presence.

## Decisions

- The UI app lives at `apps/web` with package name `@kb-2/web`. The cloud layer
  is closed source and lives outside this repo, so this repo's only web app is
  the local UI; no defensive naming needed.
- Frontend versions match KB-1's current catalog: Svelte 5, SvelteKit 2,
  Tailwind 4. This keeps the chunk 004 component import a copy, not a port.
- The UI uses `@sveltejs/adapter-static` with a SPA fallback page so client
  routes survive browser refresh when served by the daemon (criterion 7).
- The daemon is always the front door, in development and production alike:
  one process the user starts, one port, UI and API together. When the
  dev-only env var `KB2_WEB_PROXY_TARGET` is set (e.g. to the Vite dev server
  URL), the daemon proxies non-`/api` HTTP requests there; otherwise it serves
  the built static UI. Vite's HMR websocket connects directly to the Vite port
  via `server.hmr.clientPort`, keeping the daemon proxy HTTP-only and small.
  A root `pnpm dev` starts Vite and the daemon (with the proxy target set)
  with one command, so the dev experience is: run one command, open the
  daemon port. When neither a build nor a proxy target exists, non-API routes
  return a clear instructional message, not a 500.
  (Amended during review: the original decision kept proxy code out of the
  daemon, but "the daemon port is the product, always" is the product
  experience KB-2 wants, and the isomorphic dev/prod routing surfaces bugs
  earlier.)
- No UI build/version route in this chunk.

## Verification

After implementation is reported complete:

- the implementer runs `pnpm check` and the manual verification flow above and
  reports actual output, not expected output
- UI-facing criteria are verified in a real browser (rendered DOM observed,
  via browser tooling or headless Chrome) — curl on the HTML shell does not
  count as UI verification; the report states what was visibly rendered
- a fresh reviewer who did not implement the chunk audits the diff against the
  acceptance criteria and the invariants in `docs/architecture/invariants/`
- any deviation from this plan is listed explicitly in the review summary
