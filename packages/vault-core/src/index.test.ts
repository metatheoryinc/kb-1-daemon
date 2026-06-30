import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { parse as parseYaml } from "yaml";

import {
  DOCUMENT_BYTES_LIMIT,
  SPLICE_BYTES_LIMIT,
  appendContent,
  applyAnchoredSplice,
  lfNormalize,
  prependContent,
} from "./splice.js";
import {
  deleteVaultFile,
  deleteVaultFolder,
  getFolderMetadata,
  getVaultInfo,
  listFolderMetadata,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  readVaultFile,
  setFolderMetadata,
  writeVaultFile,
  type VaultContext,
} from "./vault-ops.js";
import { onVaultAudit } from "./audit.js";
import {
  historyOperationFromAudit,
  listFileHistory,
  recordFileHistory,
} from "./file-history.js";
import { searchVaultFiles } from "./search.js";
import { validateVaultPath } from "./path.js";
import { anchoredSpliceContractCases } from "./splice-contract-cases.test-support.js";

const CORAL = "#fda4af";
const MINT = "#a7f3d0";
const SKY = "#bae6fd";
const ROSE = "#fecdd3";
const SAGE = "#d9f99d";

describe("vault path validation", () => {
  const validSegment = fc
    .stringMatching(/^[A-Za-z0-9_-]{1,24}$/)
    .filter(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        segment !== ".kb2" &&
        !segment.includes("/") &&
        !segment.includes("\\"),
    );
  const validFileName = fc
    .tuple(validSegment, validSegment)
    .map(([name, ext]) => `${name}.${ext}`);
  const validFolderPath = fc
    .array(validSegment, { minLength: 1, maxLength: 5 })
    .map((segments) => segments.join("/"));
  const validFilePath = fc
    .tuple(
      fc.array(validSegment, { minLength: 0, maxLength: 4 }),
      validFileName,
    )
    .map(([parents, file]) => [...parents, file].join("/"));

  it.each([
    ["", "file"],
    ["/absolute.md", "file"],
    ["nested//file.md", "file"],
    ["nested/", "folder"],
    [".", "folder"],
    ["..", "folder"],
    ["nested/../file.md", "file"],
    ["nested\\.md", "file"],
    ["folder/no-extension", "file"],
    ["folder/.hidden", "file"],
    ["folder/trailing.", "file"],
    [".kb2/audit.md", "file"],
    [`${"a".repeat(256)}.md`, "file"],
    [`${"a".repeat(1025)}.md`, "file"],
  ] as const)("rejects invalid %s as %s", (input, kind) => {
    expect(() => validateVaultPath(input, kind)).toThrow();
  });

  it.each([
    ["note.md", "file"],
    ["nested/note.md", "file"],
    ["nested/deep", "folder"],
  ] as const)("accepts %s as %s", (input, kind) => {
    expect(validateVaultPath(input, kind)).toBe(input);
  });

  it("rejects non-string input", () => {
    expect(() => validateVaultPath(123 as unknown as string, "file")).toThrow(
      "path must be a string",
    );
  });

  it("property: valid file paths validate idempotently and resolve inside the vault root", () => {
    fc.assert(
      fc.property(validFilePath, (candidate) => {
        const validated = validateVaultPath(candidate, "file");
        expect(validateVaultPath(validated, "file")).toBe(validated);
        expect(
          path
            .resolve("/tmp/kb2-property-vault", validated)
            .startsWith("/tmp/kb2-property-vault/"),
        ).toBe(true);
      }),
    );
  });

  it("property: valid folder paths validate idempotently and resolve inside the vault root", () => {
    fc.assert(
      fc.property(validFolderPath, (candidate) => {
        const validated = validateVaultPath(candidate, "folder");
        expect(validateVaultPath(validated, "folder")).toBe(validated);
        expect(
          path
            .resolve("/tmp/kb2-property-vault", validated)
            .startsWith("/tmp/kb2-property-vault/"),
        ).toBe(true);
      }),
    );
  });

  it("property: generated traversal, absolute, and empty-segment inputs never validate", () => {
    const invalidPath = fc.oneof(
      validFilePath.map((candidate) => `/${candidate}`),
      validFilePath.map((candidate) => `${candidate}/..`),
      validFilePath.map((candidate) => `../${candidate}`),
      validFilePath
        .map((candidate) => candidate.replace("/", "//"))
        .filter((candidate) => candidate.includes("//")),
      fc
        .tuple(validSegment, validFileName)
        .map(([segment, file]) => `${segment}//${file}`),
      fc
        .tuple(validSegment, validFileName)
        .map(([segment, file]) => `${segment}/./${file}`),
      fc
        .tuple(validSegment, validFileName)
        .map(([segment, file]) => `${segment}/../${file}`),
    );

    fc.assert(
      fc.property(invalidPath, (candidate) => {
        expect(() => validateVaultPath(candidate, "file")).toThrow();
      }),
    );
  });
});

