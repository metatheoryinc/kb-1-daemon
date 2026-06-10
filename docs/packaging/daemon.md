# Daemon Packaging Paths

Chunk 001 keeps release automation intentionally light, but the scaffold is
structured so the same daemon can run from pnpm, Docker, or a future npm CLI
package.

## Local Development

```bash
pnpm install
pnpm --filter @kb-2/daemon dev
```

The daemon reads configuration from environment variables owned by KB-2 code:

- `KB2_HOME`: home directory for daemon-managed local state, defaulting to
  `~/.kb2`
- `KB2_HOST`: HTTP bind host, defaulting to `127.0.0.1`
- `KB2_PORT`: HTTP port, defaulting to `7382`

The root `.env` only disables Nx implicit env loading with
`NX_LOAD_DOT_ENV_FILES=false`; runtime env loading remains explicit.

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

The Docker image does not reuse host `node_modules`. The Dockerfile copies only
package metadata and source into the Linux image, runs
`pnpm install --frozen-lockfile` inside that image, builds there, and then copies
the Linux-installed dependencies into the runtime stage. Platform-specific npm
packages are therefore selected for the container platform, not macOS.

For an outside-the-container smoke:

```bash
pnpm docker:up
curl http://127.0.0.1:17382/health
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

Publishing is deferred. A future release chunk can make `@kb-2/daemon`
publishable, add provenance/signing rules, and decide whether the open-source
daemon package is published from this package directly or from a dedicated
release wrapper.
