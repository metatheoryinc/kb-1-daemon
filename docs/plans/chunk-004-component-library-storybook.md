# Chunk 004: Component Library And Storybook

## Purpose

Seed the KB-2 frontend component system from the UI patterns we like in KB-1,
then make it reviewable in Storybook.

The goal is not to perfectly curate every component during this chunk. The goal
is to establish the component-library package, Storybook organization, theme
inspection, and enough imported/adapted KB-1 UI building blocks that future local
UI work can iterate from a strong baseline.

## Starting Context

By this point, the daemon should host a minimal local UI shell and the repo
should have a working local content substrate proof. KB-2 also has an invariant:
frontend pages are composed from semantic components, and semantic components
are visible in Storybook.

## Desired End State

KB-2 has a frontend component package and Storybook setup that make the UI
building blocks inspectable before they are wired into app routes. The package
is seeded from KB-1 according to the import strategy below.

## Import Strategy

Import KB-1's primitives and low-dependency building blocks wholesale: buttons,
badges, icons, inputs, menus, dialog shells, panels, and the theme/token files
they depend on. Wholesale at this tier avoids a tedious component-by-component
selection process.

Higher-order components that depend on KB-1 data layers (TanStack Query, KB-1
stores, network calls) are not imported. They get rebuilt in later chunks as
compositions of the primitives, when a real surface needs them.

Explicitly excluded from import: marketing components, auth/org/billing
surfaces, and presence/collaboration UI (cursors, avatars, follow mode).

Everything checked in must compile, have a story, and carry no KB-1 runtime
dependencies. Nothing lands in a parked or excluded-but-checked-in state —
if a component doesn't make the bar, it doesn't come over.

Pre-flight: KB-1 and KB-2 share the same frontend majors (Svelte 5, SvelteKit
2, Tailwind 4, Storybook 10 per KB-1's catalog), which is what makes this a
copy rather than a port. Verify this still holds before importing; if versions
have drifted, stop and resize the chunk rather than discovering it midway.

## Invariants

- The component library is a package, not page-local code.
- Pages should compose semantic components, not Tailwind-heavy markup trees.
- Semantic components have Storybook stories.
- Storybook is organized into clear groups such as `App/Primitives`,
  `App/Layout`, and feature/app areas.
- Storybook supports light, dark, and side-by-side inspection.
- Stories use fixtures/mocks so UI review does not require a live daemon for
  every component.
- The imported KB-1 UI is a starting point, not a permanent compatibility
  contract.

## Acceptance Criteria

The chunk is complete when all of the following are true:

1. A frontend component package exists in the workspace.
2. Storybook is configured for the KB-2 frontend/component package.
3. Storybook can be run locally with a documented command.
4. Storybook has light, dark, and side-by-side color mode inspection.
5. Storybook has clear top-level organization for primitives, layout, and app or
   feature surfaces.
6. KB-1's primitive-tier components and theme tokens have been imported into
   the KB-2 component package per the import strategy.
7. Every checked-in component compiles and has a story; excluded components are
   not checked in at all.
8. Representative primitives have stories.
9. At least one layout/app-shell style composition has a fixture-backed story.
10. The local UI app can consume at least one component from the component
    package.
11. `pnpm check` covers the component package and Storybook-relevant typecheck.
12. No route/page becomes a large Tailwind-heavy implementation that bypasses the
    component package.
13. No live backend is required to browse the core component library stories.

## Testing Expectations

Required coverage:

- typecheck for the component package
- typecheck/build coverage for Storybook or the nearest practical Storybook
  validation target
- at least one lightweight component unit/render test if the repo has an
  established Svelte component test pattern by then
- root `pnpm check` includes the new package checks

Visual/manual Storybook review is part of the acceptance criteria because this
chunk is about design iteration infrastructure.

## Manual Verification

A reviewer should be able to run an equivalent flow:

```bash
pnpm install
pnpm check
pnpm storybook
```

The expected world:

- Storybook opens successfully
- the sidebar includes primitives, layout, and app/feature groupings
- light mode can be inspected
- dark mode can be inspected
- side-by-side mode can be inspected
- representative KB-1-derived components render without backend services
- at least one app shell or workspace composition story is visible
- the local UI imports and renders at least one component from the package

## Non-Goals

- No final visual polish requirement.
- No requirement to wire the full KB-1 UI into the local app.
- No requirement to keep every imported KB-1 component.
- No auth, org, cloud relay, billing, or presence implementation.
- No requirement that Storybook connect to live daemon APIs.

## Decisions

- The component package is `packages/ui` (package name `@kb-2/ui`).
- Storybook lives with the component package. Stories are fixture-backed and
  must not require a running daemon.
- KB-1's theme/token files come over with the primitives and become the
  starting KB-2 tokens.
- Import scope, exclusions, and the compile/story bar are defined in the
  import strategy section above.
- The required layout/app-shell composition story (criterion 9) is built fresh
  as a composition of imported primitives, not imported from KB-1's
  higher-order components.

## Verification

After implementation is reported complete:

- the implementer runs `pnpm check` and the manual verification flow above and
  reports actual output, not expected output
- a fresh reviewer who did not implement the chunk audits the diff against the
  acceptance criteria and the invariants in `docs/architecture/invariants/`,
  with particular attention to dead components (imported but unused, broken,
  or storyless)
- any deviation from this plan is listed explicitly in the review summary
