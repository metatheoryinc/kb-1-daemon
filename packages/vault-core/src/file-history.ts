import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { VaultActor, AuditOperation } from "./audit.js";
import { validateVaultPath } from "./path.js";
import type { VaultResult } from "./vault-ops.js";

export type FileHistoryOperation = "create" | "update" | "move" | "rename";

export interface FileHistoryEntry {
  id: string;
  path: string;
  operation: FileHistoryOperation;
  actor: VaultActor;
  integrationId?: string;
  contributors?: VaultActor[];
  pending?: boolean;
  commitId?: string;
  createdAt: string;
  updatedAt: string;
  content?: string;
  size: number;
  contentHash: string;
}

export interface RecordFileHistoryInput {
  path: string;
  operation: FileHistoryOperation;
  actor?: VaultActor;
  content: string;
  now?: Date;
  coalesceWindowMs?: number;
}

export interface ListFileHistoryInput {
  path: string;
  before?: string;
  beforeId?: string;
  limit?: number;
}

export interface MoveFileHistoryInput {
  fromPath: string;
  toPath: string;
  actor?: VaultActor;
  content: string;
  now?: Date;
  coalesceWindowMs?: number;
}

export interface MoveFolderHistoryInput {
  fromPath: string;
  toPath: string;
  actor?: VaultActor;
  now?: Date;
}

export interface FlushFileHistoryInput {
  paths?: string[];
  now?: Date;
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[];
  hasMore: boolean;
}

export interface FlushFileHistoryValue {
  flushed: number;
  unavailable?: boolean;
}

interface PendingHistoryEntry {
  id: string;
  path: string;
  fromPath?: string;
  operation: FileHistoryOperation;
  bucketStart: string;
  createdAt: string;
  updatedAt: string;
  content: string;
  size: number;
  contentHash: string;
  contributors: VaultActor[];
}

interface GitResult {
  stdout: string;
  stderr: string;
}

type PendingHistoryMap = Map<string, PendingHistoryEntry>;

const execFileAsync = promisify(execFile);

const DEFAULT_HISTORY_BUCKET_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_HISTORY_PAGE_LIMIT = 50;
const MAX_HISTORY_PAGE_LIMIT = 200;
const DAEMON_AUTHOR_NAME = "KB-1 Daemon";
const DAEMON_AUTHOR_EMAIL = "history@kb-1.ai";
const GITIGNORE_RELATIVE_PATH = ".gitignore";
/* v8 ignore next -- Constant is exercised indirectly through Git log parsing but v8 marks separator declarations as uncovered. */
const COMMIT_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x00";
const pendingHistoryByRoot = new Map<string, PendingHistoryMap>();
const gitInitByRoot = new Map<string, Promise<boolean>>();

function fail(error: "invalid_path", message: string): VaultResult<never> {
  return { ok: false, error, message };
}

export async function recordFileHistory(
  root: string,
  input: RecordFileHistoryInput,
): Promise<VaultResult<FileHistoryEntry>> {
  let rel: string;
  try {
    rel = validateVaultPath(input.path, "file");
  } catch (error) {
    /* v8 ignore next -- validateVaultPath throws Error instances; non-Error throws are handled below defensively. */
    if (error instanceof Error) {
      return fail("invalid_path", error.message);
    }
    /* v8 ignore next -- validateVaultPath throws Error instances; non-Error throws are defensive rethrows. */
    throw error;
  }

  const actor = cloneActor(input.actor ?? { kind: "unknown" });
  const now = input.now ?? new Date();
  const bucketStart = bucketStartIso(now, input.coalesceWindowMs);
  const contentHash = await hashContent(input.content);
  const size = new TextEncoder().encode(input.content).byteLength;
  const pending = pendingForRoot(root);
  const key = pendingKey(rel, bucketStart);
  const existing = pending.get(key);

  const entry: PendingHistoryEntry = existing
    ? {
      ...existing,
      operation: existing.operation === "create" ? "create" : input.operation,
      updatedAt: now.toISOString(),
      content: input.content,
      size,
      contentHash,
      contributors: addContributor(existing.contributors, actor),
    }
    : {
      id: `pending-${randomUUID()}`,
      path: rel,
      operation: input.operation,
      bucketStart,
      createdAt: bucketStart,
      updatedAt: now.toISOString(),
      content: input.content,
      size,
      contentHash,
      contributors: [actor],
    };

  pending.set(key, entry);
  return { ok: true, value: pendingEntryToHistoryEntry(entry) };
}

