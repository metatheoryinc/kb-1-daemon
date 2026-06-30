import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { VaultActor, AuditOperation } from "./audit.js";
import { isNodeError } from "./fs.js";
import { resolveVaultPath, validateVaultPath } from "./path.js";
import type { VaultResult } from "./vault-ops.js";

export type FileHistoryOperation = "create" | "update" | "move" | "rename";

export interface FileHistoryEntry {
  id: string;
  path: string;
  operation: FileHistoryOperation;
  actor: VaultActor;
  integrationId?: string;
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
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[];
  hasMore: boolean;
}

type FileHistoryMap = Record<string, FileHistoryEntry[]>;

const FILE_HISTORY_RELATIVE_PATH = path.posix.join(".kb2", "file-history.yml");
const DEFAULT_HISTORY_COALESCE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_HISTORY_PAGE_LIMIT = 50;
const MAX_HISTORY_PAGE_LIMIT = 200;
const FILE_HISTORY_CONTENT_SNAPSHOTS_ENABLED = false;
const fileHistoryMutationQueues = new Map<string, Promise<void>>();

function ignoreMutationQueueResult(): void {
  return undefined;
}

function fail(error: "invalid_path" | "invalid_metadata" | "metadata_parse_failed", message: string): VaultResult<never> {
  return { ok: false, error, message };
}

function metadataFileFailure(
  message = "file history metadata file is malformed",
): VaultResult<never> {
  return fail("metadata_parse_failed", message);
}

function fileHistoryPath(root: string): string {
  return resolveVaultPath(root, FILE_HISTORY_RELATIVE_PATH);
}

async function withFileHistoryMutation<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(root);
  const previous = fileHistoryMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const next = run.then(ignoreMutationQueueResult, ignoreMutationQueueResult);
  fileHistoryMutationQueues.set(key, next);

  try {
    return await run;
  } finally {
    if (fileHistoryMutationQueues.get(key) === next) {
      fileHistoryMutationQueues.delete(key);
    }
  }
}

