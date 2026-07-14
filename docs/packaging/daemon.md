# KB-1 Local Packaging Paths

Release automation is intentionally light, but the scaffold is structured so the
same local service can run from pnpm, Docker, or a future npm CLI package.

## Public Naming

The product is **KB-1 Local**. Installs use `KB1_*` environment variables,
`~/.kb1`, `@kb-1/*` packages, and the `kb1d` binary.

## Local Development

```bash
pnpm install
pnpm --filter @kb-1/daemon dev
```

The daemon reads configuration from environment variables owned by KB-1 code:

- `KB1_HOME`: home directory for daemon-managed local state, defaulting to
  `~/.kb1`
- `KB1_HOST`: HTTP bind host, defaulting to `127.0.0.1`
- `KB1_PORT`: HTTP port, defaulting to `7382`
- `KB1_WEB_PROXY_TARGET`: optional dev-only Vite target for non-API UI requests
- `KB1_RELAY_URL` and `KB1_RELAY_TOKEN`: relay/tunnel connection, supplied
  together
- `KB1_DAEMON_VERSION` and `KB1_DAEMON_BUILD`: optional daemon identity fields
  sent to the relay
- `KB1_ACTOR_DEFAULT`: default local actor attribution, `user` or `unknown`
- `KB1_HISTORY_COALESCE_WINDOW_MS`: non-negative note-history coalescing window

Relay is optional, but `KB1_RELAY_URL` and `KB1_RELAY_TOKEN` are all-or-nothing.
When both are set, the daemon connects to the relay endpoint after startup over
outbound WebSockets. `KB1_DAEMON_VERSION` and `KB1_DAEMON_BUILD` are optional
registration metadata.

```bash
KB1_RELAY_URL=https://relay.example/tunnel/my-daemon \
KB1_RELAY_TOKEN=... \
KB1_DAEMON_VERSION=0.1.0 \
pnpm --filter @kb-1/daemon dev
```

The relay lifecycle API is available on the daemon port:

```bash
curl http://127.0.0.1:7382/api/relay/status
curl -X POST http://127.0.0.1:7382/api/relay/connect
curl -X POST http://127.0.0.1:7382/api/relay/disconnect
```

Internally the tunnel client appends `/__kb1_tunnel/control` and
`/__kb1_tunnel/dialback` to the configured relay URL. These are relay endpoint
paths, not routes served by the daemon.

For in-place upgrades, first boot copies legacy `~/.kb2` homes into `~/.kb1`.
Before activating the copy, the daemon verifies the directory structure and
compares a SHA-256 digest for every regular source file. A missing path, content
mismatch, symlink, hard link, unsupported filesystem entry, or verification
error aborts the migration and preserves the source path. After a successful
migration, the complete legacy tree remains untouched at `~/.kb2` for rollback;
the daemon never renames or deletes it. Stable full-tree manifests prove that
both source and target remain unchanged through completion-marker publication.
An atomic `.kb1-migration-complete-v1.json` marker inside the verified target
binds the handoff to the canonical source/target path pair and stable vault id
when present. It retains the migration-time source digest as evidence, but later
boots neither require retained source content to remain frozen nor compare the
active `.kb1` tree against that snapshot. A complete-home restore to a new path
can atomically rebind only the marker when the supported daemon-home endpoint
names and the portable migration-time source digest match; it never reconciles
or overwrites the active target, and missing proof fails closed with
manual-recovery guidance. A pre-existing target is reconciled by filling only
missing entries through migration-owned staging;
existing entries are never overwritten and must match byte-for-byte. This also
handles an empty `/data/kb1` directory pre-created by a Docker bind mount or
named volume. Restrictive POSIX modes are preserved for missing entries, and an
existing copy with broader permissions fails closed. Setuid, setgid, and sticky
bits are stripped from daemon-owned copies. Additional regular files
and directories are allowed. The daemon
flushes the verified target tree and its directory entries before making the
marker durable. On Windows it publishes each new file, directory, and marker via
`MoveFileExW` with write-through after authenticating every manifest operation
with an ephemeral HMAC; authentication failure or an unavailable write-through
operation aborts with the source intact. Marker, temporary-marker,
copy, lock, and staging namespaces are reserved at every source depth and
validated before publication. A canonical source/target-pair lock serializes
migration and is never auto-stolen. An existing lock, unverified temporary
control entry, or non-empty interrupted stage is preserved and fails closed with
manual-recovery guidance; only an empty pre-manifest pair-owned stage is removed
automatically. Keep
the legacy writer stopped (or mount the
source read-only) during the handoff: complete source manifests are compared
before and after final verification, and portable filename collisions within or
across source and target fail closed before publication.
On POSIX, hard-link no-replace publication is used when available. Storage
without hard-link support uses an exclusive-create, streamed-copy, `fsync`, and
byte-verification fallback that never overwrites an existing path.
On macOS, Node.js exposes standard `fsync`, not Apple's `F_FULLFSYNC`, so sudden
whole-device power loss may reorder drive-cache writes despite those barriers.
The daemon never deletes the complete `.kb2` source; treat it as the recovery
authority and verify it (and your backup) before removing it manually.
Give migration exclusive filesystem control: stop legacy and target writers,
sync tools, and restore jobs until the completion marker exists.
Directory-inode checks reject detected path changes. On POSIX, completion
markers must also have the effective user's ownership and no group/other write
access; Windows instead relies on the user's private filesystem ACL and the same
exclusive-writer boundary. Same-OS-identity processes share the user's trusted
filesystem boundary. Later source and target evolution is allowed after
completion.
The daemon does not honor `KB2_*` environment variables; runtime configuration is
KB1-only.

