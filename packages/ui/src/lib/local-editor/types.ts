import type { AccentName } from '../primitives/accent';

export interface LocalFileNode {
  kind: 'file';
  path: string;
  name: string;
}

export interface LocalFolderMetadata {
  color?: AccentName;
  icon?: string | null;
}

export interface LocalFolderNode {
  kind: 'folder';
  path: string;
  name: string;
  metadata?: LocalFolderMetadata;
  children: LocalTreeNode[];
}

export type LocalTreeNode = LocalFileNode | LocalFolderNode;

/**
 * A vault as the visibility filter sees it. The filter lists every
 * vault the shell knows about and toggles each one's visibility via the
 * deny-list the app owns. The local shell has a single vault, so the
 * list is usually one row, but the shape carries the full set so the
 * component stays agnostic about how many there are.
 */
export interface VaultFilterEntry {
  id: string;
  name: string;
  accent: AccentName;
}

export interface LocalSearchResult {
  path: string;
  line: number;
  lineText: string;
  before?: string[];
  after?: string[];
}

export interface LocalFileAction {
  kind: 'file';
  action: 'rename' | 'move' | 'delete' | 'favorite' | 'unfavorite';
  path: string;
}

export interface LocalFolderAction {
  kind: 'folder';
  action: 'new-note' | 'new-folder' | 'rename' | 'move' | 'delete' | 'favorite' | 'unfavorite';
  path: string;
}

/**
 * One render-ready starred row. The app builds these from its persisted
 * favorites plus the live tree (see apps/web favorites-data); the panel
 * and row stay prop-driven and never touch state or storage.
 */
export interface StarredRowData {
  /** Stable id (`kind:vaultId:path`) — keyed iteration + active match. */
  id: string;
  kind: 'note' | 'folder';
  /** Human label — the path basename. */
  label: string;
  /** Accent swatch color: a folder's own / a note's parent-folder color. */
  accent: AccentName;
  /** Vault-relative path; passed back on pick / unstar. */
  path: string;
  /** When `false`, the row renders dimmed and non-clickable. */
  available: boolean;
}

export interface LocalVaultAction {
  kind: 'vault';
  action: 'new-note' | 'new-folder' | 'rename' | 'delete';
}

export type LocalTreeAction = LocalFileAction | LocalFolderAction | LocalVaultAction;
