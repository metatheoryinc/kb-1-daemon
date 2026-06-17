<script lang="ts" module>
  import type { AccentName } from '../primitives/accent';
  import type { LocalTreeNode } from './types';

  // Recursively count notes under a set of tree nodes — descendants
  // included, not just direct children. Mirrors FolderNode's count.
  function countNotes(children: LocalTreeNode[]): number {
    let total = 0;
    for (const child of children) {
      if (child.kind === 'file') total += 1;
      else total += countNotes(child.children);
    }
    return total;
  }

  // One render-ready contents row. Folders sort ahead of notes, then
  // each group sorts by name — the same ordering the file tree uses.
  interface ContentsRow {
    kind: 'file' | 'folder';
    path: string;
    name: string;
    /** Resolved swatch color for the row's FolderIcon. */
    color: string;
    /** Folder glyph if the folder carries one; notes never do. */
    icon: string | null;
    /** Recursive note count for a folder row; `null` for a note row. */
    count: number | null;
  }
</script>

<script lang="ts">
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import { accentHex } from '../primitives/accent';

  interface Props {
    /** Display name for the vault — the heading at vault root and the
        first breadcrumb crumb (the shell's DocumentHeader owns the
        breadcrumb; this is here for the vault-root heading). */
    vaultName: string;
    /** `''` is the vault root; any other value is a folder path
        relative to the vault root (no leading slash). */
    folderPath: string;
    /** This folder's own customization, when the vault has any. The
        daemon does not yet expose folder color/icon metadata, so this
        is normally undefined and the icon falls back to the default. */
    metadata?: { color?: AccentName; icon?: string | null };
    /** The folder's full subtree (direct children plus their
        descendants), the same `LocalFolderNode.children` shape the file
        tree uses. Drives the contents list and the recursive count. */
    children: LocalTreeNode[];
    /** Open a child note. Called with the note's vault-relative path. */
    onOpenFile?: (path: string) => void;
    /** Navigate into a child folder. Called with the folder's path. */
    onOpenFolder?: (path: string) => void;
  }

  let {
    vaultName,
    folderPath,
    metadata,
    children,
    onOpenFile,
    onOpenFolder,
  }: Props = $props();

  const isVaultRoot = $derived(folderPath === '');
  const headingName = $derived.by<string>(() => {
    if (isVaultRoot) return vaultName;
    const idx = folderPath.lastIndexOf('/');
    return idx === -1 ? folderPath : folderPath.slice(idx + 1);
  });

  const headingColor = $derived(accentHex[metadata?.color ?? 'slate']);
  const headingIcon = $derived(metadata?.icon ?? null);

  const directFolders = $derived(children.filter((c) => c.kind === 'folder'));
  const directNotes = $derived(children.filter((c) => c.kind === 'file'));
  const recursiveNoteCount = $derived(countNotes(children));

  // Direct children as render-ready rows — folders first, then notes,
  // each group sorted by name. Folder color falls back to the default
  // accent (the daemon has no folder-color metadata yet).
  const contents = $derived.by<ContentsRow[]>(() => {
    const folderRows: ContentsRow[] = directFolders
      .map((node) => ({
        kind: 'folder' as const,
        path: node.path,
        name: node.name,
        color:
          node.kind === 'folder'
            ? accentHex[node.metadata?.color ?? 'slate']
            : accentHex.slate,
        icon: node.kind === 'folder' ? (node.metadata?.icon ?? null) : null,
        count: node.kind === 'folder' ? countNotes(node.children) : 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const noteRows: ContentsRow[] = directNotes
      .map((node) => ({
        kind: 'file' as const,
        path: node.path,
        name: node.name,
        color: accentHex.slate,
        icon: null,
        count: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...folderRows, ...noteRows];
  });

  function openRow(row: ContentsRow): void {
    if (row.kind === 'folder') onOpenFolder?.(row.path);
    else onOpenFile?.(row.path);
  }
</script>

<div class="folder-canvas">
  <div class="body">
    <header class="head">
      <p class="kicker">{isVaultRoot ? 'Vault' : 'Folder'}</p>
      <div class="title-row">
        {#if !isVaultRoot}
          <FolderIcon
            color={headingColor}
            icon={headingIcon}
            size="lg"
            variant="filled"
          />
        {/if}
        <h1 class="title">{headingName}</h1>
      </div>
    </header>

    <section class="stats">
      <div class="stat">
        <span class="stat-label">Subfolders</span>
        <span class="stat-value">{directFolders.length}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Notes (direct)</span>
        <span class="stat-value">{directNotes.length}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Notes (recursive)</span>
        <span class="stat-value">{recursiveNoteCount}</span>
      </div>
    </section>

    <section class="contents">
      <h2 class="section-label">Contents</h2>
      {#if contents.length === 0}
        <p class="empty">This folder is empty.</p>
      {:else}
        <ul class="contents-list">
          {#each contents as row (row.path)}
            <li>
              <button
                type="button"
                class="contents-row"
                onclick={() => openRow(row)}
              >
                <span class="contents-main">
                  <FolderIcon
                    color={row.color}
                    icon={row.icon}
                    size="sm"
                    variant={row.kind === 'folder' ? 'filled' : 'outline'}
                  />
                  <span class="contents-name">{row.name}</span>
                </span>
                {#if row.count !== null}
                  <span class="contents-count">{row.count}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .folder-canvas {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--rd-panel);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 36px 56px 64px;
    max-width: 760px;
    width: 100%;
    box-sizing: border-box;
    align-self: center;
  }

  @media (max-width: 640px) {
    .body {
      padding: 24px 18px 48px;
    }
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 28px;
  }

  .kicker {
    margin: 0;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .title {
    margin: 0;
    color: var(--rd-ink-1);
    font-family: var(--rd-serif);
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    margin-bottom: 32px;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 16px;
    border: 1px solid var(--rd-rule);
    border-radius: 8px;
    background: var(--rd-panel);
    min-width: 140px;
  }

  .stat-label {
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .stat-value {
    color: var(--rd-ink-1);
    font-family: var(--rd-serif);
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .section-label {
    margin: 0 0 8px;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .empty {
    margin: 0;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 13px;
  }

  .contents-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .contents-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 4px;
    border: none;
    border-bottom: 1px solid var(--rd-rule);
    background: transparent;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 80ms ease;
  }

  .contents-row:hover {
    background: var(--rd-hover);
  }

  .contents-main {
    display: inline-flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }

  .contents-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .contents-count {
    flex-shrink: 0;
    color: var(--rd-ink-4);
    font-family: var(--rd-mono);
    font-size: 10px;
  }
</style>