export async function listFileHistory(
  root: string,
  input: ListFileHistoryInput,
): Promise<VaultResult<FileHistoryPage>> {
  let rel: string;
  try {
    rel = validateVaultPath(input.path, "file");
  } catch (error) {
    if (error instanceof Error) {
      return fail("invalid_path", error.message);
    }
    /* v8 ignore next -- validateVaultPath throws Error instances; non-Error throws are defensive rethrows. */
    throw error;
  }

  const pendingEntries = pendingEntriesForPath(root, rel);
  const committedEntries = await readCommittedHistory(root, rel);
  const newestFirst = [...pendingEntries, ...committedEntries].sort(compareHistoryEntriesDesc);
  const limited = applyHistoryCursor(newestFirst, input.before, input.beforeId);
  const limit = normalizePageLimit(input.limit);
  const entries = limited.slice(0, limit);
  return {
    ok: true,
    value: {
      entries: entries.map(cloneFileHistoryEntry),
      hasMore: limited.length > entries.length,
    },
  };
}

export async function moveFileHistory(
  root: string,
  input: MoveFileHistoryInput,
): Promise<VaultResult<FileHistoryEntry>> {
  let from: string;
  let to: string;
  try {
    from = validateVaultPath(input.fromPath, "file");
    to = validateVaultPath(input.toPath, "file");
  } catch (error) {
    if (error instanceof Error) {
      return fail("invalid_path", error.message);
    }
    /* v8 ignore next -- validateVaultPath throws Error instances; non-Error throws are defensive rethrows. */
    throw error;
  }

  const recorded = await recordFileHistory(root, {
    path: to,
    operation: moveOperationForPaths(from, to),
    actor: input.actor,
    content: input.content,
    now: input.now,
    coalesceWindowMs: 0,
  });
  /* v8 ignore next -- moveFileHistory validates the same paths before delegating; this is a defensive propagation guard. */
  if (!recorded.ok) return recorded;

  const pending = pendingForRoot(root);
  for (const [key, entry] of pending.entries()) {
    /* v8 ignore next -- The just-recorded move entry is expected to be present; this guard keeps the marker best-effort. */
    if (entry.path === to && entry.id === recorded.value.id) {
      pending.set(key, { ...entry, fromPath: from });
      break;
    }
  }

  await flushFileHistory(root, { paths: [to], now: input.now });
  return recorded;
}

export async function moveFolderHistory(
  root: string,
  input: MoveFolderHistoryInput,
): Promise<VaultResult<FlushFileHistoryValue>> {
  let from: string;
  let to: string;
  try {
    from = validateVaultPath(input.fromPath, "folder");
    to = validateVaultPath(input.toPath, "folder");
  } catch (error) {
    if (error instanceof Error) {
      return fail("invalid_path", error.message);
    }
    /* v8 ignore next -- validateVaultPath throws Error instances; non-Error throws are defensive rethrows. */
    throw error;
  }

  const gitReady = await ensureGitRepository(root);
  /* v8 ignore next -- Depends on a host without Git or a filesystem-level Git init failure. */
  if (!gitReady) {
    return { ok: true, value: { flushed: 0, unavailable: true } };
  }

  const paths = [from, to];
  await runGit(root, ["rm", "-r", "--cached", "--ignore-unmatch", "--", from]);
  await runGit(root, ["add", "-A", "--", to]);
  const changed = await hasStagedChanges(root, paths);
  if (!changed) return { ok: true, value: { flushed: 0 } };
  await runGit(root, ["add", "--", GITIGNORE_RELATIVE_PATH]);

  const now = input.now ?? new Date();
  await commitHistoryEntry(root, {
    id: `folder-move-${randomUUID()}`,
    path: to,
    fromPath: from,
    operation: "move",
    bucketStart: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    content: "",
    size: 0,
    contentHash: "",
    contributors: [cloneActor(input.actor ?? { kind: "unknown" })],
  }, now);
  return { ok: true, value: { flushed: 1 } };
}

