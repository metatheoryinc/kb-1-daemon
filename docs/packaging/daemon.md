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

The initial Docker path is a runnable daemon image:

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
