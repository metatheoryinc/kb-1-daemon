# KB-1 Local Packaging Paths

Release automation is intentionally light, but the scaffold is structured so the
same local service can run from pnpm, Docker, or a future npm CLI package.

## Public Naming

The product is **KB-1 Local**. New installs should use `KB1_*` environment
variables, `~/.kb1`, `@kb-1/*` packages, and the `kb1d` binary. `KB2_*`,
`~/.kb2`, and `kb2d` remain compatibility surfaces for existing deployments.

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

For in-place upgrades, the daemon still honors the legacy `KB2_*` equivalents
with a startup deprecation notice. If `~/.kb2` exists and `~/.kb1` does not, the
daemon uses the existing `~/.kb2` home rather than orphaning data.

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

The initial Docker path supports both direct image runs and a Compose-backed
development container.

For the standard development container:

```bash
pnpm docker:up
```

This starts `kb-1-daemon-dev`, maps host port `17382` to container port `7382`,
and mounts the repo-local `.kb1-docker/` directory to `/data/kb1` inside the
container. The daemon status file is therefore visible at:

```text
.kb1-docker/daemon/status.json
```

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

For an outside-the-container smoke:

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
docker run --rm -p 7382:7382 -v kb1-home:/data/kb1 kb-1-daemon
```

The container defaults `KB1_HOME` to `/data/kb1` and writes daemon status to
`/data/kb1/daemon/status.json`.

## npm CLI

The daemon package reserves the future CLI binary name:

```json
{
  "bin": {
    "kb1d": "./dist/main.js",
    "kb2d": "./dist/main.js"
  }
}
```

`kb2d` is a compatibility alias for existing service definitions. Publishing is
deferred. The supported public setup path is `git clone` plus the
setup skill while packaging is hardened. Packaging hardening should make
`@kb-1/daemon` publishable, add provenance/signing rules, define whether the
open-source package publishes from this package directly or from a dedicated
release wrapper, and choose the public binary/package names.
