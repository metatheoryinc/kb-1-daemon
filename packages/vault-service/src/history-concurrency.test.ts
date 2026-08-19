import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentSessionManager } from "@kb-1/doc-session";

const historyControl = vi.hoisted(() => ({
  moveRunning: false,
  concurrentFlushes: 0,
  flushCalls: 0,
  moveStarted: undefined as (() => void) | undefined,
  releaseMove: Promise.resolve() as Promise<void>,
}));

vi.mock("@kb-1/vault-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kb-1/vault-core")>();
  return {
    ...actual,
    moveFileHistory: async (...args: Parameters<typeof actual.moveFileHistory>) => {
      historyControl.moveRunning = true;
      historyControl.moveStarted?.();
      await historyControl.releaseMove;
      try {
        return await actual.moveFileHistory(...args);
      } finally {
        historyControl.moveRunning = false;
      }
    },
    flushFileHistory: async (...args: Parameters<typeof actual.flushFileHistory>) => {
      historyControl.flushCalls += 1;
      if (historyControl.moveRunning) historyControl.concurrentFlushes += 1;
      return actual.flushFileHistory(...args);
    },
  };
});

import { createVaultService } from "./index.js";

describe("vault history mutation serialization", () => {
  let root: string;
  let sessions: DocumentSessionManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kb1-vault-service-history-queue-"));
    sessions = new DocumentSessionManager({ root, defaultContent: "" });
    historyControl.moveRunning = false;
    historyControl.concurrentFlushes = 0;
    historyControl.flushCalls = 0;
    historyControl.moveStarted = undefined;
    historyControl.releaseMove = Promise.resolve();
  });

  afterEach(async () => {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps restore boundaries behind an in-flight move-history commit", async () => {
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    await service.createNote({
      path: "notes/source.md",
      content: "source\n",
      actor: { kind: "user" },
    });
    await service.createNote({
      path: "notes/boundary.md",
      content: "boundary\n",
      actor: { kind: "user" },
    });
    await service.flushDirtySessions();

    let announceMoveStarted: (() => void) | undefined;
    const moveStarted = new Promise<void>((resolve) => {
      announceMoveStarted = resolve;
    });
    let releaseMove: (() => void) | undefined;
    historyControl.releaseMove = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    historyControl.moveStarted = announceMoveStarted;

    const move = service.moveNote({
      fromPath: "notes/source.md",
      toPath: "notes/moved.md",
      actor: { kind: "user" },
    });
    await moveStarted;

    const boundary = service.createNoteHistoryBoundary({ path: "notes/boundary.md" });
    const earlyBoundaryResult = await Promise.race([
      boundary.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]);
    expect(earlyBoundaryResult).toBe("waiting");
    expect(historyControl.concurrentFlushes).toBe(0);

    releaseMove?.();
    await expect(move).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/source.md",
      toPath: "notes/moved.md",
    });
    await expect(boundary).resolves.toMatchObject({ ok: true });
    expect(historyControl.concurrentFlushes).toBe(0);
  });

  it("records each persisted snapshot even when history work is queued", async () => {
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
      historyCoalesceWindowMs: 0,
    });
    await service.createNote({
      path: "notes/source.md",
      content: "source\n",
      actor: { kind: "user" },
    });
    await service.createNote({
      path: "notes/versioned.md",
      content: "initial\n",
      actor: { kind: "user" },
    });
    await service.flushDirtySessions();

    let announceMoveStarted: (() => void) | undefined;
    const moveStarted = new Promise<void>((resolve) => {
      announceMoveStarted = resolve;
    });
    let releaseMove: (() => void) | undefined;
    historyControl.releaseMove = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    historyControl.moveStarted = announceMoveStarted;
    const move = service.moveNote({
      fromPath: "notes/source.md",
      toPath: "notes/moved.md",
      actor: { kind: "user" },
    });
    await moveStarted;

    const session = sessions.getSession("notes/versioned.md");
    await session.open();
    await session.applyContent("first persisted snapshot\n", {
      attribution: { actor: { kind: "user", id: "first-author" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.applyContent("second persisted snapshot\n", {
      attribution: { actor: { kind: "user", id: "second-author" } },
    });

    releaseMove?.();
    await expect(move).resolves.toMatchObject({ ok: true });
    await expect(service.createNoteHistoryBoundary({ path: "notes/versioned.md" }))
      .resolves.toMatchObject({ ok: true, flushed: 2 });

    const history = await service.listNoteHistory({ path: "notes/versioned.md" });
    if (!history.ok) throw new Error("expected versioned history");
    const first = history.entries.find((entry) => entry.actor.id === "first-author");
    const second = history.entries.find((entry) => entry.actor.id === "second-author");
    if (!first || !second) throw new Error("expected both persisted authors");
    await expect(service.readNoteHistoryVersion({
      path: "notes/versioned.md",
      id: first.id,
    })).resolves.toMatchObject({
      ok: true,
      available: true,
      content: "first persisted snapshot\n",
    });
    await expect(service.readNoteHistoryVersion({
      path: "notes/versioned.md",
      id: second.id,
    })).resolves.toMatchObject({
      ok: true,
      available: true,
      content: "second persisted snapshot\n",
    });
  });

  it("drains the live document session before flushing the restore boundary", async () => {
    const service = createVaultService({
      vaultRoot: root,
      documentSessions: sessions,
    });
    await service.createNote({
      path: "notes/live.md",
      content: "current\n",
      actor: { kind: "user" },
    });
    await service.flushDirtySessions();
    historyControl.flushCalls = 0;

    const session = sessions.getSession("notes/live.md");
    await session.open();
    const originalFlush = session.flush.bind(session);
    let announceFlushStarted: (() => void) | undefined;
    const flushStarted = new Promise<void>((resolve) => {
      announceFlushStarted = resolve;
    });
    let releaseFlush: (() => void) | undefined;
    const flushReleased = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    session.flush = async (...args) => {
      announceFlushStarted?.();
      await flushReleased;
      return originalFlush(...args);
    };

    const boundary = service.createNoteHistoryBoundary({ path: "notes/live.md" });
    await flushStarted;
    expect(historyControl.flushCalls).toBe(0);

    releaseFlush?.();
    await expect(boundary).resolves.toMatchObject({ ok: true });
    expect(historyControl.flushCalls).toBe(1);
  });
});