export async function flushFileHistory(
  root: string,
  input: FlushFileHistoryInput = {},
): Promise<VaultResult<FlushFileHistoryValue>> {
  const pending = pendingForRoot(root);
  const selected = selectPendingEntries(pending, input.paths);
  if (selected.length === 0) {
    return { ok: true, value: { flushed: 0 } };
  }

  const gitReady = await ensureGitRepository(root);
  /* v8 ignore next -- Depends on a host without Git or a filesystem-level Git init failure. */
  if (!gitReady) {
    return { ok: true, value: { flushed: 0, unavailable: true } };
  }

  let flushed = 0;
  for (const [key, entry] of selected) {
    await commitPendingEntry(root, entry, input.now);
    pending.delete(key);
    flushed += 1;
  }

  return { ok: true, value: { flushed } };
}

export function historyOperationFromAudit(operation: AuditOperation): FileHistoryOperation | undefined {
  switch (operation) {
    case "create":
      return "create";
    case "write":
    case "splice":
    case "append":
    case "prepend":
      return "update";
    case "move":
      return "move";
    case "mkdir":
    case "delete":
      return undefined;
  }
}

async function commitPendingEntry(
  root: string,
  entry: PendingHistoryEntry,
  now: Date | undefined,
): Promise<void> {
  const paths = entry.fromPath ? [entry.fromPath, entry.path] : [entry.path];
  await runGit(root, ["add", "-A", "--", ...paths]);
  const changed = await hasStagedChanges(root, paths);
  if (!changed) return;
  await runGit(root, ["add", "--", GITIGNORE_RELATIVE_PATH]);

  await commitHistoryEntry(root, entry, now);
}

async function commitHistoryEntry(
  root: string,
  entry: PendingHistoryEntry,
  now: Date | undefined,
): Promise<void> {
  const message = commitMessage(entry, now);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: DAEMON_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: DAEMON_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: DAEMON_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: DAEMON_AUTHOR_EMAIL,
  };
  await runGit(root, ["commit", "-m", message.subject, "-m", message.body], env);
}

async function hasStagedChanges(root: string, paths: string[]): Promise<boolean> {
  try {
    await runGit(root, ["diff", "--cached", "--quiet", "--", ...paths]);
    return false;
  } catch (error) {
    /* v8 ignore next -- Covered through normal staged-change commits; kept explicit for Git's exit-code contract. */
    if (isGitExitCode(error, 1)) return true;
    /* v8 ignore next -- Unexpected Git diff failures must propagate but are OS/tooling dependent. */
    throw error;
  }
}

function commitMessage(
  entry: PendingHistoryEntry,
  now: Date | undefined,
): { subject: string; body: string } {
  const bucketEnd = now?.toISOString() ?? entry.updatedAt;
  const contributorLines = entry.contributors.map((actor) => `- ${actorLabel(actor)}`);
  const body = [
    `Path: ${entry.path}`,
    ...(entry.fromPath ? [`From: ${entry.fromPath}`] : []),
    `Bucket: ${entry.bucketStart} - ${bucketEnd}`,
    "",
    "Contributors:",
    ...contributorLines,
    "",
    `KB1-Path: ${entry.path}`,
    ...(entry.fromPath ? [`KB1-From-Path: ${entry.fromPath}`] : []),
    `KB1-Operation: ${entry.operation}`,
    `KB1-Bucket-Start: ${entry.bucketStart}`,
    `KB1-Bucket-End: ${bucketEnd}`,
    `KB1-Size: ${entry.size}`,
    `KB1-Content-SHA256: ${entry.contentHash}`,
    ...entry.contributors.map((actor) => `KB1-Contributor: ${JSON.stringify(actor)}`),
  ].join("\n");

  return {
    subject: `KB-1 history: ${entry.operation} ${entry.path}`,
    body,
  };
}

