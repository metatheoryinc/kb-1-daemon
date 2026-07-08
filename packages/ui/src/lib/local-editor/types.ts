import type { AccentName } from "../primitives/accent";

type LocalArtifactKind = "text" | "attachment";

type LocalArtifactPreview =
  | "markdown"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "download";

interface LocalArtifactInfo {
  kind: LocalArtifactKind;
  contentType: string;
  editable: boolean;
  preview: LocalArtifactPreview;
}

export interface LocalFileNode {
  kind: "file";
  path: string;
  name: string;
  artifact?: LocalArtifactInfo;
}

export interface LocalFolderMetadata {
  color?: string;
}

export interface LocalFolderNode {
  kind: "folder";
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
  metadata?: LocalFolderMetadata;
  colorHex?: string | null;
}

/**
 * One vault group the files rail renders: its identity, display name,
 * accent, and its own file tree. The host builds one of these per vault
 * (the tree is fetched per-vault over the scoped data routes) and the
 * panel renders a `VaultGroup` for each. The panel stays prop-driven —
 * it never fetches a tree itself.
 */
export interface VaultGroupData {
  id: string;
  name: string;
  accent: AccentName;
  metadata?: LocalFolderMetadata;
  colorHex?: string | null;
  tree: LocalTreeNode[];
}

export interface LocalSearchResult {
  path: string;
  line: number;
  lineText: string;
  before?: string[];
  after?: string[];
}

export interface LocalFileAction {
  kind: "file";
  action: "rename" | "move" | "delete" | "favorite" | "unfavorite";
  path: string;
}

export interface LocalFolderAction {
  kind: "folder";
  action:
    | "new-note"
    | "new-folder"
    | "customize"
    | "rename"
    | "move"
    | "delete"
    | "favorite"
    | "unfavorite";
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
  kind: "note" | "folder";
  /** Human label — the path basename. */
  label: string;
  /** Vault context for the secondary line ("in <vault>"). */
  vaultLabel: string;
  /** Accent swatch color: a folder's own / a note's parent-folder color. */
  accent: AccentName;
  /** Resolved hex color for the leading folder swatch. When null, the row
   *  falls back to the `accent` palette dot. */
  colorHex: string | null;
  /** Vault-relative path; used for active-row matching. */
  path: string;
  /** Click target href. `undefined` when unavailable — the row renders as
   *  a non-link static element. */
  href: string | undefined;
  /** When `false`, the row renders dimmed and non-clickable. */
  available: boolean;
}

export interface LocalVaultAction {
  kind: "vault";
  /**
   * `new-vault` creates a brand-new vault and is vault-list-level, so it
   * carries no `vaultId`. Every other action targets an existing vault
   * group and stamps that group's `vaultId` so the host knows which vault
   * the menu acted on (the rail now lists more than one).
   */
  action:
    | "new-note"
    | "new-folder"
    | "customize"
    | "rename"
    | "delete"
    | "new-vault";
  /** The vault the action targets. Absent for `new-vault`. */
  vaultId?: string;
}

export type LocalTreeAction =
  | LocalFileAction
  | LocalFolderAction
  | LocalVaultAction;
