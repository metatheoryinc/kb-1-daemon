# Chunk 011: The Local Editor App

## Purpose

Turn the single-document demo page into the real local product: a
markdown editor with a file tree. A stripped-down KB-1 — file tree with
folder customizations (colors, icons, right-click menus), main editing
panel with a breadcrumb trail, and search. Nothing else: no history, no
presence, no users/login, no orgs, no settings, no agents/integrations
chrome. This is `content-not-people` rendered as a UI.

Two rounds, one plan. Round A (backend): folder metadata persistence +
API + MCP. Round B (frontend): the app shell. Round B depends on Round
A's merged API.

## KB-1 Reference (read-only sibling checkout; borrow before inventing)

- File tree: `apps/@kb-1/web/src/lib/components/app/secondary-rail/files/`
  — `FilesPanel.svelte`, `FolderNode.svelte`, `FileNode.svelte`,
  `FilesPanelHeader.svelte`, `FilesSearchResults.svelte`, `fixtures.ts`.
- Breadcrumb: `apps/@kb-1/web/src/lib/components/app/primitives/Breadcrumb.svelte`
  (ALREADY PORTED to our `packages/ui` — reuse, don't re-port).
- Document header composition: `apps/@kb-1/web/src/lib/components/app/canvas/document/DocumentHeader.svelte`
  (port the breadcrumb+title arrangement; strip presence/favorite/history
  buttons).
- Folder icon/color resolution: KB-1's `useFolderIconContext()` /
  `folderIconResolver` pattern — adapt to a single-vault store fed by our
  new metadata API.
- What NOT to port: anything touching `useTreePresenceLookup`,
  `PresenceRecord`, org grouping (`FilesOrgGroup`, `FilesVaultGroup`),
  role-gated menu items, favorites, mention notifications, Inspector,
  PrimaryRail.

## Decisions (all decided; do not reopen)

### Round A — folder metadata backing

- **Persistence**: `.kb2/folders.yml` in the vault — durable `.kb2`
  metadata per `filesystem-durable-truth`. Schema: a single top-level
  `folders` map keyed by vault-relative folder path:
  `folders: { "projects/active": { color: "amber", icon: null } }`.
  Color values are the accent names already defined in `packages/ui`'s
  accent system (closed set, validated on write); `icon` is a string
  icon name from the ui icon set or null. Unknown folders simply absent.
  Parse with the YAML library already used in the repo (battle-tested
  over hand-rolled; if none is in the dependency tree yet, use `yaml`).
- **vault-core**: `getFolderMetadata(path)`, `setFolderMetadata(path,
  {color?, icon?})` (set merges; `null` clears a key; empty metadata
  removes the folder entry), and `listFolderMetadata()` returning the
  whole map for tree hydration. Writes are atomic (temp file + rename,
  matching existing persistence patterns) and emit audit rows like every
  other mutation. Setting metadata on a non-existent folder fails with
  the canonical not-found code from the existing failure union.
- **Rename/move integration**: `moveFolder` (and any folder-affecting
  op) relocates matching `folders.yml` keys (including descendants) in
  the same operation — metadata follows the folder the way sessions
  follow renames. Deleting a folder drops its entries. Dual-assert in
  tests (API read-back AND raw folders.yml content).
- **REST**: `GET /api/folders/{path}/metadata` and
  `PUT /api/folders/{path}/metadata` on the existing app router, plus
  `GET /api/tree` gains folder metadata inline on folder nodes (one
  round trip hydrates the tree; no N+1 metadata fetches). Same response
  shapes regardless of internal state; failures through the one
  canonical union with exhaustive compiler-checked mappers
  (`one-failure-dialect`).
- **MCP parity (Round A closes the known gaps)**: new tools
  `get_folder_metadata`, `set_folder_metadata` (write tool audited,
  `mcp_client` attribution like the existing 13); `list_files` output
  includes folder metadata the same way `/api/tree` does. Parity rule
  recorded in the MCP server docs: every UI-reachable vault operation
  has a tool equivalent.

### Round B — the app shell

- **Layout**: two-pane shell in `apps/web` — left panel (file tree +
  search) ~280px, main panel (document header with breadcrumb + editor).
  Minimal top chrome inside the left panel header: vault name, daemon
  status chip (existing `LocalStatusShell` pattern stays), color-mode
  toggle button. No primary rail. No inspector. Components live in
  `packages/ui` (transport-free, fixture-backed, storied); `apps/web`
  owns all fetching and wiring (`ui-packages-own-no-transport`).
- **Tree data**: `apps/web` fetches `/api/tree` (full depth) on load and
  rebuilds on mutation events; tree component takes the data as props.
  Single vault: no org/vault grouping layers — the panel renders the
  root tree directly. Expansion state is client-side (`Set<string>` of
  folder paths) and survives within the session only (no persistence —
  don't build for eventualities).
- **Navigation**: URL path IS the document path (existing catch-all
  route). Clicking a file navigates to `/<path>` with `keepFocus`
  semantics preserved (the chunk-007 keystroke-drop lesson). Folder
  click toggles expansion. Breadcrumb: folder segments are NON-clickable
  labels in this chunk (no folder canvas exists); the document segment
  is current. Renames keep the editor session bound (noteId stable;
  path is a label) — this already works; the UI must not break it.
- **Context menus** (reuse ported `ContextMenu.svelte`): file → Rename,
  Move, Delete; folder → New Note, New Folder, Rename, Move, Delete,
  Color (accent swatch row inline in the menu — no separate picker
  dialog this chunk; icon customization is API-supported but UI-deferred).
  Rename and Move are one text-input dialog (new path), validated
  against the existing path rules, calling the existing move endpoints.
  Delete confirms with a simple dialog naming the path. All mutations
  call the daemon REST API and optimistically refresh the tree.
- **Search**: the panel header search input (ported `SearchInput`)
  debounces 250ms into `GET /api/search`; non-empty query swaps the tree
  for a results list (port `FilesSearchResults` minus presence): file
  path + context snippet rows; click opens the file and clears back to
  tree. No pagination UI this chunk (server `limit` 50, "more results"
  label when truncated).
- **Storybook**: every ported/new semantic component gets its own story
  (tree panel, folder node, file node, search results, document header,
  the assembled shell as a fixture-backed composition story). Stories
  for stripped concerns are not ported at all. Light/dark inspectable.
- **What does not exist on purpose**: favorites, history, presence,
  avatars-of-others, login, orgs, settings page, notifications, agents
  UI, mention autocomplete, image upload. Remove favorite affordances
  from ported components rather than hiding them.

## Acceptance Criteria

Round A:
1. `folders.yml` read/write/merge/clear with atomic writes and audit
   rows; metadata follows moveFolder (incl. descendants) and dies with
   deleteFolder — all dual-asserted (API + raw file).
2. REST metadata endpoints + tree inline metadata; MCP
   `get/set_folder_metadata` + `list_files` metadata; identical failure
   shapes through the canonical union; exhaustive mappers compile-checked.
3. Repo gates green; new vault-core code at the 100% pure-logic gate;
   route/tool glue ≥90%; negative-test one gate.

Round B:
4. Real-browser walkthrough (implementer AND auditor, headless Chrome,
   fresh temp vault with seeded folders/files): cold daemon start →
   browser load → tree renders the real vault; expand/collapse; open
   file via tree → editor loads, breadcrumb shows the path; type →
   round-trips; right-click folder → set color → color visibly changes
   in the tree AND survives daemon restart (folders.yml); new
   note/folder, rename (editor session survives a rename of the OPEN
   file — type across the rename instant), move, delete all work from
   context menus; search returns results with snippets, click opens the
   file; raw JSON/404 never reach the browser.
5. Every new/ported component has a dedicated story; stories are
   fixture-backed (no server); light/dark inspectable; no story exists
   for stripped concerns.
6. MCP parity matrix documented (UI capability ↔ tool) in
   `docs/architecture/mcp-parity.md` with zero unexplained gaps: every
   context-menu action and search maps to an existing or new tool.
7. Repo gates green incl. Storybook build; no transport in packages
   (grep `fetch(`/`WebSocket(`/`/api/` in packages diff is clean).

## Testing Expectations

- Round A: real-fs vitest (mkdtemp) for folders.yml ops incl. unicode
  paths, concurrent set/move interleavings, malformed-yml recovery
  (corrupt file → loud failure, not silent default); property test for
  move-relocates-keys (random tree + random move → keys match new
  layout exactly). Dual assertion everywhere.
- Round B: component tests via Storybook stories (fixtures); route-level
  integration test in apps/web for tree fetch → render → navigate; the
  browser walkthrough in criterion 4 is mandatory for implementer and
  auditor both (straddle the rename boundary while typing — chunk-007
  lesson).
- Implementer/auditor on own ports (9890+/9990+), temp KB2_HOME, kill
  what they start.

## Non-Goals

- No folder canvas page, no favorites, no history/metadata/backlinks
  UI, no presence anything, no settings page, no icon-picker UI (API
  only), no link index, no tier-2 ops, no pagination UI, no mention
  autocomplete, no image upload, no offline/reconnect work (existing
  invariant exception unchanged).
- No changes to the hosted/cloud repo in this chunk.

## Verification

Fresh audit subagent per round (own worktree at a unique pinned /tmp
path, ports 9990+): re-runs all gates + negative coverage test;
re-runs the full browser walkthrough on its own daemon with its own
temp vault; greps packages for transport; ground-truths the parity
matrix by invoking each MCP tool against its own daemon and matching
the UI behavior; verdicts every criterion + all eleven invariants.
Tooling-limitation claims are audit targets.
