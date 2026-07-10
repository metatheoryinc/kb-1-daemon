# Security Policy

## Supported Versions

KB-1 Local is under active development and does not yet have a stable release
line. Security fixes are applied to the latest revision on `main`. Older
commits, forks, and locally modified builds are not maintained by the KB-1
team.

## Report a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting from the repository **Security**
tab. If that is unavailable, email `support@metatheory.dev` with the subject
`KB-1 Local security report`.

Include the affected revision, operating system, deployment method, impact,
reproduction steps, and any suggested mitigation. Remove vault content,
credentials, relay tokens, and other personal data from logs or screenshots.

We will acknowledge the report as soon as practical, investigate it privately,
and coordinate disclosure after a fix or mitigation is available. Please do
not disclose the issue publicly before that coordination is complete.

## Local Security Boundary

KB-1 Local is designed as a trusted local service. The local HTTP, WebSocket,
and MCP surfaces do not provide application authentication or per-user
authorization.

- Keep the daemon on its default `127.0.0.1` bind address.
- Do not publish the daemon port directly to the public internet.
- Bind Docker port mappings to `127.0.0.1`, not every host interface.
- Use an access-controlled private network or KB-1 Cloud relay for intentional
  remote access.
- Treat every connected agent as having the ability to read and modify the
  vaults you make available to it.
- Keep `KB1_RELAY_TOKEN`, vault contents, and diagnostic logs out of issues and
  source control.
- Back up `KB1_HOME` before migrations, upgrades, or bulk agent operations.

Security reports involving KB-1 Cloud, its relay, or hosted vaults may still be
submitted through this process; identify the affected product mode in the
report.
