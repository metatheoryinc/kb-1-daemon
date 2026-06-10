# Frontend Components And Storybook

## Invariant

Frontend pages are composed from semantic components, and semantic components are
visible in Storybook.

Pages should read as product structure, not Tailwind soup. Storybook should let
reviewers inspect the UI building blocks, layout shells, and app surfaces before
running the full application.

## This Means

- Reusable UI becomes named components.
- Pages compose semantic components instead of embedding large class-heavy
  markup trees.
- Component stories are organized into clear groups such as `App/Primitives`,
  `App/Layout`, and feature/app areas.
- Storybook supports light, dark, and side-by-side inspection when the app has
  color modes.
- Complex app surfaces have fixture-backed stories, not only isolated primitive
  stories.
- UI work can be reviewed in Storybook before it is wired into routes.

## Good Examples

- `Button`, `IconButton`, `Badge`, `FolderIcon`, and similar primitives with
  dedicated stories.
- layout stories such as an app shell, rail layout, or document workspace.
- feature stories such as file tree, editor shell, dialogs, panels, and
  notifications.
- story titles like `App/Primitives/Button`, `App/Layout/App Shell`, and
  `App/Dialogs/MovePickerDialog`.
- a Storybook toolbar that renders light, dark, and side-by-side modes.

## Violations

- A route page contains most of the UI as one large Tailwind-heavy markup tree.
- A reusable control is copied into multiple pages instead of becoming a
  component.
- A semantic component exists but has no Storybook story.
- A component only appears inside a gallery or composition story. Galleries
  and compositions are welcome additions, but every semantic component needs
  its own dedicated story entry with args/controls where sensible.
- Storybook only covers primitives and cannot show app-level composition.
- Dark mode is implemented in the app but not easy to inspect in Storybook.
- Stories require live backend data when fixtures would make them reviewable.

## Exceptions

None currently accepted.

One-off route glue can stay in a route file. Once markup represents a reusable
product concept, layout structure, or repeated interaction, it should become a
semantic component and receive a story.

## Review Checklist

- Can the page be understood by reading component names?
- Did new reusable UI move into a named component?
- Does each semantic building block have a Storybook story?
- Is the story filed under a useful category such as primitives, layout, or app?
- Can light/dark behavior be inspected without running the full app?
- Are stories fixture-backed enough to support fast design iteration?