describe("vault-core filesystem operations", () => {
  let root: string;
  let ctx: VaultContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kb2-vault-core-"));
    ctx = { root, actor: { kind: "user", client: "vitest" } };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates, reads, refuses no-clobber writes, overwrites, and audits", async () => {
    const created = await writeVaultFile(ctx, {
      path: "notes/a.md",
      content: "first",
    });
    expect(created.ok).toBe(true);

    const duplicate = await writeVaultFile(ctx, {
      path: "notes/a.md",
      content: "second",
    });
    expect(duplicate).toMatchObject({ ok: false, error: "already_exists" });

    const overwritten = await writeVaultFile(ctx, {
      path: "notes/a.md",
      content: "second",
      overwrite: true,
    });
    expect(overwritten.ok).toBe(true);

    const read = await readVaultFile(ctx, "notes/a.md");
    expect(read).toMatchObject({
      ok: true,
      value: { path: "notes/a.md", content: "second" },
    });

    const auditLines = await readAuditLines(root);
    expect(auditLines).toHaveLength(2);
    expect(auditLines[0]).toMatchObject({
      actor: { kind: "user", client: "vitest" },
      operation: "create",
      entityKind: "file",
      path: "notes/a.md",
    });
    expect(auditLines[1]).toMatchObject({
      operation: "write",
      path: "notes/a.md",
    });
  });

  it("persists per-file history with actor integration coalescing and newest-first paging", async () => {
    const actor = {
      kind: "user" as const,
      id: "user-1",
      name: "Ada Lovelace",
      client: "cloud-web",
    };
    const otherClient = { ...actor, client: "agent-client" };
    const otherActor = {
      kind: "integration" as const,
      id: "user-1",
      name: "Ada Bot",
      client: "cloud-web",
    };

    await expect(
      recordFileHistory(root, {
        path: "notes/history.md",
        operation: "create",
        actor,
        content: "first",
        now: new Date("2026-06-30T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { operation: "create", actor, content: "first" },
    });
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor,
      content: "second",
      now: new Date("2026-06-30T00:01:00.000Z"),
    });
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor: otherClient,
      content: "third",
      now: new Date("2026-06-30T00:02:00.000Z"),
    });
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor: otherActor,
      content: "fourth",
      now: new Date("2026-06-30T00:03:00.000Z"),
    });
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor: otherActor,
      content: "fifth",
      now: new Date("2026-06-30T00:10:00.000Z"),
    });

    const firstPage = await listFileHistory(root, {
      path: "notes/history.md",
      limit: 2,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      value: {
        hasMore: true,
        entries: [
          { content: "fifth", actor: otherActor },
          { content: "fourth", actor: otherActor },
        ],
      },
    });
    if (!firstPage.ok) throw new Error("expected history page");
    const cursor = firstPage.value.entries.at(-1);
    if (!cursor) throw new Error("expected cursor entry");
    await expect(
      listFileHistory(root, {
        path: "notes/history.md",
        before: cursor.createdAt,
        beforeId: cursor.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        hasMore: false,
        entries: [
          { content: "third", actor: otherClient },
          { operation: "create", content: "second", actor },
        ],
      },
    });

    await expect(readRawFileHistory(root)).resolves.toMatchObject({
      parsed: {
        files: {
          "notes/history.md": [
            expect.objectContaining({
              operation: "create",
              actor,
              content: "second",
            }),
            expect.objectContaining({
              operation: "update",
              actor: otherClient,
              content: "third",
            }),
            expect.objectContaining({
              operation: "update",
              actor: otherActor,
              content: "fourth",
            }),
            expect.objectContaining({
              operation: "update",
              actor: otherActor,
              content: "fifth",
            }),
          ],
        },
      },
    });

    await recordFileHistory(root, {
      path: "alpha/sorted.md",
      operation: "create",
      actor,
      content: "sorted",
      now: new Date("2026-06-30T00:20:00.000Z"),
    });
    const sortedRaw = await readRawFileHistory(root);
    expect(Object.keys((sortedRaw.parsed as { files: Record<string, unknown> }).files)).toEqual([
      "alpha/sorted.md",
      "notes/history.md",
    ]);
  });

  it("rejects invalid history inputs and malformed durable metadata", async () => {
    await expect(
      listFileHistory(root, { path: "notes/missing.md" }),
    ).resolves.toEqual({
      ok: true,
      value: { entries: [], hasMore: false },
    });
    await expect(
      recordFileHistory(root, {
        path: "../escape.md",
        operation: "create",
        content: "bad",
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(
      listFileHistory(root, { path: "../escape.md" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });

    await recordFileHistory(root, {
      path: "notes/unknown.md",
      operation: "create",
      content: "unknown",
      now: new Date("2026-06-30T01:00:00.000Z"),
      coalesceWindowMs: -1,
    });
    await expect(
      listFileHistory(root, {
        path: "notes/unknown.md",
        before: "not-a-date",
        limit: 999,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [{ actor: { kind: "unknown" }, content: "unknown" }],
      },
    });

    const validEntry = {
      id: "entry-1",
      operation: "create",
      actor: { kind: "user" },
      createdAt: "2026-06-30T01:00:00.000Z",
      updatedAt: "2026-06-30T01:00:00.000Z",
      content: "x",
      size: 1,
      contentHash: "hash",
    };
    const malformedCases: unknown[] = [
      "files: [",
      { files: [] },
      { files: { "../bad.md": [] } },
      { files: { "notes/a.md": {} } },
      { files: { "notes/a.md": ["bad"] } },
      { files: { "notes/a.md": [{ ...validEntry, id: 1 }] } },
      { files: { "notes/a.md": [{ ...validEntry, integrationId: 42 }] } },
      { files: { "notes/a.md": [{ ...validEntry, actor: { kind: "person" } }] } },
      { files: { "notes/a.md": [{ ...validEntry, actor: { kind: "user", id: 42 } }] } },
      { files: { "notes/a.md": [{ ...validEntry, actor: { kind: "user", name: 42 } }] } },
      { files: { "notes/a.md": [{ ...validEntry, actor: { kind: "user", client: 42 } }] } },
    ];

    for (const malformed of malformedCases) {
      await writeRawFileHistory(root, malformed);
      await expect(
        listFileHistory(root, { path: "notes/a.md" }),
      ).resolves.toMatchObject({
        ok: false,
        error: "metadata_parse_failed",
      });
    }

    await writeRawFileHistory(root, { files: [] });
    await expect(
      recordFileHistory(root, {
        path: "notes/a.md",
        operation: "create",
        content: "x",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });

    await writeRawFileHistory(root, {
      files: { "notes/renamed.md": [{ ...validEntry, operation: "rename" }] },
    });
    await expect(
      listFileHistory(root, { path: "notes/renamed.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ operation: "rename" }] },
    });
  });

  it("honors zero coalescing windows and cursor tie-breaks entries with equal timestamps", async () => {
    const at = new Date("2026-06-30T02:00:00.000Z");
    const actor = { kind: "user" as const, id: "same", client: "browser" };

    await recordFileHistory(root, {
      path: "notes/zero.md",
      operation: "update",
      actor,
      content: "first",
      now: at,
      coalesceWindowMs: 0,
    });
    await recordFileHistory(root, {
      path: "notes/zero.md",
      operation: "update",
      actor,
      content: "second",
      now: new Date(at.getTime() + 1),
      coalesceWindowMs: 0,
    });
    await expect(
      listFileHistory(root, { path: "notes/zero.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ content: "second" }, { content: "first" }] },
    });

    await recordFileHistory(root, {
      path: "notes/anonymous.md",
      operation: "update",
      actor: { kind: "system" },
      content: "first",
      now: at,
    });
    await recordFileHistory(root, {
      path: "notes/anonymous.md",
      operation: "update",
      actor: { kind: "system" },
      content: "second",
      now: new Date(at.getTime() + 1),
    });
    await expect(
      listFileHistory(root, { path: "notes/anonymous.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ actor: { kind: "system" }, content: "second" }] },
    });

    await recordFileHistory(root, {
      path: "notes/tie.md",
      operation: "update",
      actor: { kind: "user", id: "left" },
      content: "left",
      now: at,
    });
    await recordFileHistory(root, {
      path: "notes/tie.md",
      operation: "update",
      actor: { kind: "user", id: "right" },
      content: "right",
      now: at,
    });
    const page = await listFileHistory(root, { path: "notes/tie.md" });
    if (!page.ok) throw new Error("expected history page");
    expect(page.value.entries).toHaveLength(2);
    expect(page.value.entries[0]!.createdAt).toBe(page.value.entries[1]!.createdAt);
    await expect(
      listFileHistory(root, {
        path: "notes/tie.md",
        before: page.value.entries[0]!.createdAt,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { entries: [] },
    });
    await expect(
      listFileHistory(root, {
        path: "notes/tie.md",
        before: page.value.entries[0]!.createdAt,
        beforeId: page.value.entries[0]!.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { entries: [page.value.entries[1]] },
    });
    await expect(
      listFileHistory(root, {
        path: "notes/tie.md",
        before: "2026-06-29T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { entries: [] },
    });
  });

  it("maps file audit operations into file history operations only", () => {
    expect(historyOperationFromAudit("create")).toBe("create");
    expect(historyOperationFromAudit("write")).toBe("update");
    expect(historyOperationFromAudit("splice")).toBe("update");
    expect(historyOperationFromAudit("append")).toBe("update");
    expect(historyOperationFromAudit("prepend")).toBe("update");
    expect(historyOperationFromAudit("move")).toBe("move");
    expect(historyOperationFromAudit("mkdir")).toBeUndefined();
    expect(historyOperationFromAudit("delete")).toBeUndefined();
  });

  it("rethrows unexpected file-history.yml read errors instead of converting them to defaults", async () => {
    await mkdir(path.join(root, ".kb2", "file-history.yml"), { recursive: true });
    await expect(listFileHistory(root, { path: "notes/a.md" })).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("notifies observers from the audit chokepoint without breaking the mutation", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const observed: Array<{ operation: string; root: string }> = [];
    const unsubscribeThrowing = onVaultAudit(() => {
      throw new Error("observer failed");
    });
    const unsubscribe = onVaultAudit((audit, input) => {
      observed.push({ operation: audit.operation, root: input.root });
    });

    try {
      await expect(
        writeVaultFile(ctx, { path: "notes/a.md", content: "first" }),
      ).resolves.toMatchObject({ ok: true });
      expect(observed).toEqual([{ operation: "create", root }]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("vault audit handler failed"),
        expect.any(Error),
      );

      unsubscribe();
      unsubscribeThrowing();
      await expect(
        writeVaultFile(ctx, { path: "notes/b.md", content: "second" }),
      ).resolves.toMatchObject({ ok: true });
      expect(observed).toEqual([{ operation: "create", root }]);
    } finally {
      unsubscribe();
      unsubscribeThrowing();
      warnSpy.mockRestore();
    }
  });

  it("creates folders idempotently and lists trees excluding .kb2 trash/audit", async () => {
    await expect(makeVaultFolder(ctx, "notes")).resolves.toMatchObject({
      ok: true,
      value: { path: "notes" },
    });
    await expect(makeVaultFolder(ctx, "notes")).resolves.toMatchObject({
      ok: true,
      value: { path: "notes" },
    });
    await writeVaultFile(ctx, { path: "notes/a.md", content: "a" });
    await deleteVaultFile(ctx, { path: "notes/a.md" });

    const tree = await listVaultTree(ctx);
    expect(tree.ok).toBe(true);
    expect(
      tree.ok ? tree.value.entries.map((entry) => entry.path) : [],
    ).toEqual(["notes"]);
  });

  it("lists subtrees with depth limits and entry-cap errors", async () => {
    await writeVaultFile(ctx, { path: "notes/a.md", content: "a" });
    await writeVaultFile(ctx, { path: "notes/deep/b.md", content: "b" });

    const shallow = await listVaultTree(ctx, { under: "notes", depth: 0 });
    expect(
      shallow.ok ? shallow.value.entries.map((entry) => entry.path) : [],
    ).toEqual(["notes/a.md", "notes/deep"]);

    await expect(
      listVaultTree(ctx, { under: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: "not_found" });
    await expect(
      listVaultTree(ctx, { under: "../escape" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(listVaultTree(ctx, { entryCap: 1 })).resolves.toMatchObject({
      ok: false,
      error: "entry_cap_exceeded",
    });
    await expect(listVaultTree(ctx, { entryCap: 0 })).resolves.toMatchObject({
      ok: false,
      error: "entry_cap_exceeded",
    });
  });

  it("reports vault counts from durable files", async () => {
    await writeVaultFile(ctx, { path: "notes/a.md", content: "a" });
    await writeVaultFile(ctx, { path: "notes/deep/b.md", content: "b" });

    const info = await getVaultInfo(ctx);
    expect(info).toMatchObject({
      ok: true,
      value: {
        fileCount: 2,
        folderCount: 2,
      },
    });
  });

  it("reports an entry-cap error when vault info exceeds the service cap", async () => {
    await Promise.all(
      Array.from({ length: 5001 }, async (_value, index) => {
        await writeFile(path.join(root, `file-${index}.md`), "");
      }),
    );

    await expect(getVaultInfo(ctx)).resolves.toMatchObject({
      ok: false,
      error: "entry_cap_exceeded",
    });
  });

  it("moves files and folders with collision checks", async () => {
    await writeVaultFile(ctx, { path: "notes/a.md", content: "a" });
    await writeVaultFile(ctx, {
      path: "notes/existing.md",
      content: "existing",
    });

    await expect(
      moveVaultPath(ctx, {
        kind: "file",
        fromPath: "notes/a.md",
        toPath: "archive/a.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { fromPath: "notes/a.md", toPath: "archive/a.md", kind: "file" },
    });
    await expect(
      readFile(path.join(root, "archive/a.md"), "utf8"),
    ).resolves.toBe("a");
    await expect(stat(path.join(root, "notes/a.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      moveVaultPath(ctx, {
        kind: "file",
        fromPath: "archive/a.md",
        toPath: "notes/existing.md",
      }),
    ).resolves.toMatchObject({ ok: false, error: "path_collision" });

    await expect(
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "archive",
        toPath: "moved/archive",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { fromPath: "archive", toPath: "moved/archive", kind: "folder" },
    });
    await expect(
      readFile(path.join(root, "moved/archive/a.md"), "utf8"),
    ).resolves.toBe("a");
  });

  it("supports overwrite moves and reports invalid/not-found move errors", async () => {
    await writeVaultFile(ctx, { path: "source.md", content: "source" });
    await writeVaultFile(ctx, { path: "target.md", content: "target" });

    await expect(
      moveVaultPath(ctx, {
        kind: "file",
        fromPath: "source.md",
        toPath: "target.md",
        overwrite: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { fromPath: "source.md", toPath: "target.md" },
    });
    await expect(readFile(path.join(root, "target.md"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(
      moveVaultPath(ctx, {
        kind: "file",
        fromPath: "missing.md",
        toPath: "next.md",
      }),
    ).resolves.toMatchObject({ ok: false, error: "not_found" });
    await expect(
      moveVaultPath(ctx, {
        kind: "file",
        fromPath: "../bad.md",
        toPath: "next.md",
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });

    await makeVaultFolder(ctx, "folder");
    await expect(
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "folder",
        toPath: "folder/child",
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "folder",
        toPath: "folder",
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
  });

  it("classifies parent-file collisions without throwing", async () => {
    await writeVaultFile(ctx, { path: "parent.md", content: "file parent" });
    await writeVaultFile(ctx, { path: "source.md", content: "source" });

    await expect(makeVaultFolder(ctx, "parent.md")).resolves.toMatchObject({
      ok: false,
      error: "path_collision",
    });
    await expect(
      writeVaultFile(ctx, { path: "parent.md/child.md", content: "child" }),
    ).resolves.toMatchObject({ ok: false, error: "path_collision" });
    await expect(
      makeVaultFolder(ctx, "parent.md/child"),
    ).resolves.toMatchObject({ ok: false, error: "path_collision" });
    await expect(
      moveVaultPath(ctx, {
        kind: "file",
        fromPath: "source.md",
        toPath: "parent.md/child.md",
      }),
    ).resolves.toMatchObject({ ok: false, error: "path_collision" });
  });

  it("rethrows unexpected filesystem errors after classified collision checks", async () => {
    await chmod(root, 0o500);
    try {
      await expect(
        writeVaultFile(ctx, { path: "blocked/file.md", content: "x" }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("refuses non-recursive folder delete and trashes recursive delete with original path", async () => {
    await writeVaultFile(ctx, { path: "folder/file.md", content: "x" });

    await expect(
      deleteVaultFolder(ctx, { path: "folder" }),
    ).resolves.toMatchObject({ ok: false, error: "folder_not_empty" });

    const deleted = await deleteVaultFolder(ctx, {
      path: "folder",
      recursive: true,
    });
    expect(deleted.ok).toBe(true);
    const trashPath = deleted.ok ? deleted.value.trashPath : undefined;
    expect(trashPath).toMatch(/^\.kb2\/trash\/.+\/folder$/);
    await expect(
      readFile(path.join(root, trashPath!, "file.md"), "utf8"),
    ).resolves.toBe("x");
  });

  it("permanently deletes files when requested", async () => {
    await writeVaultFile(ctx, { path: "gone.md", content: "x" });
    await expect(
      deleteVaultFile(ctx, { path: "gone.md", permanent: true }),
    ).resolves.toMatchObject({ ok: true, value: { permanent: true } });
    await expect(stat(path.join(root, "gone.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports read/delete not found and invalid path failures", async () => {
    await expect(readVaultFile(ctx, "missing.md")).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
    await expect(readVaultFile(ctx, "../missing.md")).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(
      writeVaultFile(ctx, { path: "../bad.md", content: "x" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(makeVaultFolder(ctx, "../bad")).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(
      deleteVaultFile(ctx, { path: "missing.md" }),
    ).resolves.toMatchObject({ ok: false, error: "not_found" });
    await expect(
      deleteVaultFile(ctx, { path: "../missing.md" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(
      deleteVaultFolder(ctx, { path: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: "not_found" });
    await expect(
      deleteVaultFolder(ctx, { path: "../missing" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
  });

  it("permanently deletes folders when requested", async () => {
    await writeVaultFile(ctx, { path: "folder/file.md", content: "x" });
    await expect(
      deleteVaultFolder(ctx, {
        path: "folder",
        recursive: true,
        permanent: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { path: "folder", permanent: true },
    });
    await expect(stat(path.join(root, "folder"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("defaults audit actors to user when none is supplied", async () => {
    await writeVaultFile({ root }, { path: "default-actor.md", content: "x" });
    const audit = await readAuditLines(root);
    expect(audit[0]).toMatchObject({ actor: { kind: "user" } });
  });

  it("writes, merges, clears, lists, and hydrates folder metadata with raw folders.yml assertions", async () => {
    await makeVaultFolder(ctx, "notes");
    await writeVaultFile(ctx, { path: "notes/a.md", content: "a" });

    const colored = await setFolderMetadata(ctx, "notes", { color: CORAL });
    expect(colored).toMatchObject({
      ok: true,
      value: { path: "notes", metadata: { color: CORAL } },
    });
    await expect(getFolderMetadata(ctx, "notes")).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: CORAL } },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: { folders: { notes: { color: CORAL } } },
    });

    const recolored = await setFolderMetadata(ctx, "notes", { color: MINT });
    expect(recolored).toMatchObject({
      ok: true,
      value: { metadata: { color: MINT } },
    });
    await expect(getFolderMetadata(ctx, "notes")).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: MINT } },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: { folders: { notes: { color: MINT } } },
    });

    const tree = await listVaultTree(ctx);
    expect(tree.ok ? tree.value.entries : []).toContainEqual(
      expect.objectContaining({
        path: "notes",
        kind: "folder",
        metadata: { color: MINT },
      }),
    );

    const clearedAll = await setFolderMetadata(ctx, "notes", { color: null });
    expect(clearedAll).toMatchObject({ ok: true, value: { metadata: {} } });
    await expect(getFolderMetadata(ctx, "notes")).resolves.toMatchObject({
      ok: true,
      value: { metadata: {} },
    });
    await expect(listFolderMetadata(ctx)).resolves.toEqual({
      ok: true,
      value: { folders: {} },
    });
    const raw = await readRawFolderMetadata(root);
    expect(raw.raw).toContain("folders: {}");
    expect(raw.parsed).toEqual({ folders: {} });

    const auditLines = (await readAuditLines(root)) as Array<{
      operation: string;
      entityKind: string;
      path: string;
    }>;
    expect(auditLines.map((line) => line.operation)).toEqual([
      "mkdir",
      "create",
      "write",
      "write",
      "write",
    ]);
    expect(
      auditLines
        .slice(2)
        .every((line) => line.entityKind === "folder" && line.path === "notes"),
    ).toBe(true);
  });

  it("supports unicode folder metadata and reports not_found for missing folders", async () => {
    const folderPath = "プロジェクト/mañana";
    await makeVaultFolder(ctx, folderPath);

    await expect(
      setFolderMetadata(ctx, folderPath, { color: SKY }),
    ).resolves.toMatchObject({
      ok: true,
      value: { path: folderPath, metadata: { color: SKY } },
    });
    await expect(getFolderMetadata(ctx, folderPath)).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: SKY } },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: { folders: { [folderPath]: { color: SKY } } },
    });

    await expect(getFolderMetadata(ctx, "missing")).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
    await expect(
      setFolderMetadata(ctx, "missing", { color: SKY }),
    ).resolves.toMatchObject({ ok: false, error: "not_found" });
    await expect(getFolderMetadata(ctx, "../missing")).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(
      setFolderMetadata(ctx, "../missing", { color: SKY }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
  });

  it("normalizes color shorthand and inherit, and rejects invalid folder metadata values before writing", async () => {
    await makeVaultFolder(ctx, "notes");

    await expect(
      setFolderMetadata(ctx, "notes", { color: "#F0A" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: "#ff00aa" } },
    });
    await expect(
      setFolderMetadata(ctx, "notes", { color: "inherit" }),
    ).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: "inherit" } },
    });
    await expect(
      setFolderMetadata(ctx, "notes", { color: null }),
    ).resolves.toMatchObject({ ok: true, value: { metadata: {} } });
    await rm(path.join(root, ".kb2/folders.yml"), { force: true });

    await expect(
      setFolderMetadata(ctx, "notes", { color: 42 as unknown as string }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_metadata" });
    await expect(
      setFolderMetadata(ctx, "notes", { color: "amber" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_metadata" });
    await expect(
      stat(path.join(root, ".kb2", "folders.yml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly for malformed folders.yml instead of silently defaulting", async () => {
    await makeVaultFolder(ctx, "notes");
    await writeFileWithParents(
      path.join(root, ".kb2", "folders.yml"),
      "folders: [",
      "utf8",
    );

    await expect(listFolderMetadata(ctx)).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });
    await expect(getFolderMetadata(ctx, "notes")).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });
    await expect(
      setFolderMetadata(ctx, "notes", { color: CORAL }),
    ).resolves.toMatchObject({ ok: false, error: "metadata_parse_failed" });
    await expect(listVaultTree(ctx)).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });
    await expect(
      deleteVaultFolder(ctx, { path: "notes", permanent: true }),
    ).resolves.toMatchObject({ ok: false, error: "metadata_parse_failed" });
    await expect(
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "notes",
        toPath: "renamed",
      }),
    ).resolves.toMatchObject({ ok: false, error: "metadata_parse_failed" });
    expect((await stat(path.join(root, "notes"))).isDirectory()).toBe(true);
  });

  it.each([
    "[]",
    "folders:\n  notes: coral\n",
    "folders:\n  notes:\n    color: 42\n",
    "folders:\n  notes:\n    color: amber\n",
    "folders:\n  ../escape:\n    color: coral\n",
  ])("fails loudly for invalid folders.yml shape %#", async (content) => {
    await writeFileWithParents(
      path.join(root, ".kb2", "folders.yml"),
      content,
      "utf8",
    );
    await expect(listFolderMetadata(ctx)).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });
  });

  it("rethrows unexpected folders.yml read errors instead of converting them to defaults", async () => {
    await mkdir(path.join(root, ".kb2", "folders.yml"), { recursive: true });
    await expect(listFolderMetadata(ctx)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("propagates folder metadata through folder moves and removes it on folder delete", async () => {
    await writeVaultFile(ctx, { path: "alpha/child/deep.md", content: "deep" });
    await makeVaultFolder(ctx, "other");
    await setFolderMetadata(ctx, "alpha", { color: MINT });
    await setFolderMetadata(ctx, "alpha/child", { color: SKY });
    await setFolderMetadata(ctx, "other", { color: ROSE });

    await expect(
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "alpha",
        toPath: "renamed/alpha",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { fromPath: "alpha", toPath: "renamed/alpha" },
    });
    await expect(
      getFolderMetadata(ctx, "renamed/alpha"),
    ).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: MINT } },
    });
    await expect(
      getFolderMetadata(ctx, "renamed/alpha/child"),
    ).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: SKY } },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: {
        folders: {
          other: { color: ROSE },
          "renamed/alpha": { color: MINT },
          "renamed/alpha/child": { color: SKY },
        },
      },
    });

    await expect(
      deleteVaultFolder(ctx, {
        path: "renamed/alpha",
        recursive: true,
        permanent: true,
      }),
    ).resolves.toMatchObject({ ok: true, value: { path: "renamed/alpha" } });
    await expect(listFolderMetadata(ctx)).resolves.toEqual({
      ok: true,
      value: { folders: { other: { color: ROSE } } },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: { folders: { other: { color: ROSE } } },
    });
  });

  it("removes overwritten target subtree metadata when folder moves overwrite", async () => {
    await writeVaultFile(ctx, { path: "source/child.md", content: "source" });
    await writeVaultFile(ctx, { path: "target/old.md", content: "target" });
    await setFolderMetadata(ctx, "source", { color: SAGE });
    await setFolderMetadata(ctx, "target", { color: ROSE });

    await expect(
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "source",
        toPath: "target",
        overwrite: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { fromPath: "source", toPath: "target" },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: { folders: { target: { color: SAGE } } },
    });
  });

  it("preserves concurrent folder metadata updates across set and move interleavings", async () => {
    await writeVaultFile(ctx, { path: "moving/child.md", content: "moving" });
    await Promise.all(
      Array.from({ length: 12 }, async (_value, index) => {
        await makeVaultFolder(ctx, `projects/folder-${index}`);
      }),
    );
    await setFolderMetadata(ctx, "moving", { color: ROSE });

    const colors = [
      CORAL,
      "#fed7aa",
      "#fef08a",
      SAGE,
      MINT,
      "#bef264",
      SKY,
      "#c7d2fe",
      "#ddd6fe",
      ROSE,
      "#99f6e4",
      "#cbd5e1",
    ] as const;
    await Promise.all([
      moveVaultPath(ctx, {
        kind: "folder",
        fromPath: "moving",
        toPath: "archive/moving",
      }),
      ...colors.map((color, index) =>
        setFolderMetadata(ctx, `projects/folder-${index}`, { color }),
      ),
    ]);

    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: {
        folders: {
          "archive/moving": { color: ROSE },
          "projects/folder-0": { color: CORAL },
          "projects/folder-1": { color: "#fed7aa" },
          "projects/folder-2": { color: "#fef08a" },
          "projects/folder-3": { color: SAGE },
          "projects/folder-4": { color: MINT },
          "projects/folder-5": { color: "#bef264" },
          "projects/folder-6": { color: SKY },
          "projects/folder-7": { color: "#c7d2fe" },
          "projects/folder-8": { color: "#ddd6fe" },
          "projects/folder-9": { color: ROSE },
          "projects/folder-10": { color: "#99f6e4" },
          "projects/folder-11": { color: "#cbd5e1" },
        },
      },
    });
  });

  it("continues folder metadata mutations after queued write failures", async () => {
    await makeVaultFolder(ctx, "notes");
    await mkdir(path.join(root, ".kb2", "folders.yml"), { recursive: true });
    try {
      await expect(
        Promise.all([
          setFolderMetadata(ctx, "notes", { color: CORAL }),
          setFolderMetadata(ctx, "notes", { color: MINT }),
        ]),
      ).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      await rm(path.join(root, ".kb2", "folders.yml"), {
        recursive: true,
        force: true,
      });
    }

    await expect(
      setFolderMetadata(ctx, "notes", { color: MINT }),
    ).resolves.toMatchObject({
      ok: true,
      value: { metadata: { color: MINT } },
    });
    await expect(readRawFolderMetadata(root)).resolves.toMatchObject({
      parsed: { folders: { notes: { color: MINT } } },
    });
  });

  it("property: folder moves relocate metadata keys exactly", async () => {
    const segment = fc
      .stringMatching(/^[a-z][a-z0-9]{0,4}$/)
      .filter((value) => value !== "moved");
    const folderPath = fc
      .array(segment, { minLength: 1, maxLength: 3 })
      .map((segments) => segments.join("/"));
    const folderSet = fc.uniqueArray(folderPath, {
      minLength: 2,
      maxLength: 8,
    });

    await fc.assert(
      fc.asyncProperty(folderSet, async (folders) => {
        const propertyRoot = await mkdtemp(
          path.join(tmpdir(), "kb2-vault-core-metadata-property-"),
        );
        const propertyCtx: VaultContext = {
          root: propertyRoot,
          actor: { kind: "user", client: "property" },
        };
        try {
          const sortedFolders = [...folders].sort();
          for (const folder of sortedFolders) {
            await makeVaultFolder(propertyCtx, folder);
          }

          const initialMetadata: Record<string, { color: string }> = {};
          for (const [index, folder] of sortedFolders.entries()) {
            const color = index % 2 === 0 ? CORAL : MINT;
            initialMetadata[folder] = { color };
            await setFolderMetadata(propertyCtx, folder, { color });
          }

          const fromPath = sortedFolders[0]!;
          const toPath = `moved/${fromPath}`;
          await expect(
            moveVaultPath(propertyCtx, { kind: "folder", fromPath, toPath }),
          ).resolves.toMatchObject({ ok: true });

          const expected = expectedMovedMetadata(
            initialMetadata,
            fromPath,
            toPath,
          );
          await expect(listFolderMetadata(propertyCtx)).resolves.toEqual({
            ok: true,
            value: { folders: expected },
          });
          await expect(
            readRawFolderMetadata(propertyRoot),
          ).resolves.toMatchObject({ parsed: { folders: expected } });
        } finally {
          await rm(propertyRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 25 },
    );
  });
});

describe("anchored splice and positioned content helpers", () => {
  it.each(anchoredSpliceContractCases)(
    "satisfies shared splice contract: $name",
    ({ initialContent, request, expected }) => {
      expect(applyAnchoredSplice(initialContent, request)).toEqual(expected);
    },
  );

  it("applies exact replacements with anchors, occurrence, LF normalization, and surrogate pairs", () => {
    expect(
      applyAnchoredSplice("one two three", {
        oldText: "two",
        newText: "TWO",
      }),
    ).toEqual({ ok: true, content: "one TWO three" });

    expect(
      applyAnchoredSplice("foo bar foo baz foo", {
        oldText: "foo",
        newText: "FOO",
        occurrence: 2,
      }),
    ).toEqual({ ok: true, content: "foo bar FOO baz foo" });

    expect(
      applyAnchoredSplice("aa aa aa", {
        before: "aa ",
        oldText: "aa",
        after: " aa",
        newText: "XX",
      }),
    ).toEqual({ ok: true, content: "aa XX aa" });

    expect(
      applyAnchoredSplice("line one\nline two", {
        oldText: "one\r\nline",
        newText: "ONE\nLINE",
      }),
    ).toEqual({ ok: true, content: "line ONE\nLINE two" });

    expect(
      applyAnchoredSplice("before 😀 after", {
        oldText: "😀",
        newText: "🧪",
      }),
    ).toEqual({ ok: true, content: "before 🧪 after" });
  });

  it("rejects missing, ambiguous, out-of-range, and size-capped splices", () => {
    expect(
      applyAnchoredSplice("hello", {
        oldText: "missing",
        newText: "x",
      }),
    ).toEqual({ ok: false, rejected: "not_found" });

    expect(
      applyAnchoredSplice("hello", {
        oldText: "",
        newText: "x",
      }),
    ).toEqual({ ok: false, rejected: "not_found" });

    expect(
      applyAnchoredSplice("aaa", {
        oldText: "aa",
        newText: "b",
      }),
    ).toEqual({ ok: false, rejected: "ambiguous", match_count: 2 });

    expect(
      applyAnchoredSplice("foo foo", {
        oldText: "foo",
        newText: "bar",
        occurrence: 3,
      }),
    ).toEqual({ ok: false, rejected: "not_found" });

    expect(
      applyAnchoredSplice("x", {
        oldText: "x".repeat(SPLICE_BYTES_LIMIT + 1),
        newText: "y",
      }),
    ).toEqual({
      ok: false,
      rejected: "too_large_splice",
      limit_bytes: SPLICE_BYTES_LIMIT,
    });

    const base = `x${"a".repeat(DOCUMENT_BYTES_LIMIT - 1)}`;
    expect(
      applyAnchoredSplice(base, {
        oldText: "x",
        newText: "yy",
      }),
    ).toEqual({
      ok: false,
      rejected: "too_large_document",
      current_bytes: DOCUMENT_BYTES_LIMIT + 1,
      limit_bytes: DOCUMENT_BYTES_LIMIT,
    });
  });

  it("property: anchored splice result equals the direct string replacement for generated full-unicode documents", () => {
    const unicodeFragment = fc
      .array(
        fc.oneof(
          fc.string({ maxLength: 4 }),
          fc.constantFrom(
            "😀",
            "🧪",
            "𝌆",
            "é",
            "中",
            "\uD800",
            "\uDC00",
            "\r\n",
            "\r",
          ),
        ),
        { maxLength: 20 },
      )
      .map((parts) => parts.join(""));
    const boundary = fc.constantFrom("", "😀", "🧪", "𝌆", "\uD800", "\uDC00");

    fc.assert(
      fc.property(
        unicodeFragment,
        unicodeFragment,
        unicodeFragment,
        unicodeFragment,
        boundary,
        boundary,
        (left, oldText, right, replacement, edgeBefore, edgeAfter) => {
          const splicedText = `${edgeBefore}${oldText}${edgeAfter}`;
          fc.pre(splicedText.length > 0);
          const before = "__KB2_LEFT__";
          const after = "__KB2_RIGHT__";
          fc.pre(!left.includes(before + splicedText + after));
          fc.pre(!right.includes(before + splicedText + after));
          const source = `${left}${before}${splicedText}${after}${right}`;
          const expected = `${left}${before}${lfNormalize(replacement)}${after}${right}`;
          const result = applyAnchoredSplice(source, {
            before,
            oldText: splicedText,
            after,
            newText: replacement,
          });
          expect(result).toEqual({ ok: true, content: expected });
        },
      ),
    );
  });

  it("splices across CRLF, CR, and mixed line boundaries while preserving surrounding bytes", () => {
    expect(
      applyAnchoredSplice("alpha\r\nold\r\nomega", {
        oldText: "old\nomega",
        newText: "NEW",
      }),
    ).toEqual({ ok: true, content: "alpha\r\nNEW" });

    expect(
      applyAnchoredSplice("alpha\r\nold\r\nomega", {
        oldText: "old\r\nomega",
        newText: "NEW",
      }),
    ).toEqual({ ok: true, content: "alpha\r\nNEW" });

    expect(
      applyAnchoredSplice("a\r\nb\rc\nd", {
        oldText: "b\nc\nd",
        newText: "B",
      }),
    ).toEqual({ ok: true, content: "a\r\nB" });

    expect(
      applyAnchoredSplice("a\rb\rc", {
        oldText: "a\nb",
        newText: "AB",
      }),
    ).toEqual({ ok: true, content: "AB\rc" });
  });

  it("appends and prepends after frontmatter using the offset scanner", () => {
    expect(appendContent("a\r\n", "b\r\n")).toBe("a\r\nb\n");
    expect(prependContent("body\n", "top\r\n")).toBe("top\nbody\n");
    expect(prependContent("---\ntitle: Test\n---\nbody\n", "inserted\n")).toBe(
      "---\ntitle: Test\n---\ninserted\nbody\n",
    );
    expect(prependContent("---\nonly: front\n---", "inserted\n")).toBe(
      "---\nonly: front\n---\ninserted\n",
    );
    expect(
      prependContent("---\r\ntitle: Test\r\n---\r\nbody\r\n", "inserted\n"),
    ).toBe("---\r\ntitle: Test\r\n---\r\ninserted\nbody\r\n");
    expect(prependContent("---\ronly: front\r---\rbody\r", "inserted\n")).toBe(
      "---\ronly: front\r---\rinserted\nbody\r",
    );
    expect(prependContent("---\nonly: front\nbody\n", "inserted\n")).toBe(
      "inserted\n---\nonly: front\nbody\n",
    );
  });
});

describe("scan search", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kb2-search-"));
    await writeFileWithParents(
      path.join(root, "notes", "a.md"),
      "alpha\nBeta target\ngamma\n",
      "utf8",
    );
    await writeFileWithParents(
      path.join(root, "notes", "deep", "b.txt"),
      "target two\nnext\n",
      "utf8",
    );
    await writeFileWithParents(
      path.join(root, "notes", "deep", "c.markdown"),
      "no hit\n",
      "utf8",
    );
    await writeFileWithParents(
      path.join(root, "notes", "skip.json"),
      "target ignored\n",
      "utf8",
    );
    await writeFileWithParents(
      path.join(root, ".kb2", "audit", "hidden.md"),
      "target hidden\n",
      "utf8",
    );
    await writeFileWithParents(
      path.join(root, "trash", "old.md"),
      "target trashed\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds case-insensitive line matches with context, filters, and pagination", async () => {
    const result = await searchVaultFiles(root, {
      q: "TARGET",
      under: "notes",
      context: 1,
      limit: 1,
      offset: 1,
    });

    expect(result).toMatchObject({
      q: "TARGET",
      under: "notes",
      limit: 1,
      offset: 1,
      total: 2,
    });
    expect(result.results).toEqual([
      {
        path: "notes/deep/b.txt",
        line: 1,
        lineText: "target two",
        context: { before: [], after: ["next"] },
      },
    ]);
  });

  it("searches from the vault root and excludes metadata and trash folders", async () => {
    const result = await searchVaultFiles(root, {
      q: "target",
      context: 0,
      limit: 10,
    });

    expect(result.total).toBe(2);
    expect(result.results.map((hit) => hit.path)).toEqual([
      "notes/a.md",
      "notes/deep/b.txt",
    ]);
    expect(
      result.results.every(
        (hit) =>
          hit.context.before.length === 0 && hit.context.after.length === 0,
      ),
    ).toBe(true);
  });

  it("caps the searchable file walk before unbounded scans", async () => {
    const cappedRoot = await mkdtemp(path.join(tmpdir(), "kb2-search-cap-"));
    const nestedRoot = await mkdtemp(
      path.join(tmpdir(), "kb2-search-nested-cap-"),
    );
    try {
      await Promise.all(
        Array.from({ length: 5001 }, async (_value, index) => {
          await writeFile(
            path.join(cappedRoot, `file-${index}.md`),
            "needle\n",
            "utf8",
          );
        }),
      );

      const result = await searchVaultFiles(cappedRoot, {
        q: "needle",
        limit: 10,
      });
      expect(result.total).toBe(5000);
      expect(result.truncated).toBe(true);
      expect(result.results).toHaveLength(10);

      await mkdir(path.join(nestedRoot, "nested"), { recursive: true });
      await Promise.all(
        Array.from({ length: 5000 }, async (_value, index) => {
          await writeFile(
            path.join(nestedRoot, "nested", `file-${index}.md`),
            "needle\n",
            "utf8",
          );
        }),
      );
      await writeFile(path.join(nestedRoot, "after.md"), "needle\n", "utf8");
      const nested = await searchVaultFiles(nestedRoot, {
        q: "needle",
        limit: 10,
      });
      expect(nested.total).toBe(5000);
      expect(nested.truncated).toBe(true);
    } finally {
      await rm(cappedRoot, { recursive: true, force: true });
      await rm(nestedRoot, { recursive: true, force: true });
    }
  });

  it("property: every randomized search result references a real line in a real file", async () => {
    const segment = fc.stringMatching(/^[a-z]{1,8}$/);
    const relativeFile = fc
      .tuple(fc.array(segment, { maxLength: 2 }), segment)
      .map(([folders, name]) => [...folders, `${name}.md`].join("/"));
    const line = fc
      .string({ maxLength: 24 })
      .filter((value) => !value.includes("\n"));
    const fileSet = fc.uniqueArray(
      fc.record({
        path: relativeFile,
        lines: fc.array(line, { minLength: 1, maxLength: 8 }),
      }),
      { minLength: 1, maxLength: 12, selector: (file) => file.path },
    );

    await fc.assert(
      fc.asyncProperty(fileSet, async (files) => {
        const propertyRoot = await mkdtemp(
          path.join(tmpdir(), "kb2-search-property-"),
        );
        try {
          const expectedLines = new Map<string, string[]>();
          for (const file of files) {
            const lines =
              file.lines.length > 0 &&
              file.lines.some((candidate) => candidate.includes("needle"))
                ? file.lines
                : ["needle", ...file.lines];
            expectedLines.set(file.path, lines);
            await writeFileWithParents(
              path.join(propertyRoot, file.path),
              `${lines.join("\n")}\n`,
              "utf8",
            );
          }

          const result = await searchVaultFiles(propertyRoot, {
            q: "needle",
            limit: 100,
            context: 2,
          });
          for (const hit of result.results) {
            const lines = expectedLines.get(hit.path);
            expect(lines).toBeDefined();
            expect(hit.line).toBeGreaterThanOrEqual(1);
            expect(hit.line).toBeLessThanOrEqual(lines!.length);
            expect(hit.lineText).toBe(lines![hit.line - 1]);
            expect(hit.lineText.toLocaleLowerCase()).toContain("needle");
          }
        } finally {
          await rm(propertyRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 35 },
    );
  });

  it("returns empty results for empty and missing-folder searches", async () => {
    await expect(searchVaultFiles(root, { q: "   " })).resolves.toMatchObject({
      q: "   ",
      total: 0,
      results: [],
    });
    await expect(
      searchVaultFiles(root, { q: "target", under: "missing" }),
    ).resolves.toMatchObject({
      total: 0,
      results: [],
    });
    await expect(
      searchVaultFiles(root, {
        q: "target",
        under: "notes/a.md",
        context: 50,
        limit: -1,
        offset: -1,
      }),
    ).resolves.toMatchObject({
      limit: 20,
      offset: 0,
      total: 0,
      results: [],
    });
  });

  it("rejects invalid folder filters through path validation", async () => {
    await expect(
      searchVaultFiles(root, { q: "target", under: "../outside" }),
    ).rejects.toThrow("Invalid vault path");
  });
});

async function readAuditLines(root: string): Promise<unknown[]> {
  const content = await readFile(
    path.join(root, ".kb2/audit/changes.jsonl"),
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

async function readRawFolderMetadata(
  root: string,
): Promise<{ raw: string; parsed: unknown }> {
  const raw = await readFile(path.join(root, ".kb2/folders.yml"), "utf8");
  return { raw, parsed: parseYaml(raw) };
}

async function readRawFileHistory(
  root: string,
): Promise<{ raw: string; parsed: unknown }> {
  const raw = await readFile(path.join(root, ".kb2/file-history.yml"), "utf8");
  return { raw, parsed: parseYaml(raw) };
}

async function writeRawFileHistory(root: string, content: unknown): Promise<void> {
  await mkdir(path.join(root, ".kb2"), { recursive: true });
  await writeFile(
    path.join(root, ".kb2/file-history.yml"),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
}

async function writeFileWithParents(
  pathname: string,
  content: string,
  encoding: BufferEncoding,
): Promise<void> {
  await writeFile(pathname, content, encoding).catch(async (error: unknown) => {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, content, encoding);
  });
}

function expectedMovedMetadata(
  metadata: Record<string, { color: string }>,
  fromPath: string,
  toPath: string,
): Record<string, { color: string }> {
  const next: Record<string, { color: string }> = {};
  for (const [folderPath, folderMetadata] of Object.entries(metadata)) {
    if (folderPath === fromPath) {
      next[toPath] = folderMetadata;
    } else if (folderPath.startsWith(`${fromPath}/`)) {
      next[path.posix.join(toPath, folderPath.slice(fromPath.length + 1))] =
        folderMetadata;
    } else {
      next[folderPath] = folderMetadata;
    }
  }
  return Object.fromEntries(
    Object.entries(next).sort(([left], [right]) => left.localeCompare(right)),
  );
}