The root `.env` only disables Nx implicit env loading with
`NX_LOAD_DOT_ENV_FILES=false`; runtime env loading remains explicit.

## Local UI Development

The SvelteKit local UI lives at `apps/web`. Product development still uses the
daemon as the browser front door: `pnpm dev` starts Vite and the daemon, sets
`KB1_WEB_PROXY_TARGET` for the daemon, and leaves Vite HMR connected directly to
the Vite port.

```bash
KB1_HOME=/tmp/kb1-ui-dev KB1_PORT=7382 pnpm dev
open http://127.0.0.1:7382/
```

In this mode, `/api/*` is handled by the daemon and non-API HTTP requests are
proxied to Vite. When `KB1_WEB_PROXY_TARGET` is not set, the daemon serves the
built static UI instead. If neither the built UI nor the dev proxy is available,
the daemon returns an instructional response that tells the developer which
command to run.

For a production-like local smoke, build the web app first and load it from the
same daemon port:

```bash
pnpm check
KB1_HOME=/tmp/kb1-ui-smoke KB1_PORT=8787 pnpm --filter @kb-1/daemon dev
curl http://127.0.0.1:8787/api/health
open http://127.0.0.1:8787/
```

The daemon owns one port in this mode: `/api/*` is the Hono API and every
non-API route is served from the built SvelteKit shell with an SPA fallback.

## Docker

The Docker path supports direct image runs and includes a Compose-backed
development helper for repository maintainers.

The daemon has no local application authentication. Every published container
port must bind to `127.0.0.1` unless the operator has deliberately added an
access-controlled private network boundary. Never publish the daemon directly
to the public internet.

The committed Compose development helper publishes
`127.0.0.1:17382:7382`, so its daemon is reachable only from the host by
default. Repository maintainers can start it with:

```bash
pnpm docker:up
```

This starts `kb-1-daemon-dev`, maps loopback-only host port `17382` to container
port `7382`, and mounts the repo-local `.kb1-docker/` directory to `/data/kb1`
inside the container. The daemon status file is therefore visible at:

```text
.kb1-docker/daemon/status.json
```

For in-place upgrades from the old Docker data path, keep the legacy data mounted
at `/data/kb2` for the first boot and keep `KB1_HOME=/data/kb1`. The daemon
copies and verifies the legacy input before running from `/data/kb1`, writes the
completion marker in `/data/kb1`, and leaves `/data/kb2` untouched. A legacy
named volume can therefore remain mounted directly at `/data/kb2` (and may be
mounted read-only); no sibling rename is required.

Compose builds the daemon image and runs the compiled `dist/main.js` inside the
container. Source is copied into the image during `docker compose up --build`;
code changes require rerunning `pnpm docker:up`.

The Docker image does not reuse host `node_modules`. The Dockerfile copies the
monorepo workspace into the build context, excluding local install/build output
with `.dockerignore`, so pnpm can resolve `apps/*` and `packages/*` workspace
dependencies from a clean checkout. The build stage installs with
`pnpm install --frozen-lockfile`, builds the static web UI, and runs
`pnpm --filter @kb-1/daemon... build` so the daemon and its workspace package
dependencies emit their `dist/` outputs inside Linux.

After the build, the Dockerfile replaces the build install with a production-only
`pnpm install --prod --frozen-lockfile --filter @kb-1/daemon...` and prepares a
runtime tree containing the production install, package manifests, compiled
daemon output, compiled workspace package outputs, and built web UI. The final
runtime image copies only that prepared runtime tree. Platform-specific npm
packages are therefore selected for the container platform, not macOS, and
dev/build tools do not need to ship in the runtime image.

For a maintainer-only outside-the-container Compose smoke on that isolated
machine:

```bash
pnpm docker:up
curl http://127.0.0.1:17382/api/health
open http://127.0.0.1:17382/
cat .kb1-docker/daemon/status.json
pnpm docker:down
```

The direct image path is also available:

```bash
docker build -f apps/daemon/Dockerfile -t kb-1-daemon .
docker run --rm \
  -p 127.0.0.1:7382:7382 \
  -v kb1-home:/data/kb1 \
  kb-1-daemon
```

The container defaults `KB1_HOME` to `/data/kb1` and writes daemon status to
`/data/kb1/daemon/status.json`.

Legacy direct-image deployments that mounted data at `/data/kb2` can mount both
paths for one upgrade boot:

```bash
docker run --rm \
  -p 127.0.0.1:7382:7382 \
  -v kb1-home:/data/kb1 \
  -v kb2-home:/data/kb2 \
  kb-1-daemon
```

## npm CLI

The daemon package reserves the future CLI binary name:

```json
{
  "bin": {
    "kb1d": "./dist/main.js"
  }
}
```

Publishing is deferred. The supported public setup path is `git clone` plus the
setup skill while packaging is hardened. Packaging hardening should make
`@kb-1/daemon` publishable, add provenance/signing rules, define whether the
open-source package publishes from this package directly or from a dedicated
release wrapper, and choose the public binary/package names.
