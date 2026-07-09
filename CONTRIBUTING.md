# Contributing

KB-1 Local is a pnpm/Nx workspace. The workspace packages are private and are
not published to npm.

## Setup

Use the pnpm version declared in `package.json`.

```bash
pnpm install
pnpm check
pnpm dev
```

`pnpm check` is the required gate before opening a pull request. It runs the
workspace typecheck, tests, and builds.

Keep local machine overrides in `.env.local` or `.env.*.local`. The root `.env`
file is tracked intentionally for Nx defaults.

## Pull Requests

- Keep changes focused and explain the user-facing behavior or maintenance
  reason in the PR description.
- Add or update tests and docs when behavior, commands, or architecture change.
- Run `pnpm check` locally and include any relevant manual verification notes.
- Do not commit secrets, private vault contents, generated build output, or
  local state directories.
