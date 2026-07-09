# UI Packages Own No Transport

## Invariant

Frontend packages (`packages/ui`, `packages/editor`, future component
packages) contain no transport and no endpoint knowledge. Data and side
effects enter through props, stores, and host-supplied callbacks; `fetch`,
WebSocket construction, EventSource, and daemon route paths live in apps.

KB-1 proved this architecture: its entire CM6 editor makes zero API calls —
the host supplies a Y.Doc, an upload callback, a navigation callback. That
separation is what made the KB-1 port a transplant instead of a rewrite.
Keep it.

## This Means

- Components render what they are given; they do not decide where data comes
  from.
- Yjs-backed components take a `Y.Doc`/`Y.Text` (or equivalent binding) as a
  prop; the provider that syncs it over a WebSocket lives in the app.
- Actions with side effects (navigate, upload, save) are callbacks supplied
  by the host app.
- Storybook stories work from fixtures precisely because nothing in the
  package can reach for a server.

## Good Examples

- `apps/web` owning the y-protocols provider and passing the bound doc into
  the editor component.
- `LocalStatusShell` receiving health data via props, with the fetch in
  `apps/web`'s wrapper.

## Violations

- A component in a package calling `fetch('/api/...')` or otherwise reaching
  across the app boundary for server data.
- A package hardcoding daemon routes, ports, or WebSocket URLs.
- A CM6 extension performing network I/O directly instead of routing through
  a host callback.

## Exceptions

None currently accepted.

## Review Checklist

- Grep the package diff for `fetch(`, `WebSocket(`, `EventSource(`, and
  `/api/` — anything found belongs in an app.
- Do new components take data via props/callbacks?
- Do their stories run from fixtures with no server?
