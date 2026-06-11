# Commander Handoff

For the incoming KB-2 commander session. Read this first, in full, then the
reading list below. This document carries everything the user established
with the previous commander so they do not have to repeat any of it.

## Reading order

1. This document.
2. `docs/narrative.md` — the project's self-story: identity, how we work,
   lore, settled no's, live tensions.
3. `docs/horizons.md` — near/mid/far priorities.
4. `docs/architecture/invariants/README.md` and ALL nine invariant docs under
   `product/` and `engineering/` — these are the review standard for every
   chunk; you will cite them constantly.
5. `docs/plans/local-first-roadmap.md` — execution order and the "KB-1 As
   Reference" rule.
6. `VISION.md` and `docs/architecture/*.md` — skim for orientation; deep-read
   when a chunk touches them.
7. Individual `docs/plans/chunk-*.md` — read on demand; chunk 001-006.5 are
   shipped, their plans are the house style for the ones you will author.

## The working model (user-established; do not re-ask)

- **You are the judgment layer.** Claude commander authors plans, writes and
  enforces invariants, reviews/audits, merges, keeps the Fleet board honest,
  and surfaces decisions. Codex GPT-5.5 tech leads do ALL implementation in
  isolated worktrees. Do not take over implementation (tiny doc/CSS tweaks
  at the commander's seat are fine).
- **Plans are the lever.** Every decidable decision gets decided in the plan
  (a "Decisions" section); open questions that are really deferred decisions
  are a smell. Plans include: KB-1 Reference section (read-before-build),
  acceptance criteria, testing expectations, manual verification, a
  Verification section (independent re-audit), and hard Non-Goals.
- **Invariants are the second lever.** Violations end as fixes or documented
  exceptions, never silence. The user personally reviews against them and
  has twice caught what audits graded too leniently (gallery stories;
  hand-rolled differ) — flag candidates proactively at plan-review time on
  their behalf.
- **Verification is non-negotiable.** Every chunk: implementer browser-
  verifies (curl is not UI verification — a Svelte reactivity bug once
  shipped behind green curl smokes), then a FRESH audit subagent in an
  isolated worktree re-runs everything (pnpm check with --skip-nx-cache,
  live daemon on its own ports + temp KB2_HOME, headless-Chrome DOM
  assertions), gives a verdict against acceptance criteria + all invariants.
  Request-changes rounds go back to the same tech lead. Commander verifies
  the fixes with targeted greps before merging.
- **Merging**: commander squash-merges via `gh pr merge N --squash --subject
  "KB-2 Chunk NNN: Title (#N)"`, pulls main, marks the Fleet task done,
  archives the agent with worktree cleanup, restarts the user's dev server
  on merged main.
- **Git**: commander commits docs directly to main and pushes (Graphite
  protocol explicitly waived by the user for commander work). Implementation
  always flows through PRs. Never amend; no co-author lines.
- **Communication**: the user must never be left hanging — while anything
  runs in the background, every poll wakeup ends with a one-line user-visible
  pulse. Lead with outcomes. Decision asks use a numbered-options table with
  a recommendation.

## Fleet Control operations (hard-won; follow exactly)

- **Spawn procedure**: create task in Implementation Chunks lane → spawn
  Codex agent (`runtime: codex`, worktree enabled, baseBranch main) with the
  full contract brief → IMMEDIATELY send a "go, execute end-to-end" message
  → poll every 2.5-3 min until the agent's WORKTREE shows a branch and file
  changes. Acknowledgment is not execution; keep nudging until ground truth
  shows work ("your next status should say what you BUILT" is the phrasing
  that works).
- **Agents park deaf after reporting waiting_for_review**: change requests
  sit unread; always follow them with a "wake up, you have an unread change
  request" message, and verify pickup within ~3 min.
- **Poll checklist, every wakeup** (use background `sleep N` tasks, 150-300s,
  as timers): (1) `fleet_read_inbox` — delivery to this session is
  pull-based; notifications do NOT wake you (the user has attempted an
  adapter fix; redelivery of coalesced events was observed but no push wake
  yet — verify behavior in the new session), (2) task detail for active
  tasks, (3) executor worktree ground truth (`git -C <worktree> status`,
  recent-file find), (4) tripwire: `git -C <main checkout> branch
  --show-current` must be `main` with clean status — a tech lead once
  escaped its worktree and built in the main checkout (live demo went WIP);
  briefs now pin paths explicitly, keep that language.
- **Brief boilerplate that must stay**: path discipline (work ONLY in your
  worktree; never under the main checkout), never touch the user's live
  servers (7382 daemon on real ~/.kb2, Storybook 6016; 6006 is an unrelated
  process) or real ~/.kb2, temp KB2_HOME + own ports for all verification,
  browser verification mandatory with "report what you visibly observed".
- The audit subagent goes out via the Agent tool (general-purpose,
  isolation: worktree, run_in_background) — its worktrees under
  `.claude/worktrees/` need manual sweeping afterward (`git worktree remove
  --force` + branch -D), and `.claude/` is gitignored.

## State at handoff (2026-06-11)

- **Shipped**: chunks 001 (daemon scaffold), 002 (single-port UI shell +
  dev front-door proxy), 003 (one-file Yjs session, serial coalesced
  persistence), 004 (packages/ui + Storybook from KB-1 primitives), 005
  (KB-1 CM6 editor ported at full fidelity onto the session; `/` is the
  editor), 006 (direct-write detection + loud saving), 006.5 (fast-diff
  reconcile + quiet external-merge path). All audited, merged, board clean.
- **Repo**: renamed to `metatheoryinc/kb-1-daemon` (remote updated). The
  LOCAL directory is being renamed by the user to match around this
  handoff — after rename, run `git worktree prune` if codex worktrees
  complain, and note the Fleet project's workingDirectory must point at the
  new path when the user recreates the commander.
- **Dev surfaces**: `pnpm dev` → everything at http://127.0.0.1:7382 (one
  port; Vite hidden behind the daemon). `pnpm storybook` → 6006 by default
  but that port is occupied on this machine — use `-p 6016`. `pnpm
  smoke:yjs` for two-client CRDT smoke. README has the map.
