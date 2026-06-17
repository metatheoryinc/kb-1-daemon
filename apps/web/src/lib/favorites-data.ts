/**
 * Adapter that turns the persisted favorites list (app-state store,
 * localStorage only) plus the live vault tree into render-ready rows for
 * the starred panel.
 *
 * Lives in the app, not the UI package: it consumes app-owned state and
 * resolves availability/color from the tree the app already holds. The
 * panel/row components stay prop-driven and never reach for state.
 *
 * Availability: a favorite whose target no longer exists in the tree
 * renders dimmed and non-clickable (`available: false`) rather than
 * vanishing, so a momentary tree-not-loaded state doesn't blink pins out
 * of view and the user keeps a visible record of what they pinned. When
 * the tree is empty (initial load) every favorite is treated as
 * available so its link works the moment the user clicks.
 */
import type { FavoriteEntry } from '$lib/app-state';
import type { AccentName, LocalTreeNode } from '@kb-2/ui';

export interface StarredRow {
  /** Stable id for keyed iteration + active-row matching. `kind:vaultId:path`. */
  id: string;
  kind: 'note' | 'folder';
  /** Human label — the path's basename. */
  label: string;
  /** Resolved accent for the leading swatch: the folder's own color for
   *  folder rows, the parent folder's color for note rows. */
  accent: AccentName;
  /** Vault-relative path; the click target. */
  path: string;
  /** When `false`, render dimmed and non-clickable (target is gone). */
  available: boolean;
  addedAt: number;
}

export interface StarredViewData {
  folders: StarredRow[];
  notes: StarredRow[];
  /** Total renderable rows; convenience for the empty-state check. */
  total: number;
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** Index every tree node by path, retaining folder accent metadata. */
interface TreeIndex {
  notePaths: Set<string>;
  folderPaths: Set<string>;
  folderAccent: Map<string, AccentName>;
}

function indexTree(nodes: LocalTreeNode[]): TreeIndex {
  const index: TreeIndex = {
    notePaths: new Set(),
    folderPaths: new Set(),
    folderAccent: new Map(),
  };
  const walk = (list: LocalTreeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'folder') {
        index.folderPaths.add(node.path);
        index.folderAccent.set(node.path, node.metadata?.color ?? 'slate');
        walk(node.children);
      } else {
        index.notePaths.add(node.path);
      }
    }
  };
  walk(nodes);
  return index;
}

interface BuildArgs {
  favorites: readonly FavoriteEntry[];
  /** The single local vault's id, used to scope entries. */
  vaultId: string;
  /** The live vault tree. Empty during initial load. */
  tree: LocalTreeNode[];
}

export function buildStarredViewData(args: BuildArgs): StarredViewData {
  const { favorites, vaultId, tree } = args;
  const index = indexTree(tree);
  const treeLoaded = tree.length > 0;

  const folders: StarredRow[] = [];
  const notes: StarredRow[] = [];

  // Most-recently-starred first within each group.
  const sorted = [...favorites]
    .filter((e) => e.vaultId === vaultId)
    .sort((a, b) => b.addedAt - a.addedAt);

  for (const entry of sorted) {
    const id = `${entry.kind}:${entry.vaultId}:${entry.path}`;
    if (entry.kind === 'folder') {
      const available = !treeLoaded || index.folderPaths.has(entry.path);
      folders.push({
        id,
        kind: 'folder',
        label: basename(entry.path),
        accent: index.folderAccent.get(entry.path) ?? 'slate',
        path: entry.path,
        available,
        addedAt: entry.addedAt,
      });
    } else {
      const available = !treeLoaded || index.notePaths.has(entry.path);
      const parent = parentOf(entry.path);
      notes.push({
        id,
        kind: 'note',
        label: basename(entry.path),
        accent: index.folderAccent.get(parent) ?? 'slate',
        path: entry.path,
        available,
        addedAt: entry.addedAt,
      });
    }
  }

  return { folders, notes, total: folders.length + notes.length };
}
