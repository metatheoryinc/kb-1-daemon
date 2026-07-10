---
name: kb-1-daemon-setup
description: Install, run, repair, and verify the KB-1 local open-source daemon for local web/API/MCP use on Linux or macOS. Use when setting up kb-1-daemon, configuring MCP clients, copying a Markdown/Obsidian vault into KB1_HOME, or explicitly enabling private Tailscale access after the user approves exposure.
---

# KB-1 Daemon Setup

Use this skill to install or repair the open-source KB-1 local daemon, verify its local web/API/MCP surfaces, configure local MCP clients, or help a user copy an existing Markdown/Obsidian vault into daemon-managed storage.

Release posture: KB-1 Local is the free open-source local-only path and launches alongside KB-1 Cloud relay/Hosted. Local-only does not require Cloud login and the open-source daemon has no Cloud users, orgs, team presence, or per-user org permissions. Self-hosted full experience means Cloud login plus this daemon running on the user's machine; relay adds remote access and agent access beyond the daemon host while the daemon remains the vault home. The daemon currently has no application authentication or authorization in local-only mode. Keep it bound to loopback unless the user explicitly approves private-network exposure and understands that any tailnet device allowed by ACLs can read and write through the daemon.

Naming reality: the public product and repo internals use KB-1 names: `KB1_*` env vars, `~/.kb1` homes, `kb1d`, `kb1d.service`, and `dev.metatheory.kb1.kb1d`.

## Safety Rules

Safe to automate after stating what will change:

1. Clone or update `https://github.com/metatheoryinc/kb-1-daemon.git` into `$HOME/repos/kb-1-daemon` or a user-approved path.
2. Install Node/pnpm dependencies.
3. Run checks/builds.
4. Install or update a user-level service on Linux systemd or macOS launchd.
5. Start or restart the daemon and verify `/api/health`, `/api/vaults`, and `/mcp` reachability.
6. Configure MCP clients when their CLI/config is available, after inspecting existing entries.
7. Report Tailscale status without changing it.

Do not automate without clear approval:

- Delete, overwrite, move, or merge an existing vault.
- Expose the daemon through Tailscale Serve or another network route.
- Bind the daemon to `0.0.0.0`.
- Install Tailscale, use sudo/package managers, add devices/users to a tailnet, or change ACLs.
- Reset an existing Tailscale Serve config that may route other services.

## Prerequisite Discovery

Before changing anything, inspect the live machine:

```bash
uname -a
whoami
pwd
command -v node pnpm corepack git curl systemctl launchctl tailscale claude codex || true
node --version 2>/dev/null || true
pnpm --version 2>/dev/null || true
systemctl --user status kb1d.service --no-pager 2>/dev/null || true
systemctl --user status kb2d.service --no-pager 2>/dev/null || true
launchctl print "gui/$(id -u)/dev.metatheory.kb1.kb1d" 2>/dev/null || true
launchctl print "gui/$(id -u)/dev.metatheory.kb1.kb2d" 2>/dev/null || true
curl -fsS http://127.0.0.1:7382/api/health 2>/dev/null || true
curl -fsS http://127.0.0.1:7382/api/vaults 2>/dev/null || true
tailscale status 2>/dev/null || true
tailscale serve status 2>/dev/null || true
```

If running inside a container, remote shell, or Codex sandbox, remember `127.0.0.1` may be the sandbox, not the user's host. Run setup on the host that should own the daemon.

## Standard Install Path

Defaults:

- Repo: `$HOME/repos/kb-1-daemon`
- Daemon home: `$HOME/.kb1`
- Vaults: `$HOME/.kb1/vaults/<vault-slug>`
- Host bind: `127.0.0.1`
- Port: `7382`
- Linux service: user systemd unit `kb1d.service`
- macOS service: user LaunchAgent `dev.metatheory.kb1.kb1d`
- MCP endpoint: `http://127.0.0.1:7382/mcp`

For a default-path in-place upgrade, first boot copies existing `$HOME/.kb2`
daemon data into `$HOME/.kb1`, then checks that every regular source file exists
there at the same relative path with the same byte length before removing the
legacy source. Symlinks and empty directories are not checked, and this is not a
content hash comparison. If `$HOME/.kb1` already exists, a missing source path
or size mismatch aborts the migration and preserves the source. Back up
`$HOME/.kb2` separately before first boot if you want content-level verification
or a rollback copy.

