import {
  execFile,
} from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
  classifyArtifactPath,
  deleteVaultFile,
  deleteVaultFolder,
  getFolderMetadata,
  getVaultInfo,
  listFolderMetadata,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  readVaultRawFile,
  readVaultFile,
  setFolderMetadata,
  writeVaultRawFile,
  writeVaultFile,
  type VaultContext,
} from "./vault-ops.js";
import { onVaultAudit } from "./audit.js";
import {
  historyOperationFromAudit,
  flushFileHistory,
  listFileHistory,
  readFileHistoryVersion,
  moveFileHistory,
  moveFolderHistory,
  recordFileHistory,
} from "./file-history.js";
import { searchVaultFiles } from "./search.js";
import { isInternalVaultPath, validateVaultPath } from "./path.js";
import { anchoredSpliceContractCases } from "./splice-contract-cases.test-support.js";

const CORAL = "#fda4af";
const MINT = "#a7f3d0";
const SKY = "#bae6fd";
const ROSE = "#fecdd3";
const SAGE = "#d9f99d";
const execFileAsync = promisify(execFile);

describe("vault path validation", () => {
  const validSegment = fc
    .stringMatching(/^[A-Za-z0-9_-]{1,24}$/)
    .filter(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        segment !== ".kb1" &&
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
    ["nested/../asset", "artifact"],
    [".", "folder"],
    ["..", "folder"],
    ["nested/../file.md", "file"],
    ["nested\\.md", "file"],
    ["folder/no-extension", "file"],
    ["folder/.hidden", "file"],
    ["folder/trailing.", "file"],
    [".kb1/audit.md", "file"],
    [".kb1/audit.bin", "artifact"],
    [".git", "folder"],
    [".gitignore", "artifact"],
    [".gitattributes", "artifact"],
    [".gitmodules", "artifact"],
    ["notes/.gitignore", "artifact"],
    [".git/COMMIT_EDITMSG", "artifact"],
    [".git/objects/aa/bb.txt", "file"],
    [`${"a".repeat(256)}.md`, "file"],
    [`${"a".repeat(1025)}.md`, "file"],
  ] as const)("rejects invalid %s as %s", (input, kind) => {
    expect(() => validateVaultPath(input, kind)).toThrow();
  });

  it.each([
    ["note.md", "file"],
    ["nested/note.md", "file"],
    ["nested/deep", "folder"],
    ["attachments/photo.png", "artifact"],
    ["attachments/extensionless", "artifact"],
  ] as const)("accepts %s as %s", (input, kind) => {
    expect(validateVaultPath(input, kind)).toBe(input);
  });

  it("rejects non-string input", () => {
    expect(() => validateVaultPath(123 as unknown as string, "file")).toThrow(
      "path must be a string",
    );
  });

  it("identifies daemon-internal path segments without hiding all dotfolders", () => {
    expect(isInternalVaultPath("")).toBe(false);
    expect(isInternalVaultPath("notes/.git/COMMIT_EDITMSG")).toBe(true);
    expect(isInternalVaultPath(".gitignore")).toBe(true);
    expect(isInternalVaultPath("notes/.gitattributes")).toBe(true);
    expect(isInternalVaultPath("notes/.obsidian/config.json")).toBe(false);
  });

  it("property: valid file paths validate idempotently and resolve inside the vault root", () => {
    fc.assert(
      fc.property(validFilePath, (candidate) => {
        const validated = validateVaultPath(candidate, "file");
        expect(validateVaultPath(validated, "file")).toBe(validated);
        expect(
          path
            .resolve("/tmp/kb1-property-vault", validated)
            .startsWith("/tmp/kb1-property-vault/"),
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
            .resolve("/tmp/kb1-property-vault", validated)
            .startsWith("/tmp/kb1-property-vault/"),
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
    root = await mkdtemp(path.join(tmpdir(), "kb1-vault-core-"));
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

  it("classifies copied-in filesystem artifacts without required metadata", async () => {
    await writeFileWithParents(path.join(root, "notes/a.md"), "# A\n", "utf8");
    await writeFileWithParents(
      path.join(root, "scripts/app.ts"),
      "export {};\n",
      "utf8",
    );
    await mkdir(path.join(root, "attachments"), { recursive: true });
    await writeFile(path.join(root, "attachments/photo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(root, "attachments/blob"), new Uint8Array([1, 2, 3]));

    const tree = await listVaultTree(ctx, { depth: Number.MAX_SAFE_INTEGER });
    expect(tree).toMatchObject({ ok: true });
    if (!tree.ok) throw new Error("expected tree");
    expect(tree.value.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "notes/a.md",
        kind: "file",
        artifact: {
          kind: "text",
          contentType: "text/markdown; charset=utf-8",
          editable: true,
          preview: "markdown",
        },
      }),
      expect.objectContaining({
        path: "scripts/app.ts",
        kind: "file",
        artifact: {
          kind: "text",
          contentType: "text/typescript; charset=utf-8",
          editable: true,
          preview: "text",
        },
      }),
      expect.objectContaining({
        path: "attachments/photo.png",
        kind: "file",
        artifact: {
          kind: "attachment",
          contentType: "image/png",
          editable: false,
          preview: "image",
        },
      }),
      expect.objectContaining({
        path: "attachments/blob",
        kind: "file",
        artifact: {
          kind: "attachment",
          contentType: "application/octet-stream",
          editable: false,
          preview: "download",
        },
      }),
    ]));
  });

  it("round-trips raw bytes without the editable text path", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const created = await writeVaultRawFile(ctx, {
      path: "attachments/photo.png",
      bytes,
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        path: "attachments/photo.png",
        size: 4,
        artifact: {
          kind: "attachment",
          contentType: "image/png",
          editable: false,
          preview: "image",
        },
      },
    });
    await expect(readFile(path.join(root, "attachments/photo.png"))).resolves.toEqual(Buffer.from(bytes));

    const duplicate = await writeVaultRawFile(ctx, {
      path: "attachments/photo.png",
      bytes: new Uint8Array([9]),
    });
    expect(duplicate).toMatchObject({ ok: false, error: "already_exists" });

    const raw = await readVaultRawFile(ctx, "attachments/photo.png");
    expect(raw).toMatchObject({
      ok: true,
      value: {
        path: "attachments/photo.png",
        filePath: path.join(root, "attachments/photo.png"),
        size: 4,
      },
    });
    await expect(readVaultRawFile(ctx, "attachments/missing.png")).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });

    await expect(readVaultFile(ctx, "attachments/photo.png")).resolves.toMatchObject({
      ok: false,
      error: "not_editable",
    });
    await expect(writeVaultFile(ctx, {
      path: "attachments/photo.png",
      content: "not png",
      overwrite: true,
    })).resolves.toMatchObject({
      ok: false,
      error: "not_editable",
    });

    const extensionless = await writeVaultRawFile(ctx, {
      path: "attachments/blob",
      bytes,
    });
    expect(extensionless).toMatchObject({
      ok: true,
      value: {
        artifact: {
          kind: "attachment",
          contentType: "application/octet-stream",
          preview: "download",
        },
      },
    });

    await expect(readVaultRawFile(ctx, "../outside.png")).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(
      path.join(root, ".git", "COMMIT_EDITMSG"),
      "internal commit\n",
      "utf8",
    );
    await writeFile(path.join(root, ".gitignore"), "*\n", "utf8");
    await expect(
      readVaultRawFile(ctx, ".git/COMMIT_EDITMSG"),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(readVaultRawFile(ctx, ".gitignore")).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await expect(
      writeVaultRawFile(ctx, {
        path: "../outside.png",
        bytes,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
    await writeFileWithParents(path.join(root, "attachments/blocker"), "file", "utf8");
    await expect(
      writeVaultRawFile(ctx, {
        path: "attachments/blocker/photo.png",
        bytes,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "path_collision",
    });
  });

  it("exposes deterministic artifact classification for callers", () => {
    expect(classifyArtifactPath("notes/a.md")).toEqual({
      kind: "text",
      contentType: "text/markdown; charset=utf-8",
      editable: true,
      preview: "markdown",
    });
    expect(classifyArtifactPath("assets/clip.mp3")).toEqual({
      kind: "attachment",
      contentType: "audio/mpeg",
      editable: false,
      preview: "audio",
    });
    expect(classifyArtifactPath("assets/unknown")).toEqual({
      kind: "attachment",
      contentType: "application/octet-stream",
      editable: false,
      preview: "download",
    });
  });

  it("overlays pending per-file buckets and flushes them to Git commits", async () => {
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

    await writeFileWithParents(
      path.join(root, "notes/history.md"),
      "first",
      "utf8",
    );
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
      value: {
        operation: "create",
        actor,
        size: 5,
      },
    });
    const created = await listFileHistory(root, { path: "notes/history.md" });
    if (!created.ok) throw new Error("expected created history page");
    expect(created.value.entries).toMatchObject([
      {
        pending: true,
        operation: "create",
        actor,
        contributors: [actor],
        size: 5,
      },
    ]);
    expect(created.value.entries[0]).not.toHaveProperty("content");
    await writeFile(path.join(root, "notes/history.md"), "second", "utf8");
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor,
      content: "second",
      now: new Date("2026-06-30T00:01:00.000Z"),
    });
    await writeFile(path.join(root, "notes/history.md"), "third", "utf8");
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor: otherClient,
      content: "third",
      now: new Date("2026-06-30T00:02:00.000Z"),
    });
    await writeFile(path.join(root, "notes/history.md"), "fourth", "utf8");
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor: otherActor,
      content: "fourth",
      now: new Date("2026-06-30T00:03:00.000Z"),
    });

    await expect(listFileHistory(root, { path: "notes/history.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        hasMore: false,
        entries: [
          {
            pending: true,
            operation: "create",
            actor: { kind: "system", name: "3 contributors" },
            contributors: [actor, otherClient, otherActor],
            size: 6,
          },
        ],
      },
    });

    await expect(
      flushFileHistory(root, { now: new Date("2026-06-30T00:04:00.000Z") }),
    ).resolves.toMatchObject({ ok: true, value: { flushed: 1 } });

    const flushed = await listFileHistory(root, { path: "notes/history.md" });
    expect(flushed).toMatchObject({
      ok: true,
      value: {
        hasMore: false,
        entries: [
          {
            operation: "create",
            actor: { kind: "system", name: "3 contributors" },
            contributors: [actor, otherClient, otherActor],
            size: 6,
          },
        ],
      },
    });
    if (!flushed.ok) throw new Error("expected flushed history page");
    expect(flushed.value.entries[0]).not.toHaveProperty("content");
    expect(flushed.value.entries[0]?.commitId).toMatch(/^[0-9a-f]{40}$/);

    const gitAuthor = await git(root, ["log", "-1", "--format=%an <%ae>"]);
    expect(gitAuthor.stdout.trim()).toBe("KB-1 Daemon <history@kb-1.ai>");
    const gitBody = await git(root, ["log", "-1", "--format=%B"]);
    expect(gitBody.stdout).toContain("KB1-Contributor:");
    expect(gitBody.stdout).toContain("Ada Lovelace");
    expect(gitBody.stdout).toContain("Ada Bot");
    const gitignoreTracked = await git(root, ["ls-files", ".gitignore"]);
    expect(gitignoreTracked.stdout.trim()).toBe(".gitignore");

    await writeFile(path.join(root, "notes/history.md"), "fifth", "utf8");
    await recordFileHistory(root, {
      path: "notes/history.md",
      operation: "update",
      actor: otherActor,
      content: "fifth",
      now: new Date("2026-06-30T00:10:00.000Z"),
    });

    const firstPage = await listFileHistory(root, {
      path: "notes/history.md",
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      value: {
        hasMore: true,
        entries: [
          { pending: true, actor: otherActor, size: 5 },
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
          { operation: "create", actor: { kind: "system", name: "3 contributors" }, size: 6 },
        ],
      },
    });

    await writeFileWithParents(path.join(root, "alpha/sorted.md"), "sorted", "utf8");
    await recordFileHistory(root, {
      path: "alpha/sorted.md",
      operation: "create",
      actor,
      content: "sorted",
      now: new Date("2026-06-30T00:11:00.000Z"),
    });
    await expect(
      flushFileHistory(root, { now: new Date("2026-06-30T00:12:00.000Z") }),
    ).resolves.toMatchObject({ ok: true, value: { flushed: 2 } });
    await recordFileHistory(root, {
      path: "alpha/sorted.md",
      operation: "update",
      actor,
      content: "sorted",
      now: new Date("2026-06-30T00:13:00.000Z"),
    });
    await expect(
      flushFileHistory(root, { paths: ["alpha/sorted.md"] }),
    ).resolves.toMatchObject({ ok: true, value: { flushed: 1 } });
    await writeFile(path.join(root, "alpha/sorted.md"), "sorted again", "utf8");
    await recordFileHistory(root, {
      path: "alpha/sorted.md",
      operation: "update",
      actor,
      content: "sorted again",
      now: new Date("2026-06-30T00:15:00.000Z"),
    });
    await expect(
      flushFileHistory(root, { paths: ["alpha/sorted.md"] }),
    ).resolves.toMatchObject({ ok: true, value: { flushed: 1 } });
    await expect(flushFileHistory(root)).resolves.toEqual({ ok: true, value: { flushed: 0 } });
  });

  it("reads pending and committed history content only through the note's identity chain", async () => {
    const actor = { kind: "user" as const, id: "history-reader", client: "browser" };
    const sourcePath = "notes/versioned.md";
    const targetPath = "archive/versioned.md";
    await writeFileWithParents(path.join(root, sourcePath), "first version\n", "utf8");
    const pending = await recordFileHistory(root, {
      path: sourcePath,
      operation: "create",
      actor,
      content: "first version\n",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    if (!pending.ok) throw new Error("expected pending history");

    await expect(readFileHistoryVersion(root, {
      path: sourcePath,
      id: pending.value.id,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content: "first version\n" },
    });
    await flushFileHistory(root, { paths: [sourcePath] });
    const created = await listFileHistory(root, { path: sourcePath });
    if (!created.ok || !created.value.entries[0]) throw new Error("expected committed history");
    const createdId = created.value.entries[0].id;
    expect(createdId).toBe(pending.value.id);
    await expect(readFileHistoryVersion(root, {
      path: sourcePath,
      id: pending.value.id,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content: "first version\n" },
    });

    await mkdir(path.join(root, "archive"), { recursive: true });
    await rename(path.join(root, sourcePath), path.join(root, targetPath));
    await moveFileHistory(root, {
      fromPath: sourcePath,
      toPath: targetPath,
      actor,
      content: "first version\n",
      now: new Date("2026-07-01T00:01:00.000Z"),
    });

    await expect(readFileHistoryVersion(root, {
      path: targetPath,
      id: createdId,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content: "first version\n", entry: { id: createdId } },
    });
    await expect(readFileHistoryVersion(root, {
      path: "notes/unrelated.md",
      id: createdId,
    })).resolves.toMatchObject({ ok: false, error: "not_found" });
    await expect(readFileHistoryVersion(root, {
      path: targetPath,
      id: "not-a-history-entry",
    })).resolves.toMatchObject({ ok: false, error: "not_found" });
  });

  it("preserves a pending version id when its content matches the current Git snapshot", async () => {
    const notePath = "notes/no-op-version.md";
    const content = "same content\n";
    await writeFile(path.join(root, ".gitignore"), ".kb1/\n", "utf8");
    await writeFileWithParents(path.join(root, notePath), content, "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content,
      now: new Date("2026-07-01T00:30:00.000Z"),
    });
    await flushFileHistory(root, { paths: [notePath] });

    const pending = await recordFileHistory(root, {
      path: notePath,
      operation: "update",
      content,
      now: new Date("2026-07-01T00:31:00.000Z"),
    });
    if (!pending.ok) throw new Error("expected no-op pending history");
    await expect(flushFileHistory(root, { paths: [notePath] })).resolves.toEqual({
      ok: true,
      value: { flushed: 1 },
    });

    const history = await listFileHistory(root, { path: notePath });
    if (!history.ok) throw new Error("expected no-op committed history");
    expect(history.value.entries).toHaveLength(2);
    expect(history.value.entries.some((entry) => entry.id === pending.value.id)).toBe(true);
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: pending.value.id,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content, entry: { id: pending.value.id } },
    });
  });

  it("reports unavailable committed snapshots without returning unverified content", async () => {
    const notePath = "notes/unavailable.md";
    await writeFileWithParents(path.join(root, notePath), "trusted\n", "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content: "trusted\n",
      now: new Date("2026-07-01T01:00:00.000Z"),
    });
    await flushFileHistory(root, { paths: [notePath] });

    const originalMessage = (await git(root, ["log", "-1", "--format=%B"])).stdout;
    await git(root, [
      "commit",
      "--amend",
      "-m",
      originalMessage.replace(/KB1-Content-SHA256: [0-9a-f]+/u, `KB1-Content-SHA256: ${"0".repeat(64)}`),
    ]);
    const tamperedHistory = await listFileHistory(root, { path: notePath });
    if (!tamperedHistory.ok || !tamperedHistory.value.entries[0]) {
      throw new Error("expected tampered history entry");
    }
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: tamperedHistory.value.entries[0].id,
    })).resolves.toMatchObject({ ok: true, value: { available: false } });

    await rm(path.join(root, notePath));
    await git(root, ["add", "-A", "--", notePath]);
    const deletedMessage = [
      `KB-1 history: update ${notePath}`,
      "",
      `KB1-Path-JSON: ${JSON.stringify(notePath)}`,
      "KB1-Operation: update",
      "KB1-Bucket-Start: 2026-07-01T01:01:00.000Z",
      "KB1-Bucket-End: 2026-07-01T01:01:00.000Z",
      "KB1-Size: 8",
    ].join("\n");
    await git(root, ["commit", "-m", deletedMessage]);
    const deletedHistory = await listFileHistory(root, { path: notePath });
    if (!deletedHistory.ok || !deletedHistory.value.entries[0]) {
      throw new Error("expected deleted-blob history entry");
    }
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: deletedHistory.value.entries[0].id,
    })).resolves.toMatchObject({ ok: true, value: { available: false } });

    await expect(readFileHistoryVersion(root, { path: "../escape.md", id: "x" }))
      .resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(readFileHistoryVersion(root, { path: notePath, id: "" }))
      .resolves.toMatchObject({ ok: false, error: "not_found" });
  });

  it("fails closed when explicit snapshot integrity metadata is incomplete or unknown", async () => {
    const missingHashPath = "notes/missing-history-hash.md";
    await writeFileWithParents(path.join(root, missingHashPath), "missing hash\n", "utf8");
    await recordFileHistory(root, {
      path: missingHashPath,
      operation: "create",
      content: "missing hash\n",
      now: new Date("2026-07-01T01:10:00.000Z"),
    });
    await flushFileHistory(root, { paths: [missingHashPath] });
    const missingHashMessage = (await git(root, ["log", "-1", "--format=%B"])).stdout
      .replace(/^KB1-Content-SHA256:.*\n?/mu, "");
    await git(root, ["commit", "--amend", "-m", missingHashMessage]);

    const missingHashHistory = await listFileHistory(root, { path: missingHashPath });
    if (!missingHashHistory.ok || !missingHashHistory.value.entries[0]) {
      throw new Error("expected history entry with missing integrity hash");
    }
    await expect(readFileHistoryVersion(root, {
      path: missingHashPath,
      id: missingHashHistory.value.entries[0].id,
    })).resolves.toMatchObject({ ok: true, value: { available: false } });

    const unknownFormatPath = "notes/unknown-history-format.md";
    await writeFileWithParents(path.join(root, unknownFormatPath), "unknown format\n", "utf8");
    await recordFileHistory(root, {
      path: unknownFormatPath,
      operation: "create",
      content: "unknown format\n",
      now: new Date("2026-07-01T01:20:00.000Z"),
    });
    await flushFileHistory(root, { paths: [unknownFormatPath] });
    const unknownFormatMessage = (await git(root, ["log", "-1", "--format=%B"])).stdout
      .replace(
        /^KB1-Content-Hash-Format:.*$/mu,
        "KB1-Content-Hash-Format: future-format",
      );
    await git(root, ["commit", "--amend", "-m", unknownFormatMessage]);

    const unknownFormatHistory = await listFileHistory(root, { path: unknownFormatPath });
    if (!unknownFormatHistory.ok || !unknownFormatHistory.value.entries[0]) {
      throw new Error("expected history entry with unknown integrity format");
    }
    await expect(readFileHistoryVersion(root, {
      path: unknownFormatPath,
      id: unknownFormatHistory.value.entries[0].id,
    })).resolves.toMatchObject({ ok: true, value: { available: false } });
  });

  it("reads committed snapshots larger than the metadata command buffer", async () => {
    const notePath = "notes/large-history.md";
    const content = `${"a".repeat(10 * 1024 * 1024)}\n`;
    await writeFileWithParents(path.join(root, notePath), content, "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content,
      now: new Date("2026-07-01T02:00:00.000Z"),
    });
    await flushFileHistory(root, { paths: [notePath] });

    const history = await listFileHistory(root, { path: notePath });
    if (!history.ok || !history.value.entries[0]) {
      throw new Error("expected large history entry");
    }
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: history.value.entries[0].id,
    })).resolves.toMatchObject({ ok: true, value: { available: true, content } });
  });

  it("hashes the committed representation after Git clean filters", async () => {
    const notePath = "notes/normalized-history.md";
    const workingTreeContent = "first\r\nsecond\r\n";
    await writeFile(path.join(root, ".gitattributes"), "*.md text eol=lf\n", "utf8");
    await writeFileWithParents(path.join(root, notePath), workingTreeContent, "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content: workingTreeContent,
      now: new Date("2026-07-01T03:00:00.000Z"),
    });
    await flushFileHistory(root, { paths: [notePath] });

    const history = await listFileHistory(root, { path: notePath });
    if (!history.ok || !history.value.entries[0]) {
      throw new Error("expected normalized history entry");
    }
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: history.value.entries[0].id,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content: "first\nsecond\n" },
    });
  });

  it("reads pre-upgrade snapshots whose trailer hash predates Git normalization", async () => {
    const notePath = "notes/legacy-normalized-history.md";
    const workingTreeContent = "legacy\r\ncontent\r\n";
    await writeFile(path.join(root, ".gitattributes"), "*.md text eol=lf\n", "utf8");
    await writeFileWithParents(path.join(root, notePath), workingTreeContent, "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content: workingTreeContent,
      now: new Date("2026-07-01T03:30:00.000Z"),
    });
    await flushFileHistory(root, { paths: [notePath] });

    const legacyHashBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(workingTreeContent),
    );
    const legacyHash = Array.from(
      new Uint8Array(legacyHashBytes),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const originalMessage = (await git(root, ["log", "-1", "--format=%B"])).stdout;
    await git(root, [
      "commit",
      "--amend",
      "-m",
      originalMessage
        .replace(/^KB1-Content-Hash-Format:.*\n?/mu, "")
        .replace(/KB1-Content-SHA256: [0-9a-f]+/u, `KB1-Content-SHA256: ${legacyHash}`),
    ]);

    const history = await listFileHistory(root, { path: notePath });
    if (!history.ok || !history.value.entries[0]) {
      throw new Error("expected legacy normalized history entry");
    }
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: history.value.entries[0].id,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content: "legacy\ncontent\n" },
    });
  });

  it("reads the stage-zero blob for filenames that resemble Git index stages", async () => {
    const notePath = "1:note.md";
    await writeFile(path.join(root, notePath), "stage zero\n", "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content: "stage zero\n",
      now: new Date("2026-07-01T03:45:00.000Z"),
    });
    await expect(flushFileHistory(root, { paths: [notePath] })).resolves.toMatchObject({
      ok: true,
      value: { flushed: 1 },
    });

    const history = await listFileHistory(root, { path: notePath });
    if (!history.ok || !history.value.entries[0]) {
      throw new Error("expected stage-like history entry");
    }
    await expect(readFileHistoryVersion(root, {
      path: notePath,
      id: history.value.entries[0].id,
    })).resolves.toMatchObject({
      ok: true,
      value: { available: true, content: "stage zero\n" },
    });
  });

  it("durably clears pending history when the staged note was deleted", async () => {
    const notePath = "notes/deleted-after-edit.md";
    await writeFileWithParents(path.join(root, notePath), "original\n", "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "create",
      content: "original\n",
      now: new Date("2026-07-01T04:00:00.000Z"),
    });
    await flushFileHistory(root, { paths: [notePath] });

    await writeFile(path.join(root, notePath), "edited then deleted\n", "utf8");
    await recordFileHistory(root, {
      path: notePath,
      operation: "update",
      content: "edited then deleted\n",
      now: new Date("2026-07-01T04:01:00.000Z"),
    });
    await rm(path.join(root, notePath));

    await expect(flushFileHistory(root, { paths: [notePath] })).resolves.toEqual({
      ok: true,
      value: { flushed: 1 },
    });
    await expect(flushFileHistory(root, { paths: [notePath] })).resolves.toEqual({
      ok: true,
      value: { flushed: 0 },
    });
  });

  it("keeps independently created copies out of each other's history", async () => {
    const actor = {
      kind: "integration" as const,
      id: "daily-brief-import",
      client: "migration",
    };
    const content = [
      "# Morning brief",
      "",
      "## Today",
      "",
      "- Review the launch checklist.",
      "- Confirm the daemon health check.",
      "",
    ].join("\n");

    await writeFileWithParents(
      path.join(root, "briefs/2026-07-16.md"),
      content,
      "utf8",
    );
    await recordFileHistory(root, {
      path: "briefs/2026-07-16.md",
      operation: "create",
      actor,
      content,
      now: new Date("2026-07-16T13:00:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: ["briefs/2026-07-16.md"],
      now: new Date("2026-07-16T13:00:30.000Z"),
    });

    await writeFileWithParents(
      path.join(root, "briefs/2026-07-17.md"),
      content,
      "utf8",
    );
    await recordFileHistory(root, {
      path: "briefs/2026-07-17.md",
      operation: "create",
      actor,
      content,
      now: new Date("2026-07-17T13:00:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: ["briefs/2026-07-17.md"],
      now: new Date("2026-07-17T13:00:30.000Z"),
    });
    await git(root, ["config", "log.follow", "true"]);

    await expect(
      listFileHistory(root, { path: "briefs/2026-07-17.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        hasMore: false,
        entries: [
          {
            path: "briefs/2026-07-17.md",
            operation: "create",
            actor,
          },
        ],
      },
    });
    const secondHistory = await listFileHistory(root, {
      path: "briefs/2026-07-17.md",
    });
    if (!secondHistory.ok) throw new Error("expected second brief history");
    expect(secondHistory.value.entries).toHaveLength(1);
  });

  it("preserves file identity when history paths contain line breaks", async () => {
    const actor = {
      kind: "user" as const,
      id: "line-break-owner",
      client: "browser",
    };
    const unrelatedActor = {
      kind: "integration" as const,
      id: "unrelated-file",
      client: "migration",
    };
    const unrelatedPath = "notes/source.md";
    const sourcePath = "notes/source.md\ncontinued.md";
    const targetPath = "archive/moved.md";

    await writeFileWithParents(path.join(root, unrelatedPath), "unrelated\n", "utf8");
    await recordFileHistory(root, {
      path: unrelatedPath,
      operation: "create",
      actor: unrelatedActor,
      content: "unrelated\n",
      now: new Date("2026-07-17T13:30:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: [unrelatedPath],
      now: new Date("2026-07-17T13:30:30.000Z"),
    });

    await writeFileWithParents(path.join(root, sourcePath), "line break identity\n", "utf8");
    await recordFileHistory(root, {
      path: sourcePath,
      operation: "create",
      actor,
      content: "line break identity\n",
      now: new Date("2026-07-17T13:31:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: [sourcePath],
      now: new Date("2026-07-17T13:31:30.000Z"),
    });

    const sourceHistory = await listFileHistory(root, { path: sourcePath });
    if (!sourceHistory.ok) throw new Error("expected line-break source history");
    expect(sourceHistory.value.entries).toHaveLength(1);
    expect(sourceHistory.value.entries).toMatchObject([
      { path: sourcePath, operation: "create", actor },
    ]);

    await mkdir(path.join(root, "archive"), { recursive: true });
    await rename(path.join(root, sourcePath), path.join(root, targetPath));
    await moveFileHistory(root, {
      fromPath: sourcePath,
      toPath: targetPath,
      actor,
      content: "line break identity\n",
      now: new Date("2026-07-17T13:32:00.000Z"),
    });

    const movedHistory = await listFileHistory(root, { path: targetPath });
    if (!movedHistory.ok) throw new Error("expected moved line-break history");
    expect(movedHistory.value.entries).toHaveLength(2);
    expect(movedHistory.value.entries).toMatchObject([
      { path: targetPath, operation: "move", actor },
      { path: targetPath, operation: "create", actor },
    ]);

    const gitBody = await git(root, ["log", "-1", "--format=%B"]);
    expect(gitBody.stdout).toContain(
      `KB1-From-Path-JSON: ${JSON.stringify(sourcePath)}`,
    );
    expect(gitBody.stdout).not.toContain(`KB1-From-Path: ${sourcePath}`);
  });

  it("preserves legacy CRLF history whose raw path trailers contain line breaks", async () => {
    const actor = {
      kind: "user" as const,
      id: "legacy-line-break-owner",
      client: "browser",
    };
    const sourcePath = "legacy/source.md\ncontinued.md";
    const targetPath = "archive/legacy-moved.md";

    await writeFileWithParents(path.join(root, "seed.md"), "seed\n", "utf8");
    await recordFileHistory(root, {
      path: "seed.md",
      operation: "create",
      content: "seed\n",
      now: new Date("2026-07-17T13:40:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: ["seed.md"],
      now: new Date("2026-07-17T13:40:30.000Z"),
    });

    await writeFileWithParents(path.join(root, sourcePath), "legacy identity\n", "utf8");
    await git(root, ["add", "--", sourcePath]);
    await git(root, [
      "commit",
      "-m",
      "legacy multiline history entry",
      "-m",
      [
        `KB1-Path: ${sourcePath}`,
        "KB1-Operation: create",
        "KB1-Bucket-Start: 2026-07-17T13:40:30.000Z",
        "KB1-Bucket-End: 2026-07-17T13:40:30.000Z",
        `KB1-Contributor: ${JSON.stringify(actor)}`,
      ].join("\r\n"),
    ]);

    const sourceHistory = await listFileHistory(root, { path: sourcePath });
    if (!sourceHistory.ok) throw new Error("expected legacy multiline source history");
    expect(sourceHistory.value.entries).toHaveLength(1);
    expect(sourceHistory.value.entries).toMatchObject([
      { path: sourcePath, operation: "create", actor },
    ]);

    await mkdir(path.join(root, "archive"), { recursive: true });
    await rename(path.join(root, sourcePath), path.join(root, targetPath));
    await moveFileHistory(root, {
      fromPath: sourcePath,
      toPath: targetPath,
      actor,
      content: "legacy identity\n",
      now: new Date("2026-07-17T13:41:00.000Z"),
    });

    const movedHistory = await listFileHistory(root, { path: targetPath });
    if (!movedHistory.ok) throw new Error("expected moved legacy multiline history");
    expect(movedHistory.value.entries).toHaveLength(2);
    expect(movedHistory.value.entries).toMatchObject([
      { path: targetPath, operation: "move", actor },
      { path: targetPath, operation: "create", actor },
    ]);
  });

  it("follows explicit move chains without crossing recreated source paths", async () => {
    const actor = {
      kind: "user" as const,
      id: "history-owner",
      client: "browser",
    };
    const originalPath = "notes/original.md";
    const renamedPath = "notes/renamed.md";
    const finalPath = "archive/final.md";

    await writeFileWithParents(
      path.join(root, originalPath),
      "original identity\n",
      "utf8",
    );
    await recordFileHistory(root, {
      path: originalPath,
      operation: "create",
      actor,
      content: "original identity\n",
      now: new Date("2026-07-17T14:00:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: [originalPath],
      now: new Date("2026-07-17T14:00:30.000Z"),
    });

    await rename(path.join(root, originalPath), path.join(root, renamedPath));
    await moveFileHistory(root, {
      fromPath: originalPath,
      toPath: renamedPath,
      actor,
      content: "original identity\n",
      now: new Date("2026-07-17T14:01:00.000Z"),
    });

    await mkdir(path.join(root, "archive"), { recursive: true });
    await rename(path.join(root, renamedPath), path.join(root, finalPath));
    await moveFileHistory(root, {
      fromPath: renamedPath,
      toPath: finalPath,
      actor,
      content: "original identity\n",
      now: new Date("2026-07-17T14:02:00.000Z"),
    });

    await writeFileWithParents(
      path.join(root, originalPath),
      "replacement identity\n",
      "utf8",
    );
    await recordFileHistory(root, {
      path: originalPath,
      operation: "create",
      actor,
      content: "replacement identity\n",
      now: new Date("2026-07-17T14:03:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: [originalPath],
      now: new Date("2026-07-17T14:03:30.000Z"),
    });

    const replacementHistory = await listFileHistory(root, {
      path: originalPath,
    });
    if (!replacementHistory.ok) throw new Error("expected replacement history");
    expect(replacementHistory.value.entries).toHaveLength(1);
    expect(replacementHistory.value.entries).toMatchObject([
      { path: originalPath, operation: "create", actor },
    ]);

    const movedHistory = await listFileHistory(root, { path: finalPath });
    if (!movedHistory.ok) throw new Error("expected moved history");
    expect(movedHistory.value.entries).toHaveLength(3);
    expect(movedHistory.value.entries).toMatchObject([
      { path: finalPath, operation: "move", actor },
      { path: finalPath, operation: "rename", actor },
      { path: finalPath, operation: "create", actor },
    ]);
  });

  it("stops at explicit moves with missing or invalid source metadata", async () => {
    await writeFileWithParents(
      path.join(root, "notes/seed.md"),
      "seed\n",
      "utf8",
    );
    await recordFileHistory(root, {
      path: "notes/seed.md",
      operation: "create",
      content: "seed\n",
      now: new Date("2026-07-17T15:00:00.000Z"),
    });
    await flushFileHistory(root, {
      paths: ["notes/seed.md"],
      now: new Date("2026-07-17T15:00:30.000Z"),
    });

    const missingSourcePath = "notes/missing-source.md";
    await writeFile(path.join(root, missingSourcePath), "missing source\n", "utf8");
    await git(root, ["add", "--", missingSourcePath]);
    await git(root, [
      "commit",
      "-m",
      "external move without source",
      "-m",
      [
        `KB1-Path: ${missingSourcePath}`,
        "KB1-Operation: move",
      ].join("\n"),
    ]);

    const invalidSourcePath = "notes/invalid-source.md";
    await writeFile(path.join(root, invalidSourcePath), "invalid source\n", "utf8");
    await git(root, ["add", "--", invalidSourcePath]);
    await git(root, [
      "commit",
      "-m",
      "external move with invalid source",
      "-m",
      [
        `KB1-Path: ${invalidSourcePath}`,
        "KB1-From-Path: ../outside.md",
        "KB1-Operation: move",
      ].join("\n"),
    ]);

    const malformedSourcePath = "notes/malformed-source.md";
    await writeFile(path.join(root, malformedSourcePath), "malformed source\n", "utf8");
    await git(root, ["add", "--", malformedSourcePath]);
    await git(root, [
      "commit",
      "-m",
      "external move with malformed encoded source",
      "-m",
      [
        `KB1-Path-JSON: ${JSON.stringify(malformedSourcePath)}`,
        "KB1-From-Path-JSON: {",
        "KB1-Operation: move",
      ].join("\n"),
    ]);

    const nonStringRecordedPath = "notes/non-string-recorded-path.md";
    await writeFile(path.join(root, nonStringRecordedPath), "non-string path\n", "utf8");
    await git(root, ["add", "--", nonStringRecordedPath]);
    await git(root, [
      "commit",
      "-m",
      "external move with non-string encoded path",
      "-m",
      [
        "KB1-Path-JSON: null",
        "KB1-Operation: move",
      ].join("\n"),
    ]);

    const missingSourceHistory = await listFileHistory(root, {
      path: missingSourcePath,
    });
    if (!missingSourceHistory.ok) {
      throw new Error("expected missing-source history");
    }
    expect(missingSourceHistory.value.entries).toHaveLength(1);
    expect(missingSourceHistory.value.entries[0]).toMatchObject({
      path: missingSourcePath,
      operation: "move",
    });

    const invalidSourceHistory = await listFileHistory(root, {
      path: invalidSourcePath,
    });
    if (!invalidSourceHistory.ok) {
      throw new Error("expected invalid-source history");
    }
    expect(invalidSourceHistory.value.entries).toHaveLength(1);
    expect(invalidSourceHistory.value.entries[0]).toMatchObject({
      path: invalidSourcePath,
      operation: "move",
    });

    const malformedSourceHistory = await listFileHistory(root, {
      path: malformedSourcePath,
    });
    if (!malformedSourceHistory.ok) {
      throw new Error("expected malformed-source history");
    }
    expect(malformedSourceHistory.value.entries).toHaveLength(1);
    expect(malformedSourceHistory.value.entries[0]).toMatchObject({
      path: malformedSourcePath,
      operation: "move",
    });

    const nonStringRecordedPathHistory = await listFileHistory(root, {
      path: nonStringRecordedPath,
    });
    if (!nonStringRecordedPathHistory.ok) {
      throw new Error("expected non-string-recorded-path history");
    }
    expect(nonStringRecordedPathHistory.value.entries).toHaveLength(0);
  });

  it("uses structural move commits as history barriers and follows renamed files", async () => {
    const actor = {
      kind: "user" as const,
      id: "marcus",
      name: "Marcus",
      client: "browser",
    };

    await writeFileWithParents(
      path.join(root, "notes/original.md"),
      "one\n",
      "utf8",
    );
    await recordFileHistory(root, {
      path: "notes/original.md",
      operation: "create",
      actor,
      content: "one\n",
      now: new Date("2026-06-30T00:00:00.000Z"),
    });
    await flushFileHistory(root, { paths: ["notes/original.md"], now: new Date("2026-06-30T00:00:30.000Z") });
    await mkdir(path.join(root, "notes"), { recursive: true });
    await rename(path.join(root, "notes/original.md"), path.join(root, "notes/renamed.md"));
    await expect(
      moveFileHistory(root, {
        fromPath: "notes/original.md",
        toPath: "notes/renamed.md",
        actor,
        content: "one\n",
        now: new Date("2026-06-30T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        path: "notes/renamed.md",
        operation: "rename",
        actor,
        size: 4,
      },
    });
    const oldPathHistory = await listFileHistory(root, { path: "notes/original.md" });
    if (!oldPathHistory.ok) throw new Error("expected old path history page");
    expect(oldPathHistory.value.hasMore).toBe(false);
    expect(oldPathHistory.value.entries.some((entry) => entry.operation === "create" && entry.size === 4)).toBe(true);
    await expect(listFileHistory(root, { path: "notes/renamed.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [
          { path: "notes/renamed.md", operation: "rename", size: 4 },
          { path: "notes/renamed.md", operation: "create", size: 4 },
        ],
      },
    });

    await writeFileWithParents(
      path.join(root, "move/source.md"),
      "move me\n",
      "utf8",
    );
    await recordFileHistory(root, {
      path: "move/source.md",
      operation: "create",
      actor,
      content: "move me\n",
      now: new Date("2026-06-30T00:01:30.000Z"),
    });
    await flushFileHistory(root, { paths: ["move/source.md"], now: new Date("2026-06-30T00:01:35.000Z") });
    await mkdir(path.join(root, "archive"), { recursive: true });
    await rename(path.join(root, "move/source.md"), path.join(root, "archive/source.md"));
    await expect(
      moveFileHistory(root, {
        fromPath: "move/source.md",
        toPath: "archive/source.md",
        actor,
        content: "move me\n",
        now: new Date("2026-06-30T00:01:45.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { operation: "move", path: "archive/source.md" },
    });
    await expect(listFileHistory(root, { path: "archive/source.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [
          { operation: "move", actor, size: 8 },
          { operation: "create", actor, size: 8 },
        ],
      },
    });

    await writeFileWithParents(
      path.join(root, "folder-src/a.md"),
      "a\n",
      "utf8",
    );
    await writeFileWithParents(
      path.join(root, "folder-src/nested/b.md"),
      "b\n",
      "utf8",
    );
    await recordFileHistory(root, {
      path: "folder-src/a.md",
      operation: "create",
      actor,
      content: "a\n",
      now: new Date("2026-06-30T00:02:00.000Z"),
    });
    await flushFileHistory(root, { paths: ["folder-src/a.md"], now: new Date("2026-06-30T00:02:05.000Z") });
    await rename(path.join(root, "folder-src"), path.join(root, "folder-dest"));
    await expect(
      moveFolderHistory(root, {
        fromPath: "folder-src",
        toPath: "folder-dest",
        actor,
        now: new Date("2026-06-30T00:02:15.000Z"),
      }),
    ).resolves.toMatchObject({ ok: true, value: { flushed: 1 } });
    await expect(listFileHistory(root, { path: "folder-dest/a.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [
          { operation: "move", actor, size: 0 },
          { operation: "create", actor, size: 2 },
        ],
      },
    });
    await expect(listFileHistory(root, { path: "folder-dest/nested/b.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [
          { operation: "move", actor, size: 0 },
        ],
      },
    });
    await mkdir(path.join(root, "empty-folder"));
    await rename(path.join(root, "empty-folder"), path.join(root, "empty-folder-moved"));
    await expect(
      moveFolderHistory(root, {
        fromPath: "empty-folder",
        toPath: "empty-folder-moved",
        actor,
        now: new Date("2026-06-30T00:02:30.000Z"),
      }),
    ).resolves.toEqual({ ok: true, value: { flushed: 0 } });

    await expect(
      moveFileHistory(root, {
        fromPath: "../outside.md",
        toPath: "notes/nope.md",
        actor,
        content: "",
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
    await expect(
      moveFolderHistory(root, {
        fromPath: "../outside",
        toPath: "notes",
        actor,
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_path" });
  });

  it("rejects invalid history inputs and supports zero-width buckets", async () => {
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

    await writeFileWithParents(
      path.join(root, "notes/no-now.md"),
      "nowless",
      "utf8",
    );
    await recordFileHistory(root, {
      path: "notes/no-now.md",
      operation: "create",
      content: "nowless",
    });
    await expect(listFileHistory(root, { path: "notes/no-now.md" })).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ actor: { kind: "unknown" }, size: 7 }] },
    });

    await writeFileWithParents(
      path.join(root, "notes/unknown.md"),
      "unknown",
      "utf8",
    );
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
        entries: [{ actor: { kind: "unknown" }, size: 7 }],
      },
    });

    await writeFileWithParents(
      path.join(root, "notes/system.md"),
      "system",
      "utf8",
    );
    await recordFileHistory(root, {
      path: "notes/system.md",
      operation: "create",
      actor: { kind: "system" },
      content: "system",
      now: new Date("2026-06-30T01:05:00.000Z"),
    });
    await flushFileHistory(root, { paths: ["notes/system.md"], now: new Date("2026-06-30T01:06:00.000Z") });
    await expect(listFileHistory(root, { path: "notes/system.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            operation: "create",
            actor: { kind: "system" },
            contributors: [{ kind: "system" }],
          },
        ],
      },
    });
    await writeFileWithParents(
      path.join(root, "notes/external.md"),
      "external",
      "utf8",
    );
    await git(root, ["add", "--", "notes/external.md"]);
    await git(root, [
      "-c",
      "user.name=External",
      "-c",
      "user.email=external@example.test",
      "commit",
      "-m",
      "external commit",
    ]);
    await expect(listFileHistory(root, { path: "notes/external.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            operation: "update",
            actor: { kind: "unknown" },
            size: 0,
            contentHash: "",
          },
        ],
      },
    });

    const at = new Date("2026-06-30T02:00:00.000Z");
    const actor = { kind: "user" as const, id: "same", client: "browser" };

    await writeFileWithParents(path.join(root, "notes/zero.md"), "first", "utf8");
    await recordFileHistory(root, {
      path: "notes/zero.md",
      operation: "update",
      actor,
      content: "first",
      now: at,
      coalesceWindowMs: 0,
    });
    await writeFile(path.join(root, "notes/zero.md"), "second", "utf8");
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
      value: { entries: [{ size: 6 }, { size: 5 }] },
    });
    await expect(
      listFileHistory(root, {
        path: "notes/zero.md",
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

  it("creates folders idempotently and lists trees excluding internal metadata", async () => {
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
    await writeVaultFile(ctx, { path: "normal.md", content: "normal" });
    await mkdir(path.join(root, ".git", "objects", "aa"), { recursive: true });
    await writeFile(
      path.join(root, ".git", "HEAD"),
      "ref: refs/heads/main\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".git", "COMMIT_EDITMSG"),
      "internal commit\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".git", "objects", "aa", "bb.txt"),
      "internal object\n",
      "utf8",
    );
    await writeFile(path.join(root, ".gitignore"), "*\n", "utf8");
    await writeFile(path.join(root, ".gitattributes"), "* text=auto\n", "utf8");
    await writeFile(path.join(root, ".gitmodules"), "[submodule]\n", "utf8");

    const tree = await listVaultTree(ctx);
    expect(tree.ok).toBe(true);
    const paths = tree.ok
      ? tree.value.entries.map((entry) => entry.path).sort()
      : [];
    expect(paths).toEqual(["normal.md", "notes"]);
    expect(paths.some((entryPath) => entryPath.startsWith(".git"))).toBe(false);
    expect(paths.some((entryPath) => entryPath.startsWith(".gitattributes"))).toBe(false);
    await expect(listVaultTree(ctx, { under: ".git" })).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });
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
    await mkdir(path.join(root, ".git", "objects", "aa"), { recursive: true });
    await writeFile(
      path.join(root, ".git", "COMMIT_EDITMSG"),
      "internal commit\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".git", "objects", "aa", "bb.txt"),
      "internal object\n",
      "utf8",
    );

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
    expect(trashPath).toMatch(
      /^\.kb1\/trash\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}\/folder$/,
    );
    const trashBatch = trashPath?.split("/")[2];
    expect(trashBatch).not.toMatch(/[<>:"\\|?*]/);
    await expect(
      readFile(path.join(root, trashPath!, "file.md"), "utf8"),
    ).resolves.toBe("x");
  });

  it("keeps repeated soft deletes distinct even within the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:13:11.123Z"));
    try {
      await writeVaultFile(ctx, { path: "recreated.md", content: "first" });
      const first = await deleteVaultFile(ctx, { path: "recreated.md" });
      await writeVaultFile(ctx, { path: "recreated.md", content: "second" });
      const second = await deleteVaultFile(ctx, { path: "recreated.md" });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const firstTrashPath = first.ok ? first.value.trashPath : undefined;
      const secondTrashPath = second.ok ? second.value.trashPath : undefined;
      expect(firstTrashPath).toMatch(
        /^\.kb1\/trash\/2026-07-28T10-13-11\.123Z-[0-9a-f-]{36}\/recreated\.md$/,
      );
      expect(secondTrashPath).not.toBe(firstTrashPath);
      await expect(
        readFile(path.join(root, firstTrashPath!), "utf8"),
      ).resolves.toBe("first");
      await expect(
        readFile(path.join(root, secondTrashPath!), "utf8"),
      ).resolves.toBe("second");
    } finally {
      vi.useRealTimers();
    }
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
    await rm(path.join(root, ".kb1/folders.yml"), { force: true });

    await expect(
      setFolderMetadata(ctx, "notes", { color: 42 as unknown as string }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_metadata" });
    await expect(
      setFolderMetadata(ctx, "notes", { color: "amber" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_metadata" });
    await expect(
      stat(path.join(root, ".kb1", "folders.yml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly for malformed folders.yml instead of silently defaulting", async () => {
    await makeVaultFolder(ctx, "notes");
    await writeFileWithParents(
      path.join(root, ".kb1", "folders.yml"),
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
      path.join(root, ".kb1", "folders.yml"),
      content,
      "utf8",
    );
    await expect(listFolderMetadata(ctx)).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });
  });

  it("rethrows unexpected folders.yml read errors instead of converting them to defaults", async () => {
    await mkdir(path.join(root, ".kb1", "folders.yml"), { recursive: true });
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
    await mkdir(path.join(root, ".kb1", "folders.yml"), { recursive: true });
    try {
      await expect(
        Promise.all([
          setFolderMetadata(ctx, "notes", { color: CORAL }),
          setFolderMetadata(ctx, "notes", { color: MINT }),
        ]),
      ).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      await rm(path.join(root, ".kb1", "folders.yml"), {
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
          path.join(tmpdir(), "kb1-vault-core-metadata-property-"),
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
          const before = "__KB1_LEFT__";
          const after = "__KB1_RIGHT__";
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
    root = await mkdtemp(path.join(tmpdir(), "kb1-search-"));
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
      path.join(root, ".kb1", "audit", "hidden.md"),
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
    await mkdir(path.join(root, ".git", "objects", "aa"), { recursive: true });
    await writeFile(
      path.join(root, ".git", "COMMIT_EDITMSG"),
      "target internal commit\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".git", "objects", "aa", "bb.txt"),
      "target internal object\n",
      "utf8",
    );
    await writeFile(path.join(root, ".gitignore"), "target ignored\n", "utf8");
    await writeFile(
      path.join(root, ".gitattributes"),
      "target attributes\n",
      "utf8",
    );

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
    expect(result.results.some((hit) => hit.path.startsWith(".git"))).toBe(
      false,
    );
    expect(
      result.results.every(
        (hit) =>
          hit.context.before.length === 0 && hit.context.after.length === 0,
      ),
    ).toBe(true);
  });

  it("caps the searchable file walk before unbounded scans", async () => {
    const cappedRoot = await mkdtemp(path.join(tmpdir(), "kb1-search-cap-"));
    const nestedRoot = await mkdtemp(
      path.join(tmpdir(), "kb1-search-nested-cap-"),
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
  }, 20_000);

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
          path.join(tmpdir(), "kb1-search-property-"),
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
    path.join(root, ".kb1/audit/changes.jsonl"),
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
  const raw = await readFile(path.join(root, ".kb1/folders.yml"), "utf8");
  return { raw, parsed: parseYaml(raw) };
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }) as { stdout: string; stderr: string };
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
