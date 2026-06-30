import type {
  LocalFolderMetadata,
  LocalFolderNode,
  LocalTreeNode,
} from "./types";

export const ROOT_DEFAULT_COLOR = "#cbd5e1";

export interface FolderPresentation {
  color: string;
}

export type FolderPresentationResolver = (
  folderPath: string,
) => FolderPresentation;

export function parentFolderPath(folderPath: string): string {
  const index = folderPath.lastIndexOf("/");
  return index === -1 ? "" : folderPath.slice(0, index);
}

export function resolveFolderColor(
  metadata: LocalFolderMetadata | null | undefined,
  inheritedColor = ROOT_DEFAULT_COLOR,
): string {
  const color = metadata?.color;
  return color && color !== "inherit" ? color : inheritedColor;
}

export function createFolderPresentationResolver(
  tree: readonly LocalTreeNode[] = [],
  rootColor = ROOT_DEFAULT_COLOR,
): FolderPresentationResolver {
  const folders = new Map<string, LocalFolderNode>();

  function visit(nodes: readonly LocalTreeNode[]): void {
    for (const node of nodes) {
      if (node.kind !== "folder") continue;
      folders.set(node.path, node);
      visit(node.children);
    }
  }

  visit(tree);

  function resolveColor(folderPath: string): string {
    if (folderPath === "") return rootColor;
    let inheritedColor = rootColor;
    const parts = folderPath.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      inheritedColor = resolveFolderColor(
        folders.get(path)?.metadata,
        inheritedColor,
      );
    }
    return inheritedColor;
  }

  return (folderPath: string) => ({ color: resolveColor(folderPath) });
}

export function resolveNoteParentPresentation(
  resolveFolderPresentation: FolderPresentationResolver,
  notePath: string,
): FolderPresentation {
  return resolveFolderPresentation(parentFolderPath(notePath));
}