- **Next up (user-approved direction, not yet authored)**: the **relay
  de-risk spike** — bootstrap private `kb-1-cloud` repo using the SUBMODULE
  topology (public repo canonical + normal; private repo includes it as
  `local/` submodule inside one pnpm/Nx super-workspace; five sharp edges +
  mitigations recorded in narrative Live Tensions — read them) and prove the
  Cloudflare Worker/DO tunnel: HTTP through outbound WS, and the Yjs
  WebSocket relayed end-to-end (two browsers on the cloud URL). Deliverable
  includes latency numbers + the list of CF limits hit. Needs the user's
  Cloudflare/wrangler auth. The plan should carry an AGENTS.md contract for
  the submodule workflow.
- **Naming sequence remaining** (theory in narrative): production `kb-1`
  repo rename is the user's to schedule with their team; bare `kb-1` name
  reusable for the daemon repo only after a cooling period (GitHub redirects
  die on name reuse). Package scope `@kb-2/*` rename still deferred
  (collision consideration: production kb-1 uses `@kb-1/*`).
- **Known debts**: 6 dependabot vulnerabilities (5 moderate, 1 low) on
  frontend dep trees — user is aware, wants a hygiene pass eventually;
  provider has no reconnect (temporary exception in
  edits-save-or-fail-loudly invariant — expiry = offline/read-only mode);
  external file-DELETION semantics deferred (currently reconcile-to-empty +
  loud event); debounce-window edits count as "raced" → loud (documented
  audit nit, correct by design).
- **KB-1 reference repo**: `~/Development/Metatheory/kb-1` (read-only,
  actively developed by the team — NEVER modify). Key areas: editor at
  `apps/@kb-1/web/src/lib/components/app/editor/`, Yjs session DO at
  `apps/@kb-1/api/src/durable-objects/vault-channel.ts`,
  `packages/@kb-1/collab-merge`, MCP tools, e2e specs.

## Memory migration (IMPORTANT)

The previous commander's private memory lives at
`~/.claude/projects/-Users-yohsuzuki-Development-Metatheory-kb-2/memory/` —
keyed to the OLD directory path. After renaming the local directory, copy it
so the new session inherits it:

```bash
cp -R ~/.claude/projects/-Users-yohsuzuki-Development-Metatheory-kb-2 \
      ~/.claude/projects/-Users-yohsuzuki-Development-Metatheory-kb-1-daemon
```

(Adjust the target slug to match the actual new path.) The essential content
is duplicated in this document and the narrative, so nothing is lost either
way — but the memory carries the fine-grained working agreements.
