import { describe, expect, it } from "vitest";
import type { LocalTreeNode } from "./types";
import {
  ROOT_DEFAULT_COLOR,
  createFolderPresentationResolver,
  resolveNoteParentPresentation,
} from "./folder-presentation";

const tree: LocalTreeNode[] = [
  {
    kind: "folder",
    path: "projects",
    name: "projects",
    metadata: { color: "#a7f3d0" },
    children: [
      {
        kind: "folder",
        path: "projects/active",
        name: "active",
        children: [
          {
            kind: "folder",
            path: "projects/active/research",
            name: "research",
            metadata: { color: "inherit" },
            children: [
              {
                kind: "file",
                path: "projects/active/research/note.md",
                name: "note.md",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    kind: "folder",
    path: "archive",
    name: "archive",
    metadata: { color: "#fda4af" },
    children: [],
  },
];

describe("folder presentation resolver", () => {
  it("inherits color through ancestors", () => {
    const resolve = createFolderPresentationResolver(tree);

    expect(resolve("")).toEqual({ color: ROOT_DEFAULT_COLOR });
    expect(resolve("projects")).toEqual({ color: "#a7f3d0" });
    expect(resolve("projects/active")).toEqual({ color: "#a7f3d0" });
    expect(resolve("projects/active/research")).toEqual({ color: "#a7f3d0" });
    expect(resolve("archive")).toEqual({ color: "#fda4af" });
  });

  it("resolves note colors from their parent folder", () => {
    const resolve = createFolderPresentationResolver(tree);

    expect(
      resolveNoteParentPresentation(
        resolve,
        "projects/active/research/note.md",
      ),
    ).toEqual({
      color: "#a7f3d0",
    });
    expect(resolveNoteParentPresentation(resolve, "root.md")).toEqual({
      color: ROOT_DEFAULT_COLOR,
    });
  });

  it("uses an explicit root color as the inherited vault color", () => {
    const resolve = createFolderPresentationResolver(tree, "#ddd6fe");

    expect(resolve("")).toEqual({ color: "#ddd6fe" });
    expect(resolve("projects/active")).toEqual({ color: "#a7f3d0" });
    expect(resolveNoteParentPresentation(resolve, "root.md")).toEqual({
      color: "#ddd6fe",
    });
  });
});
