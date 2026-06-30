# KB-1 Local

KB-1 Local is the open-source local service for KB-1: an agent-ready Markdown
vault that runs on a machine you control. It serves the local web UI, REST API,
and Streamable HTTP MCP endpoint from one daemon process, with the filesystem as
the durable source of truth.

The repo still contains implementation residue from the KB-2 codename:
`KB2_*` environment variables, the `kb2d` service/process name, the default
`~/.kb2` home directory, and `@kb-2/*` package names. Treat those as literal
command/package names only. Public product language should say **KB-1 Local**.

## What Ships Here

- Local web app at the daemon port.
- Local REST API under `/api/*`.
- Local MCP endpoint at `/mcp` for agents on the same machine.
- Filesystem-backed vaults under `KB2_HOME/vaults/<vault-id>/`.
- Markdown notes, folders, search, move/delete operations, folder and vault
  color metadata, audit rows, live document sessions, and explicit flush
  endpoints.
- Arbitrary non-Markdown files can live in a vault directory, but managed binary
  attachment APIs and MCP tools are not shipped yet.
- Optional relay client configuration for KB-1 Cloud relay.

KB-1 launches as a set of choices:

- **Local-only:** free open-source solo/developer path. No Cloud login required.
- **Self-hosted full experience:** KB-1 Cloud login plus a vault engine running
  on your machine.
- **Hosted full experience:** KB-1 Cloud login plus a KB-1 operated vault
  engine.

Cloud does not automatically mean KB-1 stores the vault. Self-hosted full
experience does not mean skipping Cloud login. Local-only is the path that runs
without a KB-1 Cloud account.

## Install And Run

Requirements:

- Node 22 or newer.
- `pnpm` through Corepack.
- A writable state directory for `KB2_HOME`.

From a checkout:

```bash
corepack enable
corepack prepare pnpm@11.5.3 --activate
pnpm install --frozen-lockfile
pnpm check
KB2_HOME="$PWD/.kb2-dev" KB2_PORT=7382 pnpm dev
```

Open:

| Surface | URL | Notes |
| --- | --- | --- |
| Local UI | `http://127.0.0.1:7382/` | Served by the daemon front door. |
| REST API | `http://127.0.0.1:7382/api/*` | Health, vaults, files, folders, metadata, search, events, relay status. |
| MCP | `http://127.0.0.1:7382/mcp` | Streamable HTTP MCP for local agents. |
| Storybook | `http://127.0.0.1:6006/` | Run `pnpm storybook`; pass `-p <port>` if 6006 is taken. |

Useful overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KB2_HOME` | `~/.kb2` | Daemon state, vaults, metadata, and status files. |
| `KB2_HOST` | `127.0.0.1` | Bind host. Keep loopback unless exposure is deliberate. |
| `KB2_PORT` | `7382` | Local UI/API/MCP port. |
| `KB2_WEB_PORT` | `5173` | Internal Vite dev server port used by `pnpm dev`. |
| `KB2_WEB_PROXY_TARGET` | unset | Dev-only target for UI proxying. |
| `KB2_RELAY_URL` | unset | Cloud relay URL for self-hosted full experience. |
| `KB2_RELAY_TOKEN` | unset | Daemon-scoped relay key. Must be supplied with `KB2_RELAY_URL`. |

## Verify A Running Daemon

Use throwaway state for tests and docs smoke runs:

```bash
KB2_HOME="$(mktemp -d)" KB2_PORT=17992 pnpm dev:daemon
```

From another shell:

```bash
curl -fsS http://127.0.0.1:17992/api/health
curl -fsS http://127.0.0.1:17992/api/vaults
curl -fsS http://127.0.0.1:17992/api/vaults/demo-vault/tree
```

The first boot creates a starter vault named `demo-vault`.

The setup skill also includes a read-only healthcheck:

```bash
skills/kb-1-daemon-setup/scripts/kb1_daemon_healthcheck.sh
```

Set `KB2_PORT=<port>` if the daemon is not on `7382`. Set
`KB1_VAULT_ID=<vault-id>` to check a specific vault, and add
`KB1_FLUSH_VAULT=1` only when you intentionally want to verify flushing that
vault.

## State And Vault Layout

Default state lives under `~/.kb2`:

```text
$KB2_HOME/
  daemon/
    status.json
  vaults/
    <vault-id>/
      .kb2/
        vault.json
        folders.yml
      README.md
      notes/