The installer writes the current `kb1d.service` or
`dev.metatheory.kb1.kb1d` definition. If discovery found an old `kb2d` service
for this same daemon home and port, stop it before running the installer so
`kb1d` can bind. Keep the old definition available for rollback; disable it only
after the new daemon passes health. Do not stop a separate `kb2d` instance that
intentionally uses another home or port.

Before stopping a legacy service, inspect its unit or plist and record its home,
host, and port:

```bash
# Linux
systemctl --user cat kb2d.service

# macOS
plutil -p "$HOME/Library/LaunchAgents/dev.metatheory.kb1.kb2d.plist"
```

Legacy `KB2_*` variables are ignored by the current daemon. Carry custom values
forward explicitly as `KB1_HOME`, `KB1_HOST`, and `KB1_PORT`; keeping the exact
custom home path is valid even if its directory name contains `.kb2`. Only the
default `~/.kb2` to `~/.kb1` path is migrated automatically. Use
`KB1_SERVICE_NAME` or `KB1_LAUNCHD_LABEL` only when intentionally choosing a
non-default current service identity.

Use the command for the detected platform when the discovered legacy service is
the instance being upgraded:

```bash
# Linux
systemctl --user stop kb2d.service

# macOS
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.metatheory.kb1.kb2d.plist"
```

If installation fails, stop the replacement before restarting the old service.
Export the same custom identity variables used for installation before running
this block; when they are unset, the commands use the default identities:

```bash
# Linux
current_service="${KB1_SERVICE_NAME:-kb1d.service}"
legacy_service="${KB1_LEGACY_SERVICE_NAME:-kb2d.service}"
systemctl --user stop "$current_service"
systemctl --user start "$legacy_service"

# macOS
current_label="${KB1_LAUNCHD_LABEL:-dev.metatheory.kb1.kb1d}"
legacy_label="${KB1_LEGACY_LAUNCHD_LABEL:-dev.metatheory.kb1.kb2d}"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$current_label.plist" || true
launchctl enable "gui/$(id -u)/$legacy_label"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$legacy_label.plist"
```

After the replacement is healthy, disable the recorded old definition. The
default commands are `systemctl --user disable kb2d.service` on Linux and
`launchctl disable "gui/$(id -u)/dev.metatheory.kb1.kb2d"` on macOS; substitute
the discovered legacy identity when it differs.

Run the support script from the skill directory when available. Its default mode installs KB-1 locally, configures a user service, optionally configures local MCP clients, and does not change Tailscale:

```bash
bash scripts/install_kb1_daemon_user_service.sh

# Carry forward a custom legacy runtime configuration.
KB1_HOME="/existing/custom/home" \
KB1_HOST="127.0.0.1" \
KB1_PORT="17382" \
bash scripts/install_kb1_daemon_user_service.sh
```

The installer refuses non-loopback `KB1_HOST` values unless `KB1_CONFIRM_NON_LOOPBACK_BIND=1` is set. Prefer keeping the daemon on loopback and using Tailscale Serve for private tailnet access.

Useful overrides:

```bash
# Never touch Tailscale. This is the public-release default.
KB1_TAILSCALE_MODE=local-only bash scripts/install_kb1_daemon_user_service.sh

# Skip the slower full check and only build, useful after a known-good checkout.
KB1_RUN_CHECKS=0 bash scripts/install_kb1_daemon_user_service.sh

# Use a different repo checkout, daemon home, or port.
KB1_REPO_DIR="$HOME/src/kb-1-daemon" KB1_HOME="$HOME/.kb1" KB1_PORT=7382 bash scripts/install_kb1_daemon_user_service.sh
```

For Linux services that should survive logout/reboot, ask the user before running:

```bash
sudo loginctl enable-linger "$USER"
```

## Manual Foreground Run

Use this path on unsupported systems, while debugging, or when the user does not want a service installed:

```bash
mkdir -p "$HOME/repos"
git clone https://github.com/metatheoryinc/kb-1-daemon.git "$HOME/repos/kb-1-daemon"
cd "$HOME/repos/kb-1-daemon"
corepack enable || true
corepack prepare pnpm@11.5.3 --activate || true
pnpm install --frozen-lockfile
pnpm check
KB1_HOST=127.0.0.1 KB1_PORT=7382 pnpm --filter @kb-1/daemon dev
```