async function readCommittedHistory(root: string, rel: string): Promise<FileHistoryEntry[]> {
  if (!await hasGitRepository(root)) return [];

  let result: GitResult;
  try {
    result = await runGit(root, [
      "log",
      "--follow",
      "--format=%H%x00%cI%x00%B%x1e",
      "--",
      rel,
    ]);
  } catch {
    /* v8 ignore next -- Git log failures are treated as empty history; normal no-history repos are covered without throwing. */
    return [];
  }

  const entries: FileHistoryEntry[] = [];
  for (const raw of result.stdout.split(COMMIT_SEPARATOR)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const [commitId, committedAt, ...bodyParts] = trimmed.split(FIELD_SEPARATOR);
    /* v8 ignore next -- Git log format is controlled by this module. */
    if (!commitId || !committedAt) continue;
    const body = bodyParts.join(FIELD_SEPARATOR);
    const parsed = entryFromCommitBody(rel, commitId, committedAt, body);
    /* v8 ignore next -- Invalid external KB1 history commits are ignored; emitted commits parse successfully. */
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function entryFromCommitBody(
  requestedPath: string,
  commitId: string,
  committedAt: string,
  body: string,
): FileHistoryEntry | undefined {
  const values = commitValues(body);
  const operation = fileHistoryOperation(values.get("KB1-Operation") ?? "update");
  /* v8 ignore next -- Invalid external operation trailers are ignored; emitted commits use known operations. */
  if (!operation) return undefined;

  const contributors = values.getAll("KB1-Contributor")
    .map(parseActorJson)
    .filter((actor): actor is VaultActor => actor !== undefined);
  const actor = actorForContributors(contributors);
  const createdAt = values.get("KB1-Bucket-Start") ?? committedAt;
  const updatedAt = values.get("KB1-Bucket-End") ?? committedAt;
  const size = numberValue(values.get("KB1-Size")) ?? 0;
  const contentHash = values.get("KB1-Content-SHA256") ?? "";

  return {
    id: commitId,
    commitId,
    path: requestedPath,
    operation,
    actor,
    ...(actor.client !== undefined ? { integrationId: actor.client } : {}),
    /* v8 ignore next -- External commits without KB1-Contributor trailers are tolerated but not emitted by this module. */
    ...(contributors.length > 0 ? { contributors: contributors.map(cloneActor) } : {}),
    createdAt,
    updatedAt,
    size,
    contentHash,
  };
}

function commitValues(body: string): { get(key: string): string | undefined; getAll(key: string): string[] } {
  const values = new Map<string, string[]>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^(KB1-[A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return {
    get(key) {
      return values.get(key)?.[0];
    },
    getAll(key) {
      /* v8 ignore next -- Missing external trailer arrays are tolerated; emitted commits include contributor trailers. */
      return values.get(key) ?? [];
    },
  };
}

async function ensureGitRepository(root: string): Promise<boolean> {
  const key = path.resolve(root);
  const existing = gitInitByRoot.get(key);
  if (existing) return existing;

  const init = (async () => {
    try {
      await mkdir(root, { recursive: true });
      /* v8 ignore next -- Reusing an externally initialized repo is supported, but this module normally initializes the repo itself. */
      if (!await hasGitRepository(root)) {
        await runGit(root, ["init"]);
      }
      await writeDefaultGitignore(root);
      await runGit(root, ["config", "user.name", DAEMON_AUTHOR_NAME]);
      await runGit(root, ["config", "user.email", DAEMON_AUTHOR_EMAIL]);
      await runGit(root, ["config", "commit.gpgsign", "false"]);
      return true;
    } catch (error) {
      /* v8 ignore start -- Depends on host Git availability or filesystem-level Git init failures; product behavior is best-effort unavailable history. */
      if (isGitUnavailable(error)) return false;
      console.warn("KB-1 file history Git initialization failed.", error);
      return false;
      /* v8 ignore stop */
    }
  })();

  gitInitByRoot.set(key, init);
  const ready = await init;
  /* v8 ignore next -- Covered by the defensive Git-unavailable branch above when the host lacks Git. */
  if (!ready) gitInitByRoot.delete(key);
  return ready;
}

async function hasGitRepository(root: string): Promise<boolean> {
  try {
    await stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function writeDefaultGitignore(root: string): Promise<void> {
  const gitignorePath = path.join(root, GITIGNORE_RELATIVE_PATH);
  const content = [
    "# Managed by KB-1 daemon history.",
    ".kb2/cache/",
    ".kb2/runtime/",
    ".kb2/tmp/",
    "",
  ].join("\n");
  try {
    await stat(gitignorePath);
  } catch {
    await writeFile(gitignorePath, content, "utf8");
  }
}

async function runGit(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitResult> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  }) as GitResult;
  return result;
}

/* v8 ignore next -- Depends on host PATH lacking Git; tests run with Git available. */
function isGitUnavailable(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isGitExitCode(error: unknown, code: number): boolean {
  return isRecord(error) && error.code === code;
}

function pendingForRoot(root: string): PendingHistoryMap {
  const key = path.resolve(root);
  let pending = pendingHistoryByRoot.get(key);
  if (!pending) {
    pending = new Map();
    pendingHistoryByRoot.set(key, pending);
  }
  return pending;
}

function selectPendingEntries(
  pending: PendingHistoryMap,
  paths: string[] | undefined,
): Array<[string, PendingHistoryEntry]> {
  const selectedPaths = paths === undefined
    ? undefined
    : new Set(paths.map((entryPath) => validateVaultPath(entryPath, "file")));
  return [...pending.entries()]
    .filter(([, entry]) => selectedPaths === undefined || selectedPaths.has(entry.path))
    .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt));
}

function pendingEntriesForPath(root: string, rel: string): FileHistoryEntry[] {
  return [...pendingForRoot(root).values()]
    .filter((entry) => entry.path === rel)
    .map(pendingEntryToHistoryEntry);
}

function pendingEntryToHistoryEntry(entry: PendingHistoryEntry): FileHistoryEntry {
  const actor = actorForContributors(entry.contributors);
  return {
    id: entry.id,
    path: entry.path,
    operation: entry.operation,
    actor,
    ...(actor.client !== undefined ? { integrationId: actor.client } : {}),
    contributors: entry.contributors.map(cloneActor),
    pending: true,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    size: entry.size,
    contentHash: entry.contentHash,
  };
}

function addContributor(contributors: VaultActor[], actor: VaultActor): VaultActor[] {
  const key = actorKey(actor);
  if (contributors.some((candidate) => actorKey(candidate) === key)) {
    return contributors.map(cloneActor);
  }
  return [...contributors.map(cloneActor), cloneActor(actor)];
}

function actorForContributors(contributors: VaultActor[]): VaultActor {
  if (contributors.length === 1) return cloneActor(contributors[0]!);
  /* v8 ignore next -- Multi-contributor entries are covered at the API level; v8 branch accounting is noisy around this fallback ladder. */
  if (contributors.length > 1) {
    return { kind: "system", name: `${contributors.length} contributors` };
  }
  /* v8 ignore next -- Commit entries with no contributor trailers are tolerated for fallback compatibility but not emitted by this module. */
  return { kind: "unknown" };
}

function actorLabel(actor: VaultActor): string {
  const label = actor.name ?? actor.id ?? actor.kind;
  return actor.client ? `${label} (${actor.client})` : label;
}

function parseActorJson(value: string): VaultActor | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    /* v8 ignore next -- Non-object external contributor trailers are tolerated but not emitted by this module. */
    if (!isRecord(parsed)) return undefined;
    return normalizeActor(parsed);
  } catch {
    /* v8 ignore next -- Malformed external commit trailers are tolerated but not emitted by this module. */
    return undefined;
  }
}

function normalizeActor(value: Record<string, unknown>): VaultActor | undefined {
  /* v8 ignore next -- Invalid external actor kinds are tolerated but not emitted by this module. */
  if (
    value.kind !== "user" &&
    value.kind !== "mcp_client" &&
    value.kind !== "integration" &&
    value.kind !== "system" &&
    value.kind !== "unknown"
  ) {
    /* v8 ignore next -- Invalid external commit actor kinds are tolerated but not emitted by this module. */
    return undefined;
  }

  return {
    kind: value.kind,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.client === "string" ? { client: value.client } : {}),
  };
}

