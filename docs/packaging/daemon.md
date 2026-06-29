# KB-1 Local Packaging Paths

Release automation is intentionally light, but the scaffold is structured so
the same local service can run from pnpm, Docker, a user service, or a future
npm/Homebrew-style package.

## Public Naming

The product is **KB-1 Local**. This repo still exposes `KB2_HOME`, `KB2_PORT`,
`kb2d`, and `@kb-2/*` while the implementation rename is deferred. Public docs
should explain that mismatch once, then use KB-1 Local for the product and
`kb2d` only where a literal command or environment variable requires it.

KB-1 launches local and Cloud paths together. Local-only is the free
open-source path with no Cloud login. Self-hosted full experience uses KB-1
Cloud login and relay while the daemon remains the vault home. Hosted full
experience uses the same Cloud login while KB-1 operates the vault engine.

## Local Development

```bash
pnpm install
pnpm --filter @kb-2/daemon dev
```

The daemon reads configuration from the implementation environment variables:

- `KB2_HOME`: home directory for daemon-managed local state, defaulting to
  `~/.kb2`
- `KB2_HOST`: HTTP bind host, defaulting to `127.0.0.1`
- `KB2_PORT`: HTTP port, defaulting to `7382`
- `KB2_WEB_PROXY_TARGET`: optional dev-only Vite target for non-API UI requests

The root `.env` only disables Nx implicit env loading with
`NX_LOAD_DOT_ENV_FILES=false`; runtime env loading remains explicit.

## Local UI Development

Chunk 002 adds a SvelteKit local UI at `apps/web`. Product development still
uses the daemon as the browser front door: `pnpm dev` starts Vite and the daemon,
sets `KB2_WEB_PROXY_TARGET` for the daemon, and leaves Vite HMR connected
directly to the Vite port.

```bash
KB2_HOME=/tmp/kb2-ui-dev KB2_PORT=7382 pnpm dev
open http://127.0.0.1:7382/
```

In this mode, `/api/*` is handled by the daemon and non-API HTTP requests are
proxied to Vite. When `KB2_WEB_PROXY_TARGET` is not set, the daemon serves the
built static UI instead. If neither the built UI nor the dev proxy is available,
the daemon returns an instructional response that tells the developer which
command to run.

For a production-like local smoke, build the web app first and load it from the
same daemon port:

```bash
pnpm check
KB2_HOME=/tmp/kb2-ui-smoke KB2_PORT=8787 pnpm --filter @kb-2/daemon dev
curl http://127.0.0.1:8787/api/health
open http://127.0.0.1:8787/
```

The daemon owns one port in this mode: `/api/*` is the Hono API and every
non-API route is served from the built SvelteKit shell with an SPA fallback.

## Docker

The initial Docker path supports both direct image runs and a Compose-backed
development container.

For the standard development container:

```bash
pnpm docker:up
```

This starts `kb-2-daemon-dev`, maps host port `17382` to container port `7382`,
and mounts the repo-local `.kb2-docker/` directory to `/data/kb2` inside the
container. The daemon status file is therefore visible at:

```text
.kb2-docker/daemon/status.json
```

Compose builds the daemon image and runs the compiled `dist/main.js` inside the
container. Source is copied into the image during `docker compose up --build`;
code changes require rerunning `pnpm docker:up`.

The Docker image does not reuse host `node_modules`. The Dockerfile installs and
builds inside Linux, then the runtime stage performs a production-only
`pnpm install --prod --frozen-lockfile --filter @kb-2/daemon` and copies only the
compiled daemon output from the build stage. Platform-specific npm packages are
therefore selected for the container platform, not macOS, and dev/build tools do
not need to ship in the runtime image.

For an outside-the-container smoke:

```bash
pnpm docker:up
curl http://127.0.0.1:17382/api/health
open http://127.0.0.1:17382/
cat .kb2-docker/daemon/status.json
pnpm docker:down
```

The direct image path is also available:

```bash
docker build -f apps/daemon/Dockerfile -t kb-2-daemon .
docker run --rm -p 7382:7382 -v kb2-home:/data/kb2 kb-2-daemon
```

The container defaults `KB2_HOME` to `/data/kb2` and writes daemon status to
`/data/kb2/daemon/status.json`.

## npm CLI

The daemon package reserves the future CLI binary name:

```json
{
  "bin": {
    "kb2d": "./dist/main.js"
  }
}
```

Publishing is deferred. The current public path can be `git clone` plus the
setup skill while packaging is hardened. A future release chunk can make
`@kb-2/daemon` publishable, add provenance/signing rules, decide whether the
open-source package publishes from this package directly or from a dedicated
release wrapper, and choose the final public binary/package names.

## Release Essentials

Present:

- `pnpm check` runs typecheck, tests, and builds.
- `pnpm dev` starts the local web UI and daemon behind one front-door port.
- `pnpm --filter @kb-2/daemon dev` runs the daemon foreground-only.
- `skills/kb-1-daemon-setup/scripts/install_kb1_daemon_user_service.sh`
  installs a Linux systemd user service or macOS LaunchAgent.
- `skills/kb-1-daemon-setup/scripts/kb1_daemon_healthcheck.sh` checks health,
  vault listing, optional vault info/flush, and MCP initialize.
- Dockerfile and Compose path exist for container smoke runs.

Not decided or not shipped:

- The repo currently has no `LICENSE` file. Legal/product must choose the
  open-source license before public release.
- npm/Homebrew distribution, package signing, and provenance are not shipped.
- Managed binary attachment APIs and MCP tools are not shipped.
- Local-only mode has no application auth; loopback is the default safety
  boundary.
- Obsidian migration is a guarded copy workflow, not a polished importer.