```

The daemon discovers each immediate directory under `$KB2_HOME/vaults/` as a
vault. Keep backups outside `vaults/`; placing backup folders there can make
them appear as extra vaults.

## MCP Client Setup

The local MCP endpoint is:

```text
http://127.0.0.1:7382/mcp
```

Claude Code:

```bash
claude mcp add kb1 --transport http http://127.0.0.1:7382/mcp
```

Codex, Hermes, and other MCP-capable clients should add an HTTP or Streamable
HTTP MCP server named `kb1` with the same URL. Every data tool requires an
explicit `vaultId`; start with `list_vaults`, choose the intended vault, then
read or write against that id.

Available local tools include `vault_info`, `list_vaults`, `list_files`,
`read_note`, `create_note`, `edit_note`, `append_note`, `prepend_note`,
`delete_note`, `move_note`, `create_folder`, `delete_folder`, `move_folder`,
`get_folder_metadata`, `set_folder_metadata`, and `search`.

## Copying Markdown Or Obsidian Vaults

The release posture is copy-first:

- Copy Markdown/Obsidian folders into a daemon-managed vault.
- Do not move or delete the source vault unless that is explicitly intended.
- Keep Obsidian installed and usable during evaluation.
- Close Obsidian or stop editing while copying.
- Refuse symlinks by default; they can point outside the vault boundary.
- Keep backup copies outside `$KB2_HOME/vaults/`.
- Preserve each KB-1 target vault's `.kb2/` metadata directory.

Before backing up or copying from a live KB-1 vault, flush it:

```bash
curl -fsS -X POST http://127.0.0.1:7382/api/vaults/<vault-id>/ops/flush
```

For the full guarded copy pattern, see `skills/kb-1-daemon-setup/SKILL.md`.

## Security And Network Posture

Local-only KB-1 has no application login layer in front of the local daemon.
Anyone who can reach the local UI, API, or MCP endpoint can read and write
through it. Keep `KB2_HOST=127.0.0.1` by default.

For private multi-device access, prefer Tailscale Serve or another private
network path over binding the daemon directly to `0.0.0.0`. Only expose the
daemon after accepting that tailnet ACLs are the access boundary for local-only
mode.

Self-hosted full experience uses KB-1 Cloud login plus an outbound relay
connection configured with `KB2_RELAY_URL` and `KB2_RELAY_TOKEN`. That path adds
Cloud identity, org membership, signed entry, relay routing, and collaboration
surface while your machine remains the vault home.

## Docker

```bash
pnpm docker:up
curl -fsS http://127.0.0.1:17382/api/health
pnpm docker:down
```

The Compose path maps host port `17382` to container port `7382` and stores
state in repo-local `.kb2-docker/`. The container binds `0.0.0.0` inside Docker
so the host port mapping works; treat the mapped host port with the same network
caution as any local daemon exposure.

## Release Essentials

Present in this repo:

- Public README and architecture docs.
- `pnpm check` gate for typecheck, tests, and builds.
- Foreground dev run.
- User-service setup script for Linux systemd and macOS launchd.
- Healthcheck script with `/api/health`, `/api/vaults`, and MCP initialize.
- Dockerfile and Compose path.
- Local MCP endpoint.

Still a release blocker or product/legal decision:

- No `LICENSE` file is present in the repo. Legal/product must choose and add
  the open-source license before public release.
- npm/Homebrew/package provenance and signing are not shipped yet. The current
  public install path is checkout plus scripts.
- Managed binary attachment APIs and MCP tools are not shipped yet.
- Local-only mode has no application auth. Loopback is the default safety
  boundary.
- Obsidian import is a copy workflow, not a polished importer or plugin.
- Cloud relay and Hosted are KB-1 Cloud paths; local-only users do not need
  them, and this repo does not by itself provision Cloud accounts or orgs.

## Other Commands

```bash
pnpm smoke:yjs     # two-client Yjs editing smoke against a running daemon
pnpm docker:up     # daemon in Docker, host port 17382
pnpm docker:down   # stop the Docker daemon
```

## Repository Layout

- `apps/daemon` - the local server (`kb2d`), the only runtime writer.
- `apps/web` - the local web UI, served by the daemon.
- `packages/doc-session` - Yjs document sessions backed by Markdown files.
- `packages/vault-service` - vault operation boundary used by UI, API, and MCP.
- `packages/local-mcp` - local Streamable HTTP MCP server.
- `packages/ui` - component library and Storybook.
- `docs/architecture/` - architecture notes and invariants.
- `skills/kb-1-daemon-setup/` - install, service, healthcheck, and migration
  helper skill.
