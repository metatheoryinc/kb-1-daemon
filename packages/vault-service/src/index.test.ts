import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { DocumentSessionManager } from "@kb-2/doc-session";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createVaultService,
  type ServiceResult,
  type VaultChangeEvent,
} from "./index.js";

const CORAL = "#fda4af";
const MINT = "#a7f3d0";

describe("vault service failure mapping", () => {
  let root: string;
  let sessions: DocumentSessionManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kb2-vault-service-"));
    sessions = new DocumentSessionManager({ root, defaultContent: "" });
  });

  it("routes cold file and folder operations through vault-core with audit rows", async () => {
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });

    await expect(service.vaultInfo()).resolves.toMatchObject({
      ok: true,
      fileCount: 0,
      folderCount: 0,
    });
    await expect(
      service.createFolder({ path: "notes", actor: { kind: "user" } }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes",
      audit: { operation: "mkdir", path: "notes" },
    });
    await expect(
      service.setFolderMetadata({
        path: "notes",
        metadata: { color: CORAL },
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes",
      metadata: { color: CORAL },
      audit: { operation: "write", entityKind: "folder", path: "notes" },
    });
    await expect(
      service.getFolderMetadata({ path: "notes" }),
    ).resolves.toMatchObject({
      ok: true,
      metadata: { color: CORAL },
    });
    await expect(service.listFolderMetadata()).resolves.toMatchObject({
      ok: true,
      folders: { notes: { color: CORAL } },
    });
    await expect(
      service.createNote({
        path: "notes/a.md",
        content: "alpha beta\n",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/a.md",
      audit: { operation: "create", path: "notes/a.md" },
    });
    await expect(
      service.readNote({ path: "notes/a.md" }),
    ).resolves.toMatchObject({
      ok: true,
      content: "alpha beta\n",
    });
    await expect(service.listFiles({ under: "notes" })).resolves.toMatchObject({
      ok: true,
      entries: [{ path: "notes/a.md", kind: "file" }],
    });
    const rootTree = await service.listFiles({});
    expect(rootTree.ok).toBe(true);
    const rootEntries = (
      rootTree as { ok: true; entries: Array<Record<string, unknown>> }
    ).entries;
    expect(rootEntries).toContainEqual(
      expect.objectContaining({
        path: "notes",
        kind: "folder",
        metadata: { color: CORAL },
      }),
    );
    await expect(service.search({ query: "beta" })).resolves.toMatchObject({
      ok: true,
      total: 1,
      results: [{ path: "notes/a.md", lineText: "alpha beta" }],
    });
    await expect(
      service.moveNote({
        fromPath: "notes/a.md",
        toPath: "notes/b.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/a.md",
      toPath: "notes/b.md",
      kind: "file",
      audit: {
        operation: "move",
        fromPath: "notes/a.md",
        toPath: "notes/b.md",
      },
    });
    await expect(readFile(join(root, "notes", "b.md"), "utf8")).resolves.toBe(
      "alpha beta\n",
    );
    await expect(
      service.deleteNote({
        path: "notes/b.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/b.md",
      permanent: false,
      audit: { operation: "delete", path: "notes/b.md" },
    });

    await writeFileWithParents(join(root, "folder", "child.md"), "child\n");
    await expect(
      service.moveFolder({
        fromPath: "folder",
        toPath: "moved-folder",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "folder",
      toPath: "moved-folder",
      kind: "folder",
      audit: { operation: "move", fromPath: "folder", toPath: "moved-folder" },
    });
    await expect(
      readFile(join(root, "moved-folder", "child.md"), "utf8"),
    ).resolves.toBe("child\n");
    await expect(
      service.deleteFolder({
        path: "moved-folder",
        recursive: true,
        permanent: true,
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "moved-folder",
      permanent: true,
      audit: { operation: "delete", path: "moved-folder" },
    });

    const auditRows = await readAuditRows(root);
    expect(auditRows.map((row) => row.operation)).toEqual([
      "mkdir",
      "write",
      "create",
      "move",
      "delete",
      "move",
      "delete",
    ]);
  });

  it("routes live session writes and path transitions through the same audit-bearing response shape", async () => {
    await writeFileWithParents(join(root, "notes", "live.md"), "alpha\n");
    await writeFileWithParents(join(root, "tree", "child.md"), "child\n");
    sessions = new DocumentSessionManager({ root, defaultContent: "" });
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });

    await expect(
      service.readNote({ path: "notes/live.md" }),
    ).resolves.toMatchObject({
      ok: true,
      content: "alpha\n",
      baseline: expect.any(String),
    });
    await expect(
      service.appendNote({
        path: "notes/live.md",
        content: "beta\n",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/live.md",
      content: "alpha\nbeta\n",
      audit: { operation: "append", path: "notes/live.md" },
    });
    const prepended = await service.prependNote({
      path: "notes/live.md",
      content: "start\n",
      actor: { kind: "user" },
    });
    expect(prepended).toMatchObject({
      ok: true,
      path: "notes/live.md",
      content: "start\nalpha\nbeta\n",
      audit: { operation: "prepend", path: "notes/live.md" },
    });
    expect(requireBaseline(prepended).length).toBeGreaterThan(0);
    await expect(
      readFile(join(root, "notes", "live.md"), "utf8"),
    ).resolves.toBe("start\nalpha\nbeta\n");

    await sessions.getSession("notes/live.md").open();
    await expect(
      service.moveNote({
        fromPath: "notes/live.md",
        toPath: "notes/moved.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/live.md",
      toPath: "notes/moved.md",
      kind: "file",
      live: true,
      audit: {
        operation: "move",
        fromPath: "notes/live.md",
        toPath: "notes/moved.md",
      },
    });
    await expect(
      readFile(join(root, "notes", "moved.md"), "utf8"),
    ).resolves.toBe("start\nalpha\nbeta\n");
    await expect(
      service.deleteNote({
        path: "notes/moved.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/moved.md",
      live: true,
      audit: { operation: "delete", path: "notes/moved.md" },
    });

    await sessions.getSession("tree/child.md").open();
    await expect(
      service.moveFolder({
        fromPath: "tree",
        toPath: "renamed-tree",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "tree",
      toPath: "renamed-tree",
      kind: "folder",
      liveMoved: ["renamed-tree/child.md"],
      audit: { operation: "move", fromPath: "tree", toPath: "renamed-tree" },
    });
    await expect(
      service.deleteFolder({
        path: "renamed-tree",
        recursive: true,
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "renamed-tree",
      liveDeleted: ["renamed-tree/child.md"],
      audit: { operation: "delete", path: "renamed-tree" },
    });

    const trashFiles = await readdir(join(root, ".kb2", "trash"));
    expect(trashFiles.length).toBeGreaterThanOrEqual(2);
    const auditRows = await readAuditRows(root);
    expect(auditRows.map((row) => row.operation)).toEqual([
      "append",
      "prepend",
      "move",
      "delete",
      "move",
      "delete",
    ]);
  });

  it("flushes dirty sessions and emits normalized change events without content bytes", async () => {
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    const events: VaultChangeEvent[] = [];
    service.onEvent((event) => events.push(event));

    await expect(
      service.createFolder({ path: "notes", actor: { kind: "user" } }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes",
    });
    await expect(
      service.createNote({
        path: "notes/a.md",
        content: "initial\n",
        actor: { kind: "integration", client: "test" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/a.md",
    });
    await expect(
      service.createNote({
        path: "notes/a.md",
        content: "overwritten\n",
        overwrite: true,
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/a.md",
    });
    await expect(
      service.setFolderMetadata({
        path: "notes",
        metadata: { color: MINT },
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes",
    });

    const session = sessions.getSession("notes/a.md");
    await session.open();
    await expect(
      service.createNote({
        path: "notes/a.md",
        content: "live overwrite\n",
        overwrite: true,
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/a.md",
      live: true,
    });
    session.ydoc
      .getText("markdown")
      .insert(session.ydoc.getText("markdown").length, "SECRET_SERVICE_EVENT");
    await expect(service.flushDirtySessions()).resolves.toMatchObject({
      ok: true,
      flushed: 1,
      durableAsOf: expect.any(String),
    });
    await expect(readFile(join(root, "notes", "a.md"), "utf8")).resolves.toBe(
      "live overwrite\nSECRET_SERVICE_EVENT",
    );

    await expect(
      service.moveNote({
        fromPath: "notes/a.md",
        toPath: "notes/moved.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/a.md",
      toPath: "notes/moved.md",
    });
    await expect(
      service.deleteNote({
        path: "notes/moved.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/moved.md",
    });

    expect(events.map((event) => event.kind)).toEqual([
      "folder_created",
      "file_created",
      "content_persisted",
      "folder_metadata_changed",
      "content_persisted",
      "content_persisted",
      "file_moved",
      "file_deleted",
    ]);
    expect(events[1]).toMatchObject({
      path: "notes/a.md",
      actor: { kind: "integration", client: "test" },
    });
    expect(events[2]).toMatchObject({
      path: "notes/a.md",
      actor: { kind: "user" },
    });
    expect(events[4]).toMatchObject({
      path: "notes/a.md",
      actor: { kind: "system" },
    });
    expect(events[5]).toMatchObject({
      path: "notes/a.md",
      actor: { kind: "system" },
    });
    expect(events[6]).toMatchObject({
      path: "notes/moved.md",
      fromPath: "notes/a.md",
      toPath: "notes/moved.md",
    });
    expect(JSON.stringify(events)).not.toContain("SECRET_SERVICE_EVENT");
  });

  it("emits external change events from the document-session spine", async () => {
    sessions = new DocumentSessionManager({
      root,
      defaultContent: "",
      watchDebounceMs: 10,
      watchPollMs: 50,
    });
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    const events: VaultChangeEvent[] = [];
    service.onEvent((event) => events.push(event));
    await writeFileWithParents(join(root, "notes", "external.md"), "base\n");
    const session = sessions.getSession("notes/external.md");
    await session.open();

    await writeFile(join(root, "notes", "external.md"), "external\n", "utf8");

    await waitUntil(
      () => events.some((event) => event.kind === "external_change_detected"),
      () =>
        `Timed out waiting for external change event; events=${JSON.stringify(events)}`,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "external_change_detected",
        path: "notes/external.md",
        actor: { kind: "system" },
      }),
    );
    await expect(session.getContent()).resolves.toBe("external\n");
  });

  it("emits a root-level external event when the cold file tree changes on disk", async () => {
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    const events: VaultChangeEvent[] = [];
    const unsubscribe = service.onEvent((event) => events.push(event));

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await writeFileWithParents(
      join(root, "external-tree", "added.md"),
      "added\n",
    );

    await waitUntil(
      () =>
        events.some(
          (event) =>
            event.kind === "external_change_detected" && event.path === "",
        ),
      () =>
        `Timed out waiting for external tree event; events=${JSON.stringify(events)}`,
    );
    unsubscribe();
  });

  it("uses cold disk paths for file move and delete when no session is open", async () => {
    await writeFileWithParents(join(root, "cold", "move.md"), "move\n");
    await writeFileWithParents(join(root, "cold", "delete.md"), "delete\n");
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });

    await expect(
      service.moveNote({
        fromPath: "cold/move.md",
        toPath: "cold/moved.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "cold/move.md",
      toPath: "cold/moved.md",
      kind: "file",
      audit: {
        operation: "move",
        fromPath: "cold/move.md",
        toPath: "cold/moved.md",
      },
    });
    await expect(
      readFile(join(root, "cold", "moved.md"), "utf8"),
    ).resolves.toBe("move\n");

    await expect(
      service.deleteNote({
        path: "cold/delete.md",
        permanent: true,
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "cold/delete.md",
      permanent: true,
      audit: { operation: "delete", path: "cold/delete.md" },
    });
    await expect(
      readFile(join(root, "cold", "delete.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps live baseline edit rejections into the canonical failure dialect", async () => {
    await writeFileWithParents(
      join(root, "notes", "edit.md"),
      "alpha beta alpha\n",
    );
    sessions = new DocumentSessionManager({ root, defaultContent: "" });
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    const read = await service.readNote({ path: "notes/edit.md" });
    const baseline = requireBaseline(read);

    await expect(
      service.editNote({
        path: "notes/edit.md",
        baseline: "stale",
        oldText: "beta",
        newText: "BETA",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "stale_doc",
      current_content: "alpha beta alpha\n",
      baseline: expect.any(String),
    });
    await expect(
      service.editNote({
        path: "notes/edit.md",
        baseline,
        oldText: "alpha",
        newText: "ALPHA",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "ambiguous",
      match_count: 2,
    });
    await expect(
      service.editNote({
        path: "notes/edit.md",
        baseline,
        oldText: "missing",
        newText: "x",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
    await expect(
      service.editNote({
        path: "notes/edit.md",
        baseline,
        oldText: "beta",
        newText: "BETA",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "notes/edit.md",
      content: "alpha BETA alpha\n",
      audit: { operation: "splice", path: "notes/edit.md" },
    });
    await expect(
      readFile(join(root, "notes", "edit.md"), "utf8"),
    ).resolves.toBe("alpha BETA alpha\n");
  });

  it("maps validation and splice size failures without widening codes", async () => {
    await writeFileWithParents(join(root, "notes", "limit.md"), "alpha\n");
    sessions = new DocumentSessionManager({ root, defaultContent: "" });
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    const baseline = requireBaseline(
      await service.readNote({ path: "notes/limit.md" }),
    );

    await expect(
      service.appendNote({
        path: "../escape.md",
        content: "bad",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(
      service.search({ query: "alpha", under: "../escape" }),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(
      service.editNote({
        path: "notes/limit.md",
        baseline,
        oldText: "x".repeat(64 * 1024 + 1),
        newText: "replacement",
        actor: { kind: "user" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: "too_large_splice",
      message: "splice text exceeds the byte limit",
      limit_bytes: 64 * 1024,
    });
    await writeFileWithParents(
      join(root, "notes", "large.md"),
      `${"a".repeat(1024 * 1024 - 10)}needle\n`,
    );
    const largeBaseline = requireBaseline(
      await service.readNote({ path: "notes/large.md" }),
    );
    await expect(
      service.editNote({
        path: "notes/large.md",
        baseline: largeBaseline,
        oldText: "needle",
        newText: "replacement that pushes the document over the cap",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "too_large_document",
      message: "document would exceed the byte limit",
      limit_bytes: 1024 * 1024,
    });
  });

  afterEach(async () => {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  });

  it("maps live-session persist failures without writing a success audit row", async () => {
    await writeFileWithParents(join(root, "notes", "readonly.md"), "base\n");
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });

    await service.readNote({ path: "notes/readonly.md" });
    const notesDir = join(root, "notes");
    await chmod(notesDir, 0o500);
    const failed = await service.appendNote({
      path: "notes/readonly.md",
      content: "unsaved\n",
      actor: { kind: "user" },
    });

    expect(failed).toEqual({
      ok: false,
      error: "persist_failed",
      message: "Document edit could not be durably saved to disk.",
    });
    await expect(
      readFile(join(root, "notes/readonly.md"), "utf8"),
    ).resolves.toBe("base\n");
    await expect(
      stat(join(root, ".kb2/audit/changes.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await chmod(notesDir, 0o700);
    await expect(
      service.appendNote({
        path: "notes/readonly.md",
        content: "recovered\n",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      content: "base\nunsaved\nrecovered\n",
    });
  });

  it("re-drives a failed flush after disk permissions recover", async () => {
    await writeFileWithParents(join(root, "notes", "retry.md"), "base\n");
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    const events: VaultChangeEvent[] = [];
    service.onEvent((event) => events.push(event));

    await service.readNote({ path: "notes/retry.md" });
    const session = sessions.getOpenSession("notes/retry.md");
    if (!session) throw new Error("expected live session");
    const notesDir = join(root, "notes");

    try {
      await chmod(notesDir, 0o500);
      session.ydoc
        .getText("markdown")
        .insert(session.ydoc.getText("markdown").length, "stuck edit\n");

      await expect(service.flushDirtySessions()).resolves.toEqual({
        ok: false,
        error: "persist_failed",
        message: "Document edit could not be durably saved to disk.",
      });
      await expect(
        readFile(join(root, "notes", "retry.md"), "utf8"),
      ).resolves.toBe("base\n");

      await chmod(notesDir, 0o700);
      await expect(service.flushDirtySessions()).resolves.toMatchObject({
        ok: true,
        flushed: 1,
        durableAsOf: expect.any(String),
      });

      await expect(
        readFile(join(root, "notes", "retry.md"), "utf8"),
      ).resolves.toBe("base\nstuck edit\n");
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "persist_recovered",
          path: "notes/retry.md",
          actor: { kind: "system" },
        }),
      );
    } finally {
      await chmod(notesDir, 0o700).catch(() => undefined);
    }
  });

  it("maps live move and folder subtree failures from vault operations", async () => {
    await writeFileWithParents(join(root, "notes", "live.md"), "live\n");
    await writeFileWithParents(join(root, "notes", "target.md"), "target\n");
    await writeFileWithParents(join(root, "folder", "child.md"), "child\n");
    await writeFileWithParents(
      join(root, "existing", "child.md"),
      "existing\n",
    );
    sessions = new DocumentSessionManager({ root, defaultContent: "" });
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    await sessions.getSession("notes/live.md").open();

    await expect(
      service.moveNote({
        fromPath: "notes/live.md",
        toPath: "notes/target.md",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "path_collision",
    });

    await expect(
      service.moveFolder({
        fromPath: "folder",
        toPath: "existing",
        actor: { kind: "user" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "path_collision",
    });
  });
});

async function writeFileWithParents(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function readAuditRows(
  root: string,
): Promise<Array<{ operation: string }>> {
  const content = await readFile(
    join(root, ".kb2", "audit", "changes.jsonl"),
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { operation: string });
}

function requireBaseline(result: ServiceResult): string {
  if (!result.ok) {
    throw new Error(`Expected successful result, got ${result.error}`);
  }
  const value = result as { baseline?: unknown };
  if (typeof value.baseline !== "string") {
    throw new Error("Expected result to include a live document baseline");
  }
  return value.baseline;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errorMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage());
}