Then verify from another shell:

```bash
curl -fsS http://127.0.0.1:7382/api/health
curl -fsS http://127.0.0.1:7382/api/vaults
```

## Existing Vault Or Obsidian Copy

The daemon discovers vaults under `$KB1_HOME/vaults/`. Each vault folder gets identity at `<vault>/.kb1/vault.json`:

```json
{
  "id": "my-vault",
  "displayName": "My Vault"
}
```

If the user has an existing Markdown/Obsidian folder:

1. Copy, do not move, unless the user explicitly asks for migration.
2. Refuse to merge into a non-empty target unless the user explicitly approves a merge/replacement policy.
3. Preserve Obsidian in place unless the user explicitly asks to remove it.
4. Refuse source vaults with symlinks by default; the daemon follows filesystem symlinks, so copied links can expose files outside the vault.
5. Exclude volatile Obsidian workspace files by default.
6. Restart or start `kb1d`, then verify `GET /api/vaults` shows the expected id. For a manual upgrade, stop the old `kb2d` service before starting `kb1d` on the same port.

Safe copy pattern:

```bash
source_vault="/path/to/source-vault"
kb1_home="${KB1_HOME:-$HOME/.kb1}"
vault_root="$kb1_home/vaults"
slug="my-vault"
display_name="My Vault"

if [[ ! "$slug" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [[ "$slug" == *..* ]]; then
  echo "Refusing unsafe vault slug: $slug" >&2
  exit 1
fi

if [ -L "$kb1_home" ] || [ -L "$vault_root" ]; then
  echo "Refusing to copy through symlinked KB-1 home/vaults path." >&2
  exit 1
fi

mkdir -p "$vault_root"
target="$vault_root/$slug"

if [ -L "$target" ]; then
  echo "Refusing symlink destination: $target" >&2
  exit 1
fi

root_real="$(cd "$vault_root" && pwd -P)"
target_parent_real="$(cd "$(dirname "$target")" && pwd -P)"
case "$target_parent_real/" in
  "$root_real/"*) ;;
  *)
    echo "Refusing destination outside vault root: $target" >&2
    exit 1
    ;;
esac

if [ -e "$target" ] && [ "$(find "$target" -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
  echo "Refusing to merge into non-empty target: $target" >&2
  exit 1
fi

symlink_list="$(mktemp)"
find "$source_vault" -type l -print > "$symlink_list"
if [ -s "$symlink_list" ]; then
  echo "Refusing to copy vault with symlinks. Review these paths manually:" >&2
  cat "$symlink_list" >&2
  rm -f "$symlink_list"
  exit 1
fi
rm -f "$symlink_list"

command -v node >/dev/null 2>&1 || {
  echo "Missing node; install a supported Node release (20.19.x, 22.12+, or 24+) before generating vault identity JSON." >&2
  exit 1
}

mkdir -p "$target"
rsync -rt --exclude='.git' --exclude='.obsidian/workspace*' "$source_vault"/ "$target"/
mkdir -p "$target/.kb1"
node - "$target/.kb1/vault.json" "$slug" "$display_name" <<'JS'
const fs = require('node:fs');
const [identityPath, id, displayName] = process.argv.slice(2);
fs.writeFileSync(identityPath, `${JSON.stringify({ id, displayName }, null, 2)}\n`);
JS
curl -fsS http://127.0.0.1:7382/api/vaults
```

Before backing up or syncing a live daemon vault, flush the addressed vault:

```bash
curl -fsS -X POST http://127.0.0.1:7382/api/vaults/<vault-id>/ops/flush
```

## Configure MCP Clients

The daemon serves Streamable HTTP MCP at:

```text
http://127.0.0.1:7382/mcp
```

Every data tool requires an explicit `vaultId`; do not assume a default vault. Start by listing vaults, pick the intended id, then call read/write tools with that id.

Claude Code:

```bash
claude mcp add kb1 --transport http http://127.0.0.1:7382/mcp
```

Codex and other MCP-capable agents:

- Add an HTTP/Streamable HTTP MCP server named `kb1`.
- Use `http://127.0.0.1:7382/mcp` when the agent runs on the same machine.
- If the CLI has an MCP subcommand, inspect `AGENT --help` and prefer it.
- Do not invent client-specific config syntax if the CLI version is unknown.

