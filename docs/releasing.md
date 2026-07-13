# Release Process

KB-1 Local is currently distributed from source and as a Docker build from this
repository. The npm workspace packages are private and are not published.

## Release Checklist

1. Start from a clean, reviewed commit on `main`.
2. Confirm the README, setup skill, packaging guide, and KB-1 Cloud docs describe
   the same supported modes, prerequisites, and security boundary.
3. Review migrations and back up a representative `KB1_HOME` before testing
   them.
4. Install from the lockfile and run the full gate:

   ```bash
   corepack enable
   corepack install
   pnpm install --frozen-lockfile
   pnpm audit --prod
   pnpm check
   ```

5. Build the production Docker image and run the automated release smoke:

   ```bash
   pnpm smoke:release
   ```

   The smoke uses a loopback-only random port and an isolated Docker volume. It
   verifies the packaged license/notices, `/api/health`, the bundled local app
   plus every bundled JavaScript/CSS asset (including lazy route chunks), the
   complete MCP tool list,
   two-client Yjs editing and explicit disk flush,
   then restarts the container and proves the edit persisted. The temporary
   container, volume, and default per-run image tag are removed even when a
   check fails. Set
   `KB1_RELEASE_SMOKE_IMAGE` to override the image tag or
   `KB1_RELEASE_SMOKE_PORT` when a fixed host port is needed.

6. Run a dedicated secret scanner across the full Git history and review
   dependency alerts.
7. Regenerate and review the production dependency inventory. The committed
   notice file covers the daemon runtime plus the web runtime and build-tool
   dependency graphs used to produce the static application. The conservative
   build-tool coverage prevents framework or bundler runtime code from being
   omitted merely because its package is declared as a development dependency.
   Platform-specific optional native build bindings are excluded so the committed
   inventory is identical on macOS and Linux; those bindings are not copied into
   the runtime image, while their platform-neutral parent packages remain listed.
   The Docker image includes both the notice file and `LICENSE`:

   ```bash
   pnpm licenses:generate
   git diff -- THIRD_PARTY_NOTICES.md
   pnpm licenses:check
   ```

   Review every dependency, declared license, missing notice-file warning, and
   dependency alert before approving a release. `pnpm check` also runs the
   deterministic inventory check so dependency changes cannot silently leave
   the committed notices stale.
8. Create a version tag and GitHub Release. Release notes must identify the
   project stage, supported platforms, breaking changes, migrations, known
   issues, and security-relevant changes.

Do not describe a roadmap item as shipped, publish npm packages from this
workspace, or expose a daemon smoke-test port beyond loopback as part of the
release process.
