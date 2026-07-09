import { describe, expect, it } from "vitest";
import {
  parseLocalTreeDragSource,
  resolveLocalTreeDrop,
  serializeLocalTreeDragSource,
  type LocalTreeDragSource,
} from "./tree-drag-drop";

const fileSource: LocalTreeDragSource = {
  kind: "file",
  vaultId: "demo-vault",
  path: "projects/active/launch.md",
};

const folderSource: LocalTreeDragSource = {
  kind: "folder",
  vaultId: "demo-vault",
  path: "projects/active",
};

describe("local tree drag/drop move guards", () => {
  it("moves a file inside a same-vault folder", () => {
    expect(
      resolveLocalTreeDrop(fileSource, {
        kind: "folder",
        vaultId: "demo-vault",
        path: "archive",
      }),
    ).toEqual({
      valid: true,
      move: {
        source: fileSource,
        target: {
          kind: "folder",
          vaultId: "demo-vault",
          path: "archive",
        },
        destinationFolderPath: "archive",
        targetPath: "archive/launch.md",
      },
    });
  });

  it("supports explicit moves to the vault root", () => {
    expect(
      resolveLocalTreeDrop(fileSource, {
        kind: "vault",
        vaultId: "demo-vault",
        path: "",
      }),
    ).toEqual({
      valid: true,
      move: {
        source: fileSource,
        target: {
          kind: "vault",
          vaultId: "demo-vault",
          path: "",
        },
        destinationFolderPath: "",
        targetPath: "launch.md",
      },
    });
  });

  it("rejects folder drops onto itself or descendants", () => {
    expect(
      resolveLocalTreeDrop(folderSource, {
        kind: "folder",
        vaultId: "demo-vault",
        path: "projects/active",
      }),
    ).toEqual({ valid: false, reason: "self" });

    expect(
      resolveLocalTreeDrop(folderSource, {
        kind: "folder",
        vaultId: "demo-vault",
        path: "projects/active/research",
      }),
    ).toEqual({ valid: false, reason: "descendant" });
  });

  it("rejects cross-vault and same-location no-op drops", () => {
    expect(
      resolveLocalTreeDrop(fileSource, {
        kind: "folder",
        vaultId: "other-vault",
        path: "archive",
      }),
    ).toEqual({ valid: false, reason: "cross-vault" });

    expect(
      resolveLocalTreeDrop(fileSource, {
        kind: "folder",
        vaultId: "demo-vault",
        path: "projects/active",
      }),
    ).toEqual({ valid: false, reason: "same-location" });

    expect(
      resolveLocalTreeDrop(
        {
          kind: "file",
          vaultId: "demo-vault",
          path: "root-note.md",
        },
        {
          kind: "vault",
          vaultId: "demo-vault",
          path: "",
        },
      ),
    ).toEqual({ valid: false, reason: "same-location" });
  });

  it("round-trips only valid drag source payloads", () => {
    expect(parseLocalTreeDragSource(serializeLocalTreeDragSource(fileSource))).toEqual(fileSource);
    expect(parseLocalTreeDragSource(null)).toBeNull();
    expect(parseLocalTreeDragSource("{")).toBeNull();
    expect(parseLocalTreeDragSource(JSON.stringify({ kind: "vault", vaultId: "demo", path: "" }))).toBeNull();
  });
});
