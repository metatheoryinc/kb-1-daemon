# KB-2 Narrative

The agent's living self-story for this project. Read in full at session
start; updated continuously as material moments happen.

## Who we are right now

KB-2 is the local-first, open-source rebuild of the KB-1 product (the repo is
named kb-2; the product's real name is KB-1 — rename deferred). The user's
filesystem is the durable truth; a daemon is the only runtime writer; the
cloud arrives later as relay/identity/collaboration, never as the content
store. Seven increments in (001-006.5), the core thesis is proven and
demoable: one command
starts a daemon that serves KB-1's production CM6 editor over a Yjs session,
every keystroke materializes into a plain Markdown file the user owns, and
the unhappy path is loud — external file edits reconcile-and-warn in every
client (disk wins), and persistence failures alarm until saving recovers.

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
- **The hand-rolled differ catch.** Chunk 006 shipped a 39-line fresh
  prefix/suffix differ; the audit even named it ("fresh implementation") and
  the commander graded it acceptable. The user rejected it on principle —
  battle-tested library or nothing — which became the
  battle-tested-over-hand-rolled invariant and chunk 006.5 (fast-diff +
  applyDelta, net-negative code — shipped same day, clean audit, the first
  zero-fix-round chunk). Standing instruction: spot these on the user's
  behalf; "it's only 40 lines" is the canonical size of the mistake.

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

- Repo naming sequence (agreed 2026-06-11; steps 1-2 DONE — public repo
  renamed to `kb-1-daemon` with local dir matching; private `kb-1-cloud`
  born and seeded 2026-06-11): production
  `kb-1` renamed later with team coordination; only after a cooling period
  can `kb-1-daemon` take the bare `kb-1` name — GitHub redirects die when a
  freed name is reused, which would silently misdirect the team's stale
  clones/CI. Package-scope rename (@kb-2/*) still deferred; note production
  kb-1 already uses @kb-1/* internally.
- Cloud/local repo topology (converged 2026-06-11): public repo stays
  canonical and normal; private `kb-1-cloud` includes it as a `local/`
  submodule inside one pnpm/Nx super-workspace (worktree-safe, one typecheck
  graph). Sharp edges + mitigations to live in the cloud repo's AGENTS.md:
  submodule init in worktrees, branch-before-edit inside local/, catalog
  mirroring with CI drift check, pointer-bump ritual. The relay de-risk
  spike (CF Worker/DO tunnel, Yjs-over-relay) doubles as this topology's
  pressure test.
- 6 dependabot vulnerabilities (5 moderate, 1 low) from frontend dep trees —
  needs a hygiene pass soon.
- The Yjs provider has no reconnect; WebSocket drops currently rely on a
  status chip — covered by a temporary exception to the
  edits-save-or-fail-loudly invariant until offline/read-only mode ships.
