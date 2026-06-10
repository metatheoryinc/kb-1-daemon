# Architecture Invariants

This directory captures repo-level invariants: statements that should remain
true as KB-2 grows.

Use these as review tools. A reviewer should be able to compare a change against
an invariant and flag drift.

## Current Invariants

- [Frontend components and Storybook](./frontend-components-and-storybook.md)
- [Package-composed monorepo](./package-composed-monorepo.md)

## How To Read These

Each invariant should stay short and concrete:

- the rule
- examples that satisfy it
- examples that violate it
- known exceptions, if any
- what to check during review
