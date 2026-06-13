# Shared Editor Chrome

## Invariant

Shared editor chrome (status indicator, save notifications, presence
affordances, page shell) lives in `@kb-2/ui` and is consumed by every app that
renders the editor.

An app MUST NOT fork chrome behavior locally. Any intentional divergence between
consuming apps is a documented exception in this file with a reason and expiry.
A PR that changes editor chrome in one app without routing it through
`@kb-2/ui` or recording an exception here is a violation.

## This Means

- Save-notification layout, stacking, visibility policy, and dismissal affordance
  are shared UI behavior, not app-local route markup.
- Apps may supply product-specific copy through props.
- Apps may own transport state, event sources, and callbacks that feed shared
  chrome.

## Documented Divergence

- Presence cursors and roster are cloud-only. The local product has no presence
  by settled decision. No expiry.

## Violations

- Recreating save-notification strips in an app route.
- Changing the editor status indicator, notification behavior, or page shell in
  one app without a shared `@kb-2/ui` component change.
- Hardcoding local-only or cloud-only copy inside shared chrome instead of
  passing it from the consuming app.

## Review Checklist

- Does editor chrome live in `@kb-2/ui`?
- Are app differences limited to props, callbacks, or documented exceptions?
- Do shared chrome components still satisfy
  [UI packages own no transport](../engineering/ui-packages-own-no-transport.md)?
- Does new semantic chrome have a Storybook story?