export async function recordFileHistory(
  root: string,
  input: RecordFileHistoryInput,
): Promise<VaultResult<FileHistoryEntry>> {
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

  return await withFileHistoryMutation(root, async () => {
    const map = await readFileHistoryMap(root);
    if (!map.ok) return map;

    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const existingEntries = map.value[rel] ?? [];
    const actor = cloneActor(input.actor ?? { kind: "unknown" });
    const integrationId = integrationIdForActor(actor);
    const contentHash = await hashContent(input.content);
    const size = new TextEncoder().encode(input.content).byteLength;
    const coalesceWindowMs = normalizeCoalesceWindowMs(input.coalesceWindowMs);
    const previous = existingEntries.at(-1);

    let entry: FileHistoryEntry;
    if (
      previous &&
      sameActorAndIntegration(previous, actor, integrationId) &&
      now.getTime() - new Date(previous.updatedAt).getTime() <= coalesceWindowMs
    ) {
      entry = {
        id: previous.id,
        path: rel,
        operation: previous.operation,
        actor: cloneActor(previous.actor),
        ...(previous.integrationId !== undefined ? { integrationId: previous.integrationId } : {}),
        createdAt: previous.createdAt,
        size,
        contentHash,
        updatedAt: nowIso,
        ...contentSnapshot(input.content),
      };
      existingEntries[existingEntries.length - 1] = entry;
    } else {
      entry = {
        id: randomUUID(),
        path: rel,
        operation: input.operation,
        actor,
        ...(integrationId !== undefined ? { integrationId } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
        ...contentSnapshot(input.content),
        size,
        contentHash,
      };
      existingEntries.push(entry);
    }

    await writeFileHistoryMap(root, { ...map.value, [rel]: existingEntries });
    return { ok: true, value: cloneFileHistoryEntry(entry) };
  });
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

  const map = await readFileHistoryMap(root);
  if (!map.ok) return map;

  const newestFirst = [...(map.value[rel] ?? [])].sort(compareHistoryEntriesDesc);
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

  return await withFileHistoryMutation(root, async () => {
    const map = await readFileHistoryMap(root);
    if (!map.ok) return map;

    const movedEntries = (map.value[from] ?? []).map((entry) => ({
      ...entry,
      path: to,
    }));
    const actor = cloneActor(input.actor ?? { kind: "unknown" });
    const integrationId = integrationIdForActor(actor);
    const nowIso = (input.now ?? new Date()).toISOString();
    const contentHash = await hashContent(input.content);
    const size = new TextEncoder().encode(input.content).byteLength;
    const entry: FileHistoryEntry = {
      id: randomUUID(),
      path: to,
      operation: moveOperationForPaths(from, to),
      actor,
      ...(integrationId !== undefined ? { integrationId } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      ...contentSnapshot(input.content),
      size,
      contentHash,
    };

    const nextMap = { ...map.value };
    delete nextMap[from];
    nextMap[to] = [...movedEntries, entry];
    await writeFileHistoryMap(root, nextMap);
    return { ok: true, value: cloneFileHistoryEntry(entry) };
  });
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

async function readFileHistoryMap(
  root: string,
): Promise<VaultResult<FileHistoryMap>> {
  let content: string;
  try {
    content = await readFile(fileHistoryPath(root), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: true, value: {} };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return metadataFileFailure();
  }

  if (!isRecord(parsed) || !isRecord(parsed.files)) {
    return metadataFileFailure();
  }

  const map: FileHistoryMap = {};
  for (const [filePath, rawEntries] of Object.entries(parsed.files)) {
    try {
      validateVaultPath(filePath, "file");
    } catch {
      return metadataFileFailure();
    }

    if (!Array.isArray(rawEntries)) return metadataFileFailure();
    const entries: FileHistoryEntry[] = [];
    for (const rawEntry of rawEntries) {
      const normalized = normalizeFileHistoryEntry(filePath, rawEntry);
      if (!normalized.ok) return normalized;
      entries.push(normalized.value);
    }
    if (entries.length > 0) {
      map[filePath] = entries;
    }
  }

  return { ok: true, value: map };
}

async function writeFileHistoryMap(
  root: string,
  history: FileHistoryMap,
): Promise<void> {
  const filePath = fileHistoryPath(root);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const sortedFiles = Object.fromEntries(
    Object.entries(history)
      .filter(([, entries]) => entries.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, entries]) => [filePath, entries.map(serializedEntry)]),
  );
  const content = stringifyYaml({ files: sortedFiles });
  const temporaryPath = path.join(
    directory,
    `.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    /* v8 ignore start -- Cleanup runs only after an atomic-write filesystem failure; success-path durability is covered by raw file-history.yml assertions. */
    await rm(temporaryPath, { force: true });
    throw error;
    /* v8 ignore stop */
  }
}

function normalizeFileHistoryEntry(
  filePath: string,
  value: unknown,
): VaultResult<FileHistoryEntry> {
  if (!isRecord(value)) return metadataFileFailure();
  if (
    typeof value.id !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.size !== "number" ||
    typeof value.contentHash !== "string" ||
    !isFileHistoryOperation(value.operation) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !isRecord(value.actor)
  ) {
    return metadataFileFailure();
  }

  const actor = normalizeActor(value.actor);
  if (!actor.ok) return actor;
  if (value.integrationId !== undefined && typeof value.integrationId !== "string") {
    return metadataFileFailure();
  }
  if (value.content !== undefined && typeof value.content !== "string") {
    return metadataFileFailure();
  }

  return {
    ok: true,
    value: {
      id: value.id,
      path: filePath,
      operation: value.operation,
      actor: actor.value,
      ...(typeof value.integrationId === "string" ? { integrationId: value.integrationId } : {}),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(typeof value.content === "string" ? { content: value.content } : {}),
      size: value.size,
      contentHash: value.contentHash,
    },
  };
}

function normalizeActor(value: Record<string, unknown>): VaultResult<VaultActor> {
  if (
    value.kind !== "user" &&
    value.kind !== "mcp_client" &&
    value.kind !== "integration" &&
    value.kind !== "system" &&
    value.kind !== "unknown"
  ) {
    return metadataFileFailure();
  }

  const id = optionalString(value, "id");
  if (!id.ok) return id;
  const name = optionalString(value, "name");
  if (!name.ok) return name;
  const client = optionalString(value, "client");
  if (!client.ok) return client;

  return {
    ok: true,
    value: {
      kind: value.kind,
      ...(id.value !== undefined ? { id: id.value } : {}),
      ...(name.value !== undefined ? { name: name.value } : {}),
      ...(client.value !== undefined ? { client: client.value } : {}),
    },
  };
}

function optionalString(
  value: Record<string, unknown>,
  key: "id" | "name" | "client",
): VaultResult<string | undefined> {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return { ok: true, value: undefined };
  }
  return typeof value[key] === "string"
    ? { ok: true, value: value[key] }
    : metadataFileFailure();
}

function serializedEntry(entry: FileHistoryEntry): Omit<FileHistoryEntry, "path"> {
  return {
    id: entry.id,
    operation: entry.operation,
    actor: cloneActor(entry.actor),
    ...(entry.integrationId !== undefined ? { integrationId: entry.integrationId } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(FILE_HISTORY_CONTENT_SNAPSHOTS_ENABLED && entry.content !== undefined
      ? { content: entry.content }
      : {}),
    size: entry.size,
    contentHash: entry.contentHash,
  };
}

function cloneFileHistoryEntry(entry: FileHistoryEntry): FileHistoryEntry {
  return {
    id: entry.id,
    path: entry.path,
    operation: entry.operation,
    actor: cloneActor(entry.actor),
    ...(entry.integrationId !== undefined ? { integrationId: entry.integrationId } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.content !== undefined ? { content: entry.content } : {}),
    size: entry.size,
    contentHash: entry.contentHash,
  };
}

function contentSnapshot(content: string): Partial<Pick<FileHistoryEntry, "content">> {
  return FILE_HISTORY_CONTENT_SNAPSHOTS_ENABLED ? { content } : {};
}

function cloneActor(actor: VaultActor): VaultActor {
  return {
    kind: actor.kind,
    ...(actor.id !== undefined ? { id: actor.id } : {}),
    ...(actor.name !== undefined ? { name: actor.name } : {}),
    ...(actor.client !== undefined ? { client: actor.client } : {}),
  };
}

function sameActorAndIntegration(
  entry: FileHistoryEntry,
  actor: VaultActor,
  integrationId: string | undefined,
): boolean {
  return actorKey(entry.actor) === actorKey(actor) && (entry.integrationId ?? "") === (integrationId ?? "");
}

function actorKey(actor: VaultActor): string {
  return JSON.stringify([
    actor.kind,
    actor.id ?? "",
    actor.name ?? "",
  ]);
}

function integrationIdForActor(actor: VaultActor): string | undefined {
  return actor.client;
}

function moveOperationForPaths(
  fromPath: string,
  toPath: string,
): "move" | "rename" {
  return path.posix.dirname(fromPath) === path.posix.dirname(toPath)
    ? "rename"
    : "move";
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
    return beforeId === undefined ? false : entry.id < beforeId;
  });
}

function compareHistoryEntriesDesc(left: FileHistoryEntry, right: FileHistoryEntry): number {
  const timeDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  return timeDelta || right.id.localeCompare(left.id);
}

function normalizeCoalesceWindowMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_HISTORY_COALESCE_WINDOW_MS;
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return DEFAULT_HISTORY_PAGE_LIMIT;
  }
  return Math.min(value, MAX_HISTORY_PAGE_LIMIT);
}

function isFileHistoryOperation(value: string): value is FileHistoryOperation {
  return value === "create" || value === "update" || value === "move" || value === "rename";
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
