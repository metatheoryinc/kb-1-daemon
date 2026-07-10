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

5. Build the Docker image and smoke-test it with a loopback-only port mapping:

   ```bash
   docker build -f apps/daemon/Dockerfile -t kb-1-daemon:release-candidate .
   docker run --rm \
     -p 127.0.0.1:17382:7382 \
     -v kb1-release-smoke:/data/kb1 \
     kb-1-daemon:release-candidate
   ```

   In another shell, verify `/api/health`, the local app, and the MCP endpoint.

6. Run a dedicated secret scanner across the full Git history and review
   dependency alerts.
7. Review production dependency licenses with `pnpm licenses list --prod` and
   include required third-party notices with any distributed artifact.
8. Create a version tag and GitHub Release. Release notes must identify the
   project stage, supported platforms, breaking changes, migrations, known
   issues, and security-relevant changes.

Do not describe a roadmap item as shipped, publish npm packages from this
workspace, or expose a daemon smoke-test port beyond loopback as part of the
release process.
