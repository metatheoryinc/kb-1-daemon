# KB-2 Narrative

The agent's living self-story for this project. Read in full at session
start; updated continuously as material moments happen.

## Who we are right now

KB-2 is the local-first, open-source rebuild of the KB-1 product (the repo is
named kb-2; the product's real name is KB-1 — rename deferred). The user's
filesystem is the durable truth; a daemon is the only runtime writer; the
cloud arrives later as relay/identity/collaboration, never as the content
store. Five chunks in, the core thesis is proven and demoable: one command
starts a daemon that serves KB-1's production CM6 editor over a Yjs session,
and every keystroke materializes into a plain Markdown file the user owns.

## How we work

A Claude commander (judgment, plans, invariants, audits, board-keeping)
directs Codex GPT-5.5 tech leads (implementation) through Fleet Control. The
chunk plan is the lever: every decidable decision gets decided in the plan;
"open questions" that are really deferred decisions are a smell. Invariants
in `docs/architecture/invariants/` are the second lever — implementers build
against them, independent audit subagents verify against them, and
violations end as fixes or documented exceptions, never silence. Every chunk:
plan → worktree implementer → PR → independent audit that re-runs everything
(real browser included) → fix round → squash-merge by the commander. KB-1
(sibling checkout, read-only) is the reference for every chunk: borrow before
inventing.

## What we've lived through

- **Day one was the whole arc.** 2026-06-10: reviewed and tightened the
  tech-lead-authored plans for chunks 002-004, pivoted the docs to
  local-first, then shipped single-port UI shell, one-file Yjs session,
  component library + Storybook, and the full KB-1 editor port — ending with
  the user typing `wo111111w it w222222orks!!!!!` from two tabs into one
  converging document. The editor port was a transplant, not a rewrite,
  because KB-1's editor takes a Y.Doc and callbacks instead of owning
  transport — that lesson became the ui-packages-own-no-transport invariant.
- **The audit loop earns its cost.** Chunk 002 shipped a Svelte 5 reactivity
  bug (plain `let` instead of `$state`) behind green curl smokes; the user
  caught it in DevTools. Real-browser verification has been mandatory in
  every plan since, for implementers and auditors both.
- **Codex agents idle by default.** They end turns after acknowledging;
  inbox delivery doesn't reliably wake them. The working protocol: spawn,
  nudge immediately, keep nudging until the worktree shows actual changes.
  Ground truth is files, not status lines.
- **The user reviews against invariants and wins.** The gallery-story ruling
  (a component appearing in a gallery is not a per-component story) came from
  the user applying the Storybook invariant more strictly than the audit did;
  the invariant text was tightened the same hour.

## What we've decided not to do

- No presence, cursors, selections, or follow mode in the local product —
  content events only. (Named exception: durable actor attribution in audit
  logs/metadata.)
- No Graphite/branch ceremony for commander doc work — direct commits to
  main; implementation still flows through PRs.
- No shared working trees: implementers always get isolated worktrees; the
  main tree is the commander's seat.
- No mention autocomplete or image upload until their backing (directory,
  asset API) exists.
- No speculative generalization: the one-file session stayed one-file at the
  route layer, parameterized by path inside.

## Live tensions

- When to rename kb-2 → KB-1 across packages (deliberately deferred).
- 6 dependabot vulnerabilities (5 moderate, 1 low) from frontend dep trees —
  needs a hygiene pass soon.
- The Yjs provider has no reconnect; WebSocket drops currently rely on a
  status chip — covered by a temporary exception to the
  edits-save-or-fail-loudly invariant until offline/read-only mode ships.
