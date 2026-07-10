# Support

## Community Support

Use GitHub Issues for reproducible KB-1 Local defects, documentation problems,
and focused feature requests. Search existing issues before opening a new one.

Before filing a bug:

1. Reproduce it with the latest revision on `main` when practical.
2. Confirm the documented Node and pnpm versions.
3. Check `http://127.0.0.1:7382/api/health`.
4. Try an isolated home with `KB1_HOME=$(mktemp -d) pnpm dev` when doing so will
   not risk or overwrite data.
5. Remove vault content, credentials, relay tokens, usernames, and private host
   details from logs and screenshots.

Use the repository's issue forms and include the operating system, installation
method, revision, expected behavior, actual behavior, and minimal reproduction.

## Security and Account Help

- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- For KB-1 Cloud account, billing, or hosted-service questions, email
  `support@metatheory.dev` rather than opening a daemon issue.

## Project Stage

KB-1 Local is under active development. Community support is best-effort, and
interfaces may change before a stable release is tagged. A public issue is not
a service-level agreement or a guarantee of a particular delivery date.