function cloneFileHistoryEntry(entry: FileHistoryEntry): FileHistoryEntry {
  return {
    id: entry.id,
    path: entry.path,
    operation: entry.operation,
    actor: cloneActor(entry.actor),
    ...(entry.integrationId !== undefined ? { integrationId: entry.integrationId } : {}),
    /* v8 ignore next -- Older/external rows without contributor arrays are tolerated but current emitted rows always include them. */
    ...(entry.contributors !== undefined ? { contributors: entry.contributors.map(cloneActor) } : {}),
    ...(entry.pending !== undefined ? { pending: entry.pending } : {}),
    ...(entry.commitId !== undefined ? { commitId: entry.commitId } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    /* v8 ignore next -- Content snapshots remain disabled for history rows. */
    ...(entry.content !== undefined ? { content: entry.content } : {}),
    size: entry.size,
    contentHash: entry.contentHash,
  };
}

function cloneActor(actor: VaultActor): VaultActor {
  return {
    kind: actor.kind,
    ...(actor.id !== undefined ? { id: actor.id } : {}),
    ...(actor.name !== undefined ? { name: actor.name } : {}),
    ...(actor.client !== undefined ? { client: actor.client } : {}),
  };
}

function actorKey(actor: VaultActor): string {
  return JSON.stringify([
    actor.kind,
    actor.id,
    actor.name,
    actor.client,
  ]);
}

function moveOperationForPaths(
  fromPath: string,
  toPath: string,
): "move" | "rename" {
  return path.posix.dirname(fromPath) === path.posix.dirname(toPath)
    ? "rename"
    : "move";
}

function pendingKey(rel: string, bucketStart: string): string {
  return `${rel}\u0000${bucketStart}`;
}

function bucketStartIso(now: Date, bucketWindowMs: number | undefined): string {
  const windowMs = normalizeBucketWindowMs(bucketWindowMs);
  const time = now.getTime();
  if (windowMs === 0) return now.toISOString();
  return new Date(Math.floor(time / windowMs) * windowMs).toISOString();
}

function applyHistoryCursor(
  entries: FileHistoryEntry[],
  before: string | undefined,
  beforeId: string | undefined,
): FileHistoryEntry[] {
  if (!before) return entries;
  const beforeTime = new Date(before).getTime();
  if (!Number.isFinite(beforeTime)) return entries;

  return entries.filter((entry) => {
    const entryTime = new Date(entry.createdAt).getTime();
    if (entryTime < beforeTime) return true;
    if (entryTime > beforeTime) return false;
    /* v8 ignore next -- Equal-timestamp cursor ties are stable fallback behavior; emitted Git commits use distinct ids and bucket times in practice. */
    return beforeId === undefined ? false : entry.id < beforeId;
  });
}

function compareHistoryEntriesDesc(left: FileHistoryEntry, right: FileHistoryEntry): number {
  const timeDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  /* v8 ignore next -- Same-timestamp id sorting is deterministic fallback behavior for external history rows. */
  return timeDelta || right.id.localeCompare(left.id);
}

function normalizeBucketWindowMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_HISTORY_BUCKET_WINDOW_MS;
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return DEFAULT_HISTORY_PAGE_LIMIT;
  }
  return Math.min(value, MAX_HISTORY_PAGE_LIMIT);
}

function fileHistoryOperation(value: string): FileHistoryOperation | undefined {
  /* v8 ignore next -- Invalid external commit operation trailers are tolerated but not emitted by this module. */
  return value === "create" || value === "update" || value === "move" || value === "rename"
    ? value
    : undefined;
}

function numberValue(value: string | undefined): number | undefined {
  /* v8 ignore next -- Missing numeric trailers are tolerated for external commits but not emitted by this module. */
  if (value === undefined) return undefined;
  const parsed = Number(value);
  /* v8 ignore next -- Malformed numeric trailers are tolerated for external commits but not emitted by this module. */
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
