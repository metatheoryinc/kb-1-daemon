# KB-2

A local-first, agent-ready knowledge base where the user's filesystem is the
durable source of truth. See `VISION.md` and `docs/architecture/` for the full
picture; execution sequence lives in `docs/plans/local-first-roadmap.md`.

## Quick Start

```bash
pnpm install
pnpm check   # typecheck + tests + builds
pnpm dev     # one command: web UI + API behind one daemon port
```

| Surface | URL | Notes |
|---|---|---|
| App (UI + API) | http://127.0.0.1:7382 | The daemon front door serves both; API under `/api/*` |
| Storybook | http://localhost:6006 | `pnpm storybook`; pass `-p <port>` if 6006 is taken |

Port/env overrides: `KB2_PORT` (daemon), `KB2_WEB_PORT` (internal Vite dev
server), `KB2_HOME` (daemon state directory, defaults to `~/.kb2`).

## Other Commands

```bash
pnpm smoke:yjs     # two-client Yjs editing smoke against a running daemon
pnpm docker:up     # daemon in Docker (host port 17382); pnpm docker:down to stop
```

## Layout

- `apps/daemon` — the local server (`kb2d`), the only runtime writer
- `apps/web` — the local web UI, served by the daemon
- `packages/doc-session` — Yjs document sessions backed by Markdown files
- `packages/ui` — component library + Storybook
- `docs/plans/` — chunk plans; `docs/architecture/invariants/` — the rules
  every change is audited against
