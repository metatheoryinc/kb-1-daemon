export const LOCAL_TREE_DRAG_MIME = "application/x-kb1-tree-node";

export interface LocalTreeDragSource {
  kind: "file" | "folder";
  vaultId: string;
  path: string;
}

export interface LocalTreeDropTarget {
  kind: "vault" | "folder";
  vaultId: string;
  path: string;
}

export interface LocalTreeMoveDrop {
  source: LocalTreeDragSource;
  target: LocalTreeDropTarget;
  destinationFolderPath: string;
  targetPath: string;
}

export type LocalTreeDropRejectionReason =
  | "cross-vault"
  | "self"
  | "descendant"
  | "same-location";

export type LocalTreeDropResolution =
  | { valid: true; move: LocalTreeMoveDrop }
  | { valid: false; reason: LocalTreeDropRejectionReason };

export function serializeLocalTreeDragSource(source: LocalTreeDragSource): string {
  return JSON.stringify(source);
}

export function parseLocalTreeDragSource(value: string | null): LocalTreeDragSource | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LocalTreeDragSource>;
    if (
      (parsed.kind === "file" || parsed.kind === "folder") &&
      typeof parsed.vaultId === "string" &&
      typeof parsed.path === "string" &&
      parsed.path.length > 0
    ) {
      return {
        kind: parsed.kind,
        vaultId: parsed.vaultId,
        path: parsed.path,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function parentTreePath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function leafTreeName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function joinTreePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function resolveLocalTreeDrop(
  source: LocalTreeDragSource,
  target: LocalTreeDropTarget,
): LocalTreeDropResolution {
  if (source.vaultId !== target.vaultId) {
    return { valid: false, reason: "cross-vault" };
  }

  const destinationFolderPath = target.path;
  if (source.kind === "folder") {
    if (destinationFolderPath === source.path) {
      return { valid: false, reason: "self" };
    }
    if (destinationFolderPath.startsWith(`${source.path}/`)) {
      return { valid: false, reason: "descendant" };
    }
  }

  if (parentTreePath(source.path) === destinationFolderPath) {
    return { valid: false, reason: "same-location" };
  }

  return {
    valid: true,
    move: {
      source,
      target,
      destinationFolderPath,
      targetPath: joinTreePath(destinationFolderPath, leafTreeName(source.path)),
    },
  };
}
