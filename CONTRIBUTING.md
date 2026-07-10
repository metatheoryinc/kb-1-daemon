# Contributing

KB-1 Local is a pnpm/Nx workspace. The workspace packages are private and are
not published to npm.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Before You Start

Search existing issues and pull requests first. For large features, format
changes, or architectural work, open an issue before investing in an
implementation so maintainers can confirm scope and direction.

Never open a public issue for a suspected vulnerability. Follow the private
process in [SECURITY.md](SECURITY.md).

## Setup

Use Node.js 24, the CI baseline, and the pnpm version declared in
`package.json`.

```bash
git clone https://github.com/metatheoryinc/kb-1-daemon.git
cd kb-1-daemon
corepack enable
corepack install
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
- Keep dependency and lockfile changes limited to the dependency work in the PR.
- Do not commit secrets, private vault contents, generated build output, or
  local state directories.

## Licensing

By submitting a contribution, you agree that it may be distributed under the
repository's [Apache 2.0 license](LICENSE).
