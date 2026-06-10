# Architecture Invariants

This directory captures repo-level invariants: statements that should remain
true as KB-2 grows.

Use these as review tools. A reviewer should be able to compare a change against
an invariant and flag drift.

## Current Invariants

Product and domain invariants — what the product is and how it treats data:

- [Single writer, one service boundary](./product/single-writer-service-boundary.md)
- [Filesystem is durable truth](./product/filesystem-durable-truth.md)
- [Content, not people (local product)](./product/content-not-people.md)

Engineering invariants — how the codebase stays healthy:

- [Package-composed monorepo](./engineering/package-composed-monorepo.md)
- [Frontend components and Storybook](./engineering/frontend-components-and-storybook.md)
- [Tests never touch real user data](./engineering/tests-never-touch-real-user-data.md)
- [UI packages own no transport](./engineering/ui-packages-own-no-transport.md)

## How To Read These

Each invariant should stay short and concrete:

- the rule
- examples that satisfy it
- examples that violate it
- known exceptions, if any
- what to check during review
