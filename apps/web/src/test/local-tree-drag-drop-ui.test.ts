import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesPanel, type LocalTreeMoveDrop, type LocalTreeNode } from "@kb-1/ui";

afterEach(() => {
  cleanup();
});

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    get types() {
      return Array.from(values.keys());
    },
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
    clearData(type?: string) {
      if (type) values.delete(type);
      else values.clear();
    },
  } as unknown as DataTransfer;
}

function folder(path: string, children: LocalTreeNode[] = []): LocalTreeNode {
  return {
    kind: "folder",
    path,
    name: path.split("/").at(-1) ?? path,
    children,
  };
}

function file(path: string): LocalTreeNode {
  return {
    kind: "file",
    path,
    name: path.split("/").at(-1) ?? path,
  };
}

function renderPanel(
  tree: LocalTreeNode[],
  onTreeMoveDrop: (move: LocalTreeMoveDrop) => void,
) {
  return render(FilesPanel, {
    vaultName: "Demo vault",
    vaultId: "demo-vault",
    tree,
    expandedFolderIds: new Set([
      "folder:demo-vault:dnd-target",
      "folder:demo-vault:dnd-parent",
    ]),
    onTreeMoveDrop,
  });
}

describe("FilesPanel tree drag/drop moves", () => {
  it("emits a file move when a file is dropped on a same-vault folder", async () => {
    const onTreeMoveDrop = vi.fn();
    renderPanel([folder("dnd-target"), file("dnd-file.md")], onTreeMoveDrop);
    const transfer = dataTransfer();

    await fireEvent.dragStart(screen.getByRole("button", { name: "dnd-file.md" }), {
      dataTransfer: transfer,
    });
    await fireEvent.dragOver(screen.getByText("dnd-target"), {
      dataTransfer: transfer,
    });
    await fireEvent.drop(screen.getByText("dnd-target"), {
      dataTransfer: transfer,
    });

    expect(onTreeMoveDrop).toHaveBeenCalledWith({
      source: {
        kind: "file",
        vaultId: "demo-vault",
        path: "dnd-file.md",
      },
      target: {
        kind: "folder",
        vaultId: "demo-vault",
        path: "dnd-target",
      },
      destinationFolderPath: "dnd-target",
      targetPath: "dnd-target/dnd-file.md",
    });
  });

  it("emits a folder move when a folder is dropped on a same-vault folder", async () => {
    const onTreeMoveDrop = vi.fn();
    renderPanel([folder("dnd-folder-dest"), folder("dnd-folder-source")], onTreeMoveDrop);
    const transfer = dataTransfer();

    await fireEvent.dragStart(screen.getByText("dnd-folder-source"), {
      dataTransfer: transfer,
    });
    await fireEvent.dragOver(screen.getByText("dnd-folder-dest"), {
      dataTransfer: transfer,
    });
    await fireEvent.drop(screen.getByText("dnd-folder-dest"), {
      dataTransfer: transfer,
    });

    expect(onTreeMoveDrop).toHaveBeenCalledWith({
      source: {
        kind: "folder",
        vaultId: "demo-vault",
        path: "dnd-folder-source",
      },
      target: {
        kind: "folder",
        vaultId: "demo-vault",
        path: "dnd-folder-dest",
      },
      destinationFolderPath: "dnd-folder-dest",
      targetPath: "dnd-folder-dest/dnd-folder-source",
    });
  });

  it("emits a root move when an item is dropped on the vault row", async () => {
    const onTreeMoveDrop = vi.fn();
    renderPanel([folder("dnd-target", [file("dnd-target/dnd-file.md")])], onTreeMoveDrop);
    const transfer = dataTransfer();

    await fireEvent.dragStart(screen.getByRole("button", { name: "dnd-file.md" }), {
      dataTransfer: transfer,
    });
    await fireEvent.dragOver(screen.getByTestId("vault-row"), {
      dataTransfer: transfer,
    });
    await fireEvent.drop(screen.getByTestId("vault-row"), {
      dataTransfer: transfer,
    });

    expect(onTreeMoveDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationFolderPath: "",
        targetPath: "dnd-file.md",
      }),
    );
  });

  it("rejects dropping a folder into its descendant", async () => {
    const onTreeMoveDrop = vi.fn();
    renderPanel([folder("dnd-parent", [folder("dnd-parent/child")])], onTreeMoveDrop);
    const transfer = dataTransfer();

    await fireEvent.dragStart(screen.getByText("dnd-parent"), {
      dataTransfer: transfer,
    });
    await fireEvent.dragOver(screen.getByText("child"), {
      dataTransfer: transfer,
    });
    await fireEvent.drop(screen.getByText("child"), {
      dataTransfer: transfer,
    });

    expect(transfer.dropEffect).toBe("none");
    expect(onTreeMoveDrop).not.toHaveBeenCalled();
  });

  it("cancels a tree drag when dropped on the panel outside a target", async () => {
    const onTreeMoveDrop = vi.fn();
    const { container } = renderPanel([folder("dnd-target"), file("dnd-file.md")], onTreeMoveDrop);
    const transfer = dataTransfer();
    const panel = container.querySelector(".files-panel");
    expect(panel).not.toBeNull();

    await fireEvent.dragStart(screen.getByRole("button", { name: "dnd-file.md" }), {
      dataTransfer: transfer,
    });
    await fireEvent.drop(panel as Element, {
      dataTransfer: transfer,
    });

    expect(onTreeMoveDrop).not.toHaveBeenCalled();
  });
});