## Optional Tailscale Access

Keep the daemon bound to `127.0.0.1`. Do not bind it to all interfaces for phone/laptop access.

Only configure Tailscale Serve after the user explicitly approves private-network exposure and understands this warning:

> KB-1 currently has no application auth. Any device/user allowed by the tailnet ACLs to reach this Serve route can read and write through the daemon.

After approval, run one of:

```bash
# Let the installer configure Serve only when Tailscale is installed, logged in, and has no conflicting Serve config.
KB1_TAILSCALE_MODE=auto KB1_CONFIRM_TAILSCALE_EXPOSURE=1 bash scripts/install_kb1_daemon_user_service.sh

# Force/update Serve after explicit approval, useful when an existing Serve config should be replaced or extended.
KB1_TAILSCALE_MODE=serve KB1_CONFIRM_TAILSCALE_EXPOSURE=1 KB1_TAILSCALE_HTTPS_PORT=8443 bash scripts/install_kb1_daemon_user_service.sh
```

Expected URLs are usually:

```text
https://<machine-name>.<tailnet-name>.ts.net/
https://<machine-name>.<tailnet-name>.ts.net/api/health
https://<machine-name>.<tailnet-name>.ts.net/mcp
```

Phone/laptop checklist:

1. Install Tailscale on the phone/laptop.
2. Sign into the same tailnet.
3. Confirm the KB-1 host appears in Tailscale.
4. Open the health URL while Tailscale is connected.
5. Configure laptop-side agents to the tailnet `/mcp` URL only if the user accepts the auth tradeoff.

## Verification Checklist

Local daemon:

```bash
scripts/kb1_daemon_healthcheck.sh
curl -fsS http://127.0.0.1:7382/api/health
curl -fsS http://127.0.0.1:7382/api/vaults
curl -fsS http://127.0.0.1:7382/api/vaults/<vault-id>/vault
```

The healthcheck is read-only by default. To verify flushing a specific vault, set both `KB1_VAULT_ID=<vault-id>` and `KB1_FLUSH_VAULT=1`.
It inspects the current `kb1d` service by default. To inspect an intentional
legacy instance, set `KB1_SERVICE_NAME=kb2d.service` on Linux or
`KB1_LAUNCHD_LABEL=dev.metatheory.kb1.kb2d` on macOS, together with that
instance's matching `KB1_HOST` and `KB1_PORT`.

MCP smoke once tools are loaded:

1. `list_vaults`.
2. Pick the explicit vault id.
3. `vault_info` or read a harmless note.
4. Create a scratch note.
5. Read it back.
6. Delete it permanently or move it to trash, depending on the user's policy.
7. Flush before backup/snapshot.

## Troubleshooting

- Repo clone fails: verify the public repo URL, GitHub availability, and local Git credentials for the account performing the clone.
- `pnpm` missing: use Corepack with `corepack prepare pnpm@11.5.3 --activate`; if Corepack is absent, install a supported Node release (20.19.x, 22.12+, or 24+) first.
- `apps/daemon/dist/main.js` missing: run `pnpm build` or `pnpm check` from the repo root.
- Port 7382 busy: identify the process, or set `KB1_PORT` in the service and update MCP/Tailscale URLs to match.
- Linux `systemctl --user` fails in a container: install/run on the host OS or use the foreground run path.
- Linux service stops after logout: ask before enabling lingering with `sudo loginctl enable-linger "$USER"`.
- macOS service does not start: inspect `~/Library/Logs/<launchd-label>.{out,err}.log` and `launchctl print "gui/$(id -u)/<launchd-label>"`; custom labels get their own log pair, and the defaults are `dev.metatheory.kb1.kb1d` (current) and `dev.metatheory.kb1.kb2d` (legacy).
- Tailscale not installed or logged in: keep KB-1 local-only and give the user Tailscale setup steps.
- Tailscale Serve already has unrelated routes: do not overwrite in auto mode; require explicit approval and a chosen port.
- UI works but agents cannot edit: check the MCP URL, restart the client, and ensure every data tool call includes `vaultId`.

## Report Summary

When finished, report:

- Repo path and commit/branch if known.
- Service type/name/status.
- Local URL and MCP URL.
- Vault ids discovered.
- MCP clients configured.
- Whether Tailscale was left unchanged, configured, or deferred.
- Any manual steps left for the user.
