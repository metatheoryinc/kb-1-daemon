import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  DocumentSessionManager,
  type DocumentSessionEvent,
} from "@kb-2/doc-session";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";

import { anchoredSpliceContractCases } from "@kb-2/vault-core";
import type { VaultChangeEvent, VaultService } from "@kb-2/vault-service";
import {
  createApp,
  type RelayLifecycleController,
  type RelayLifecycleStatus,
} from "./app.js";
import { createDaemonConfig } from "./config.js";
import { writeDaemonStatus } from "./status.js";
import { VAULT_TRASH_DIRNAME, VaultRegistry } from "./vault-registry.js";

// The vault slug every scoped data-route test addresses. The data routes are
// only reachable as `/api/vaults/:id/*`; there is no flat (default-vault) path.
const VAULT = "demo-vault";
const CORAL = "#fda4af";
const MINT = "#a7f3d0";

describe("daemon routing", () => {
  let kb2Home: string;

  beforeEach(async () => {
    kb2Home = await mkdtemp(join(tmpdir(), "kb2-health-"));
  });

  afterEach(async () => {
    await rm(kb2Home, { force: true, recursive: true });
  });

  /**
   * Stand up a registry over the throwaway home with a single empty vault, plus
   * the app that serves it. Scoped routes hit the same live `service`/`manager`
   * returned here, so live-session assertions and HTTP requests share state.
   */
  async function setupScopedVault(): Promise<{
    app: Hono;
    registry: VaultRegistry;
    service: VaultService;
    manager: DocumentSessionManager;
    vaultRoot: string;
    config: ReturnType<typeof createDaemonConfig>;
  }> {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const vaultsHome = config.vaultsHome;
    await mkdir(join(vaultsHome, VAULT), { recursive: true });
    const registry = await VaultRegistry.load(
      vaultsHome,
      join(kb2Home, VAULT_TRASH_DIRNAME),
    );
    const instance = registry.get(VAULT);
    if (!instance) throw new Error("expected the seeded vault to load");
    const app = createApp({
      statusFile: config.statusFile,
      registry,
      actorDefault: config.actorDefault,
    });
    return {
      app,
      registry,
      service: instance.service,
      manager: instance.manager,
      vaultRoot: instance.entry.root,
      config,
    };
  }

  /** Path to a scoped file route for the lone test vault. */
  const filePath = (vaultPath: string): string =>
    `/api/vaults/${VAULT}/files/${vaultPath}`;
  /** Path to a scoped folder route for the lone test vault. */
  const folderPath = (vaultPath?: string): string =>
    vaultPath === undefined
      ? `/api/vaults/${VAULT}/folders`
      : `/api/vaults/${VAULT}/folders/${vaultPath}`;

  it("returns daemon status read back from the configured filesystem home", async () => {
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
      now: new Date("2026-06-10T15:30:00.000Z"),
      pid: 5678,
    });

    await writeDaemonStatus(config);

    const app = createApp({ statusFile: config.statusFile });
    const response = await app.request("/api/health");
    const body = await response.json();
    const statusFileContents = JSON.parse(
      await readFile(config.statusFile, "utf8"),
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "kb2d",
      status: {
        serviceName: "kb2d",
        kb2Home,
        daemonHome: join(kb2Home, "daemon"),
        statusFile: config.statusFile,
        pid: 5678,
      },
    });
    expect(statusFileContents).toMatchObject(body.status);
  });

  it("exposes daemon relay lifecycle controls when relay is configured", async () => {
    const relay = fakeRelayLifecycleController();
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({ statusFile: config.statusFile, relay });

    const initial = await app.request("/api/relay/status");
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual({
      ok: true,
      relay: {
        configured: true,
        started: false,
        controlConnected: false,
        reconnectScheduled: false,
      },
    });

    const connected = await app.request("/api/relay/connect", {
      method: "POST",
    });
    const connectedAgain = await app.request("/api/relay/connect", {
      method: "POST",
    });
    expect(connected.status).toBe(200);
    expect(connectedAgain.status).toBe(200);
    expect(relay.connectCalls).toBe(2);
    await expect(connectedAgain.json()).resolves.toEqual({
      ok: true,
      relay: {
        configured: true,
        started: true,
        controlConnected: true,
        reconnectScheduled: false,
      },
    });

    const disconnected = await app.request("/api/relay/disconnect", {
      method: "POST",
    });
    expect(disconnected.status).toBe(200);
    expect(relay.disconnectCalls).toBe(1);
    await expect(disconnected.json()).resolves.toEqual({
      ok: true,
      relay: {
        configured: true,
        started: false,
        controlConnected: false,
        reconnectScheduled: false,
      },
    });
  });

  it("keeps relay status readable and connect explicit when relay is not configured", async () => {
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({ statusFile: config.statusFile });

    const status = await app.request("/api/relay/status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      ok: true,
      relay: {
        configured: false,
        started: false,
        controlConnected: false,
        reconnectScheduled: false,
      },
    });

    const connect = await app.request("/api/relay/connect", { method: "POST" });
    expect(connect.status).toBe(409);
    await expect(connect.json()).resolves.toMatchObject({
      ok: false,
      error: "relay_not_configured",
    });

    const disconnect = await app.request("/api/relay/disconnect", {
      method: "POST",
    });
    expect(disconnect.status).toBe(200);
    await expect(disconnect.json()).resolves.toMatchObject({
      ok: true,
      relay: { configured: false },
    });
  });

  it("serves the UI shell for root and client route requests", async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), "kb2-web-build-"));
    await writeFile(
      join(webBuildDir, "index.html"),
      '<!doctype html><title>KB-2 Local</title><div id="svelte">KB-2 Local UI</div>',
      "utf8",
    );

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const rootResponse = await app.request("/");
    const routeResponse = await app.request("/status");

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("content-type")).toContain("text/html");
    await expect(rootResponse.text()).resolves.toContain("KB-2 Local UI");

    expect(routeResponse.status).toBe(200);
    expect(routeResponse.headers.get("content-type")).toContain("text/html");
    await expect(routeResponse.text()).resolves.toContain("KB-2 Local UI");

    await rm(webBuildDir, { force: true, recursive: true });
  });

  it("serves built UI assets without routing them through the SPA fallback", async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), "kb2-web-build-"));
    await mkdir(join(webBuildDir, "_app"), { recursive: true });
    await writeFile(
      join(webBuildDir, "index.html"),
      "<!doctype html><title>KB-2 Local</title>",
      "utf8",
    );
    await writeFile(
      join(webBuildDir, "_app", "app.css"),
      "body { color: black; }",
      "utf8",
    );

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const response = await app.request("/_app/app.css");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    await expect(response.text()).resolves.toContain("color: black");

    await rm(webBuildDir, { force: true, recursive: true });
  });

  it("keeps missing API routes out of the UI fallback", async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), "kb2-web-build-"));
    await writeFile(
      join(webBuildDir, "index.html"),
      "<!doctype html><title>KB-2 Local</title>",
      "utf8",
    );

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const response = await app.request("/api/missing");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Not found" });

    await rm(webBuildDir, { force: true, recursive: true });
  });

  it("exposes scoped vault file routes with no-clobber writes, overwrite, taxonomy, and audit rows", async () => {
    const { app, vaultRoot } = await setupScopedVault();

    const created = await app.request(filePath("notes/a.md"), {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "first",
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      ok: true,
      path: "notes/a.md",
    });

    const duplicate = await app.request(filePath("notes/a.md"), {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "second",
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      error: "already_exists",
    });

    const overwritten = await app.request(
      `${filePath("notes/a.md")}?overwrite=true`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "second" }),
      },
    );
    expect(overwritten.status).toBe(200);

    const read = await app.request(filePath("notes/a.md"));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      ok: true,
      path: "notes/a.md",
      content: "second",
    });

    const invalid = await app.request(filePath("no-extension"), {
      method: "PUT",
      body: "x",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_path",
    });

    const audit = await readAuditRows(vaultRoot);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      operation: "create",
      entityKind: "file",
      path: "notes/a.md",
      actor: { kind: "user" },
    });
    expect(audit[1]).toMatchObject({ operation: "write", path: "notes/a.md" });
  });

  it("returns a clean 404 for a scoped data route addressing an unknown vault", async () => {
    const { app } = await setupScopedVault();
    const response = await app.request("/api/vaults/does-not-exist/tree");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("attributes REST writes from the x-kb1-actor header in responses and audit JSONL", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    const suppliedActor = {
      kind: "integration",
      id: "user-123",
      name: "Ada Lovelace",
      client: "integration-client",
    };

    const created = await app.request(filePath("notes/attributed.md"), {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "x-kb1-actor": JSON.stringify(suppliedActor),
      },
      body: "attributed\n",
    });

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      ok: true,
      path: "notes/attributed.md",
      audit: { actor: suppliedActor },
    });
    await expect(
      readFile(join(vaultRoot, "notes/attributed.md"), "utf8"),
    ).resolves.toBe("attributed\n");

    const audit = await readAuditRows(vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: "create",
      entityKind: "file",
      path: "notes/attributed.md",
      actor: suppliedActor,
    });

    const read = await app.request(filePath("notes/attributed.md"));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      ok: true,
      content: "attributed\n",
    });

    const history = await app.request(`${filePath("notes/attributed.md")}/history`);
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      ok: true,
      hasMore: false,
      entries: [
        {
          operation: "create",
          path: "notes/attributed.md",
          actor: suppliedActor,
          size: 11,
        },
      ],
    });
    const rawHistory = await readRawFileHistory(vaultRoot);
    expect(rawHistory).toContain("Ada Lovelace");
    expect(rawHistory).not.toContain("\n    content:");

    const historyAgain = await app.request(`${filePath("notes/attributed.md")}/history`);
    expect(historyAgain.status).toBe(200);
    await expect(readRawFileHistory(vaultRoot)).resolves.toBe(rawHistory);

    const moved = await app.request(`${filePath("notes/attributed.md")}/move`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kb1-actor": JSON.stringify(suppliedActor),
      },
      body: JSON.stringify({ to: "archive/attributed.md" }),
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/attributed.md",
      toPath: "archive/attributed.md",
      audit: { actor: suppliedActor },
    });

    const oldHistory = await app.request(`${filePath("notes/attributed.md")}/history`);
    expect(oldHistory.status).toBe(200);
    await expect(oldHistory.json()).resolves.toMatchObject({
      ok: true,
      hasMore: false,
      entries: [],
    });

    const movedHistory = await app.request(`${filePath("archive/attributed.md")}/history`);
    expect(movedHistory.status).toBe(200);
    await expect(movedHistory.json()).resolves.toMatchObject({
      ok: true,
      hasMore: false,
      entries: [
        {
          operation: "move",
          path: "archive/attributed.md",
          actor: suppliedActor,
          size: 11,
        },
        {
          operation: "create",
          path: "archive/attributed.md",
          actor: suppliedActor,
          size: 11,
        },
      ],
    });
  });

  it.each([
    {
      name: "default user mode",
      env: {},
      expectedActor: { kind: "user", id: "local user", name: "local user" },
    },
    {
      name: "configured unknown mode",
      env: { KB2_ACTOR_DEFAULT: "unknown" },
      expectedActor: { kind: "unknown" },
    },
  ])(
    "uses $name for REST writes without an actor header",
    async ({ env, expectedActor }) => {
      const config = createDaemonConfig({ env: { KB2_HOME: kb2Home, ...env } });
      await mkdir(join(config.vaultsHome, VAULT), { recursive: true });
      const registry = await VaultRegistry.load(
        config.vaultsHome,
        join(kb2Home, VAULT_TRASH_DIRNAME),
      );
      const vaultRoot = registry.get(VAULT)!.entry.root;
      const app = createApp({
        statusFile: config.statusFile,
        registry,
        actorDefault: config.actorDefault,
      });

      const created = await app.request(filePath("notes/defaulted.md"), {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "defaulted\n",
      });

      expect(created.status).toBe(201);
      await expect(created.json()).resolves.toMatchObject({
        ok: true,
        audit: { actor: expectedActor },
      });
      await expect(
        readFile(join(vaultRoot, "notes/defaulted.md"), "utf8"),
      ).resolves.toBe("defaulted\n");

      const audit = await readAuditRows(vaultRoot);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        operation: "create",
        path: "notes/defaulted.md",
        actor: expectedActor,
      });
      const history = await app.request(`${filePath("notes/defaulted.md")}/history`);
      expect(history.status).toBe(200);
      await expect(history.json()).resolves.toMatchObject({
        ok: true,
        entries: [{ operation: "create", actor: expectedActor }],
      });
      await registry.close();
    },
  );

  it.each([
    { name: "bad JSON", header: "{" },
    { name: "spoofed system kind", header: JSON.stringify({ kind: "system" }) },
    {
      name: "reserved mcp_client kind",
      header: JSON.stringify({ kind: "mcp_client" }),
    },
    { name: "unknown kind", header: JSON.stringify({ kind: "service" }) },
    {
      name: "oversized payload",
      header: JSON.stringify({ kind: "user", name: "x".repeat(1025) }),
    },
    {
      name: "non-string identity field",
      header: JSON.stringify({ kind: "user", id: 123 }),
    },
  ])("rejects malformed REST actor header: $name", async ({ header }) => {
    const { app, vaultRoot } = await setupScopedVault();

    const response = await app.request(filePath("notes/rejected.md"), {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "x-kb1-actor": header,
      },
      body: "must not write\n",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_actor",
    });
    await expect(
      stat(join(vaultRoot, "notes/rejected.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(vaultRoot, ".kb2/audit/changes.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves and deletes live file sessions through the API with doc events and trash", async () => {
    const { app, manager, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(join(vaultRoot, "notes/live.md"), "");
    const liveSession = manager.getSession("notes/live.md");
    const events: DocumentSessionEvent[] = [];
    liveSession.onEvent((event) => events.push(event));
    await liveSession.open();
    liveSession.ydoc.getText("markdown").insert(0, "live content\n");
    await liveSession.flush();

    const moved = await app.request(`${filePath("notes/live.md")}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "notes/renamed.md" }),
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/live.md",
      toPath: "notes/renamed.md",
      live: true,
    });
    liveSession.ydoc
      .getText("markdown")
      .insert(liveSession.ydoc.getText("markdown").length, "after move\n");
    await liveSession.flush();

    await expect(
      readFile(join(vaultRoot, "notes/renamed.md"), "utf8"),
    ).resolves.toBe("live content\nafter move\n");
    await expect(
      readFile(join(vaultRoot, "notes/live.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "doc-moved",
        fromPath: "notes/live.md",
        toPath: "notes/renamed.md",
      }),
    );

    const deleted = await app.request(filePath("notes/renamed.md"), {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      ok: true,
      path: "notes/renamed.md",
      live: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "doc-deleted",
        path: "notes/renamed.md",
      }),
    );

    const tree = await app.request(`/api/vaults/${VAULT}/tree`);
    const treeBody = (await tree.json()) as {
      entries: Array<{ path: string }>;
    };
    expect(treeBody.entries.map((entry) => entry.path)).not.toContain(
      "notes/renamed.md",
    );
    const audit = await readAuditRows(vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual(["move", "delete"]);
    expect(String(audit[1].summary)).toContain("trash");
  });

  it("moves folder subtrees and rekeys live sessions underneath them", async () => {
    const { app, manager, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(
      join(vaultRoot, "parent/folder/deep/live.md"),
      "",
    );
    const nested = manager.getSession("parent/folder/deep/live.md");
    const events: DocumentSessionEvent[] = [];
    nested.onEvent((event) => events.push(event));
    await nested.open();
    nested.ydoc.getText("markdown").insert(0, "nested\n");
    await nested.flush();

    const moved = await app.request(`${folderPath("parent/folder")}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "parent/moved/folder" }),
    });

    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: "parent/folder",
      toPath: "parent/moved/folder",
      liveMoved: ["parent/moved/folder/deep/live.md"],
    });
    nested.ydoc
      .getText("markdown")
      .insert(nested.ydoc.getText("markdown").length, "after folder move\n");
    await nested.flush();

    await expect(
      readFile(join(vaultRoot, "parent/moved/folder/deep/live.md"), "utf8"),
    ).resolves.toBe("nested\nafter folder move\n");
    await expect(
      readFile(join(vaultRoot, "parent/folder/deep/live.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "doc-moved",
        fromPath: "parent/folder/deep/live.md",
        toPath: "parent/moved/folder/deep/live.md",
      }),
    );
  });

  it("moves zero-live folder subtrees through the production session manager once", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    await mkdir(join(vaultRoot, "emptydir"), { recursive: true });

    const moved = await app.request(`${folderPath("emptydir")}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "moved/emptydir" }),
    });

    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: "emptydir",
      toPath: "moved/emptydir",
      liveMoved: [],
    });
    expect((await stat(join(vaultRoot, "moved/emptydir"))).isDirectory()).toBe(
      true,
    );
    await expect(stat(join(vaultRoot, "emptydir"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const audit = await readAuditRows(vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: "move",
      entityKind: "folder",
      fromPath: "emptydir",
      toPath: "moved/emptydir",
    });
  });

  it("reads and writes folder metadata through REST and hydrates tree folders inline", async () => {
    const { app, vaultRoot } = await setupScopedVault();

    const created = await app.request(folderPath(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes" }),
    });
    expect(created.status).toBe(201);

    const set = await app.request(`${folderPath("notes")}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: CORAL }),
    });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      ok: true,
      path: "notes",
      metadata: { color: CORAL },
      audit: { operation: "write", entityKind: "folder", path: "notes" },
    });
    const setRaw = await readRawFolderMetadata(vaultRoot);
    expect(setRaw).toContain("notes:");
    expect(setRaw).toContain(CORAL);

    const read = await app.request(`${folderPath("notes")}/metadata`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      ok: true,
      path: "notes",
      metadata: { color: CORAL },
    });

    const tree = await app.request(`/api/vaults/${VAULT}/tree`);
    expect(tree.status).toBe(200);
    await expect(tree.json()).resolves.toMatchObject({
      ok: true,
      entries: [
        {
          path: "notes",
          kind: "folder",
          metadata: { color: CORAL },
        },
      ],
    });

    const cleared = await app.request(`${folderPath("notes")}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: null }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      ok: true,
      metadata: {},
    });
    const raw = await readRawFolderMetadata(vaultRoot);
    expect(raw).toContain("folders: {}");

    const audit = await readAuditRows(vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual([
      "mkdir",
      "write",
      "write",
    ]);
  });

  it("reads and writes vault metadata through REST, list, and SSE", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    const server = await startHttpApp(app);
    const stream = await openSseStream(
      `${server.origin}/api/vaults/${VAULT}/events`,
    );

    try {
      const set = await fetchJson(
        `${server.origin}/api/vaults/${VAULT}/metadata`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ color: CORAL }),
        },
      );
      expect(set).toMatchObject({
        ok: true,
        vault: {
          id: VAULT,
          displayName: VAULT,
          metadata: { color: CORAL },
        },
      });

      const identity = JSON.parse(
        await readFile(join(vaultRoot, ".kb2", "vault.json"), "utf8"),
      );
      expect(identity).toMatchObject({
        id: VAULT,
        displayName: VAULT,
        metadata: { color: CORAL },
      });

      const listed = await fetchJson(`${server.origin}/api/vaults`, {
        method: "GET",
      });
      expect(listed).toMatchObject({
        ok: true,
        vaults: [
          {
            id: VAULT,
            displayName: VAULT,
            metadata: { color: CORAL },
          },
        ],
      });

      const events = await stream.waitForEvents(1);
      expect(events[0]).toMatchObject({
        kind: "vault_metadata_changed",
        path: "",
        actor: { kind: "user" },
      });

      const cleared = await fetchJson(
        `${server.origin}/api/vaults/${VAULT}/metadata`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ color: null }),
        },
      );
      expect(cleared).toMatchObject({
        ok: true,
        vault: { id: VAULT, displayName: VAULT },
      });
      expect(JSON.stringify(cleared)).not.toContain("metadata");
    } finally {
      stream.close();
      await server.close();
    }
  });

  it("maps folder metadata REST failures through the canonical service dialect", async () => {
    const { app, vaultRoot } = await setupScopedVault();

    await mkdir(join(vaultRoot, "notes"), { recursive: true });

    const nonString = await app.request(`${folderPath("notes")}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: 42 }),
    });
    expect(nonString.status).toBe(400);
    await expect(nonString.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_request",
    });

    const invalidAccent = await app.request(`${folderPath("notes")}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: "amber" }),
    });
    expect(invalidAccent.status).toBe(400);
    await expect(invalidAccent.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_metadata",
    });

    const missing = await app.request(`${folderPath("missing")}/metadata`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });

    await writeFileWithParents(
      join(vaultRoot, ".kb2", "folders.yml"),
      "folders: [",
    );
    const malformed = await app.request(`${folderPath("notes")}/metadata`);
    expect(malformed.status).toBe(500);
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: "metadata_parse_failed",
    });
  });

  it("routes nested folder metadata through the canonical service dialect", async () => {
    const { app, vaultRoot } = await setupScopedVault();

    await mkdir(join(vaultRoot, "projects", "active"), { recursive: true });

    const set = await app.request(`${folderPath("projects/active")}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: MINT }),
    });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      ok: true,
      path: "projects/active",
      metadata: { color: MINT },
    });

    const read = await app.request(`${folderPath("projects/active")}/metadata`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      ok: true,
      path: "projects/active",
      metadata: { color: MINT },
    });

    const invalidAccent = await app.request(
      `${folderPath("projects/active")}/metadata`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color: "amber" }),
      },
    );
    expect(invalidAccent.status).toBe(400);
    await expect(invalidAccent.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_metadata",
    });

    const missing = await app.request(
      `${folderPath("projects/missing")}/metadata`,
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("deletes zero-live folder subtrees through the production session manager once", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    await mkdir(join(vaultRoot, "emptydir"), { recursive: true });

    const deleted = await app.request(folderPath("emptydir"), {
      method: "DELETE",
    });

    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      ok: true,
      path: "emptydir",
      liveDeleted: [],
    });
    await expect(stat(join(vaultRoot, "emptydir"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const audit = await readAuditRows(vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: "delete",
      entityKind: "folder",
      path: "emptydir",
    });
  });

  it("routes live whole-file writes through the open session", async () => {
    const { app, manager, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(join(vaultRoot, "live-write.md"), "old\n");
    const session = manager.getSession("live-write.md");
    await session.open();

    const noClobber = await app.request(filePath("live-write.md"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "should not clobber\n" }),
    });
    expect(noClobber.status).toBe(409);
    await expect(noClobber.json()).resolves.toMatchObject({
      ok: false,
      error: "already_exists",
    });

    const response = await app.request(
      `${filePath("live-write.md")}?overwrite=true`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "new through session\n" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: "live-write.md",
      live: true,
      content: "new through session\n",
    });
    await expect(
      readFile(join(vaultRoot, "live-write.md"), "utf8"),
    ).resolves.toBe("new through session\n");
  });

  it("routes live whole-file writes through a fast-diff session merge", async () => {
    const { app, manager, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(
      join(vaultRoot, "live-merge.md"),
      "alpha\nomega\n",
    );
    const session = manager.getSession("live-merge.md");
    await session.open();

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc), session);
    const clientText = clientDoc.getText("markdown");
    clientText.insert("alpha\n".length, "typed concurrently\n");
    const inFlightUpdate = Y.encodeStateAsUpdate(
      clientDoc,
      Y.encodeStateVector(session.ydoc),
    );

    const response = await app.request(
      `${filePath("live-merge.md")}?overwrite=true`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "alpha\nservice write\nomega\n" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: "live-merge.md",
      live: true,
      content: "alpha\nservice write\nomega\n",
    });

    Y.applyUpdate(session.ydoc, inFlightUpdate, clientDoc);
    await session.flush();

    const mergedContent = await readFile(
      join(vaultRoot, "live-merge.md"),
      "utf8",
    );
    expect([
      "alpha\ntyped concurrently\nservice write\nomega\n",
      "alpha\nservice write\ntyped concurrently\nomega\n",
    ]).toContain(mergedContent);
  });

  it("serves baselines and applies agent splice with stale retry through live sessions", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(
      join(vaultRoot, "notes", "splice.md"),
      "one two three\n",
    );

    const read = await app.request(filePath("notes/splice.md"));
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      content: string;
      baseline: string;
    };
    expect(readBody.content).toBe("one two three\n");
    expect(readBody.baseline.length).toBeGreaterThan(0);

    const firstSplice = await app.request(
      `${filePath("notes/splice.md")}/splice`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseline: readBody.baseline,
          old_text: "two",
          new_text: "TWO",
        }),
      },
    );
    expect(firstSplice.status).toBe(200);
    const firstBody = (await firstSplice.json()) as {
      content: string;
      baseline: string;
    };
    expect(firstBody.content).toBe("one TWO three\n");
    await expect(
      readFile(join(vaultRoot, "notes/splice.md"), "utf8"),
    ).resolves.toBe("one TWO three\n");

    const stale = await app.request(`${filePath("notes/splice.md")}/splice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseline: readBody.baseline,
        old_text: "three",
        new_text: "THREE",
      }),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as {
      error: string;
      current_content: string;
      baseline: string;
    };
    expect(staleBody).toMatchObject({
      error: "stale_doc",
      current_content: "one TWO three\n",
    });
    expect(staleBody.baseline).not.toBe(readBody.baseline);

    const retry = await app.request(`${filePath("notes/splice.md")}/splice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseline: staleBody.baseline,
        old_text: "three",
        new_text: "THREE",
      }),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      ok: true,
      content: "one TWO THREE\n",
    });
    await expect(
      readFile(join(vaultRoot, "notes/splice.md"), "utf8"),
    ).resolves.toBe("one TWO THREE\n");

    const audit = await readAuditRows(vaultRoot);
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => row.operation)).toEqual(["splice", "splice"]);
    expect(
      audit.every((row) => (row.actor as { kind?: string }).kind === "user"),
    ).toBe(true);
  });

  it("exercises every MCP tool end-to-end through the SDK client with mcp_client audit attribution", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    const { client, transport } = await connectMcpClient(
      app,
      "daemon-sdk-test",
    );

    await expect(
      mcpToolJson(client, "create_note", {
        vaultId: VAULT,
        path: "notes/a.md",
        content: "alpha beta alpha\n",
      }),
    ).resolves.toMatchObject({ ok: true, path: "notes/a.md" });
    await expect(readFile(join(vaultRoot, "notes/a.md"), "utf8")).resolves.toBe(
      "alpha beta alpha\n",
    );

    await expect(
      mcpToolJson(client, "vault_info", { vaultId: VAULT }),
    ).resolves.toMatchObject({ ok: true, fileCount: 1 });
    await expect(
      mcpToolJson(client, "list_files", {
        vaultId: VAULT,
        under: "notes",
        depth: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      entries: [{ path: "notes/a.md", kind: "file" }],
    });

    const read = (await mcpToolJson(client, "read_note", {
      vaultId: VAULT,
      path: "notes/a.md",
    })) as { content: string; baseline: string };
    expect(read.content).toBe("alpha beta alpha\n");
    expect(read.baseline.length).toBeGreaterThan(0);

    await expect(
      mcpToolJson(client, "edit_note", {
        vaultId: VAULT,
        path: "notes/a.md",
        baseline: read.baseline,
        old_text: "beta",
        new_text: "BETA",
      }),
    ).resolves.toMatchObject({ ok: true, content: "alpha BETA alpha\n" });
    await expect(readFile(join(vaultRoot, "notes/a.md"), "utf8")).resolves.toBe(
      "alpha BETA alpha\n",
    );

    const stale = await client.callTool({
      name: "edit_note",
      arguments: {
        vaultId: VAULT,
        path: "notes/a.md",
        baseline: read.baseline,
        old_text: "alpha",
        new_text: "ALPHA",
      },
    });
    expect(stale.isError).toBe(true);
    expect(mcpText(stale)).toContain('"error":"stale_doc"');
    expect(mcpText(stale)).toContain('"current_content":"alpha BETA alpha\\n"');
    expect(mcpText(stale)).toContain('"baseline"');

    const fresh = (await mcpToolJson(client, "read_note", {
      vaultId: VAULT,
      path: "notes/a.md",
    })) as { baseline: string };
    const ambiguous = await client.callTool({
      name: "edit_note",
      arguments: {
        vaultId: VAULT,
        path: "notes/a.md",
        baseline: fresh.baseline,
        old_text: "alpha",
        new_text: "ALPHA",
      },
    });
    expect(ambiguous.isError).toBe(true);
    expect(mcpText(ambiguous)).toContain('"error":"ambiguous"');
    expect(mcpText(ambiguous)).toContain('"match_count":2');

    await expect(
      mcpToolJson(client, "append_note", {
        vaultId: VAULT,
        path: "notes/a.md",
        content: "tail\n",
      }),
    ).resolves.toMatchObject({ ok: true, content: "alpha BETA alpha\ntail\n" });
    await expect(
      mcpToolJson(client, "prepend_note", {
        vaultId: VAULT,
        path: "notes/a.md",
        content: "head\n",
      }),
    ).resolves.toMatchObject({
      ok: true,
      content: "head\nalpha BETA alpha\ntail\n",
    });
    await expect(readFile(join(vaultRoot, "notes/a.md"), "utf8")).resolves.toBe(
      "head\nalpha BETA alpha\ntail\n",
    );

    await expect(
      mcpToolJson(client, "create_folder", { vaultId: VAULT, path: "moved" }),
    ).resolves.toMatchObject({ ok: true, path: "moved" });
    await expect(
      mcpToolJson(client, "set_folder_metadata", {
        vaultId: VAULT,
        path: "moved",
        color: MINT,
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "moved",
      metadata: { color: MINT },
    });
    await expect(
      mcpToolJson(client, "get_folder_metadata", {
        vaultId: VAULT,
        path: "moved",
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "moved",
      metadata: { color: MINT },
    });
    const metadataRaw = await readRawFolderMetadata(vaultRoot);
    expect(metadataRaw).toContain("moved:");
    expect(metadataRaw).toContain(MINT);
    await expect(
      mcpToolJson(client, "move_note", {
        vaultId: VAULT,
        from_path: "notes/a.md",
        to_path: "moved/a.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "notes/a.md",
      toPath: "moved/a.md",
      live: true,
    });
    await expect(readFile(join(vaultRoot, "moved/a.md"), "utf8")).resolves.toBe(
      "head\nalpha BETA alpha\ntail\n",
    );
    await expect(stat(join(vaultRoot, "notes/a.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      mcpToolJson(client, "move_folder", {
        vaultId: VAULT,
        from_path: "moved",
        to_path: "archived",
      }),
    ).resolves.toMatchObject({
      ok: true,
      fromPath: "moved",
      toPath: "archived",
      liveMoved: ["archived/a.md"],
    });
    await expect(
      readFile(join(vaultRoot, "archived/a.md"), "utf8"),
    ).resolves.toContain("BETA");

    await expect(
      mcpToolJson(client, "search", {
        vaultId: VAULT,
        query: "BETA",
        under: "archived",
        context: 0,
      }),
    ).resolves.toMatchObject({
      ok: true,
      total: 1,
      results: [{ path: "archived/a.md" }],
    });

    await expect(
      mcpToolJson(client, "delete_note", {
        vaultId: VAULT,
        path: "archived/a.md",
      }),
    ).resolves.toMatchObject({ ok: true, path: "archived/a.md", live: true });
    await expect(stat(join(vaultRoot, "archived/a.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      mcpToolJson(client, "delete_folder", {
        vaultId: VAULT,
        path: "archived",
        recursive: true,
      }),
    ).resolves.toMatchObject({ ok: true, path: "archived", liveDeleted: [] });
    await expect(stat(join(vaultRoot, "archived"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const audit = await readAuditRows(vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual([
      "create",
      "splice",
      "append",
      "prepend",
      "mkdir",
      "write",
      "move",
      "move",
      "delete",
      "delete",
    ]);
    expect(
      audit.every((row) => {
        const actor = row.actor as {
          kind?: string;
          id?: string;
          name?: string;
          client?: string;
        };
        return (
          actor.kind === "mcp_client" &&
          actor.id === "local agent" &&
          actor.name === "local agent" &&
          actor.client === "daemon-sdk-test"
        );
      }),
    ).toBe(true);

    await transport.terminateSession();
  });

  it("returns a clean MCP tool error for an unknown vaultId without crashing", async () => {
    const { app } = await setupScopedVault();
    const { client, transport } = await connectMcpClient(
      app,
      "mcp-unknown-vault",
    );

    const result = await client.callTool({
      name: "create_note",
      arguments: { vaultId: "no-such-vault", path: "x.md", content: "x\n" },
    });
    expect(result.isError).toBe(true);
    expect(mcpText(result)).toBe(
      'create_note rejected: {"ok":false,"error":"not_found","message":"No vault with id \\"no-such-vault\\"."}',
    );

    // A data tool call WITHOUT vaultId is rejected: the param is required.
    const missing = await client.callTool({
      name: "create_note",
      arguments: { path: "x.md", content: "x\n" },
    });
    expect(missing.isError).toBe(true);

    await transport.terminateSession();
  });

  it.each(anchoredSpliceContractCases)(
    "runs the shared splice contract over MCP: $name",
    async ({ initialContent, request, expected }) => {
      const { app, vaultRoot } = await setupScopedVault();
      const notePath = "notes/contract.md";
      await writeFileWithParents(join(vaultRoot, notePath), initialContent);
      const { client, transport } = await connectMcpClient(
        app,
        "mcp-splice-contract-test",
      );

      const read = (await mcpToolJson(client, "read_note", {
        vaultId: VAULT,
        path: notePath,
      })) as { baseline: string };
      const result = await client.callTool({
        name: "edit_note",
        arguments: {
          vaultId: VAULT,
          path: notePath,
          baseline: read.baseline,
          old_text: request.oldText,
          new_text: request.newText,
          ...(request.before !== undefined ? { before: request.before } : {}),
          ...(request.after !== undefined ? { after: request.after } : {}),
          ...(request.occurrence !== undefined
            ? { occurrence: request.occurrence }
            : {}),
        },
      });

      if (expected.ok) {
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(mcpText(result))).toMatchObject({
          ok: true,
          path: notePath,
          content: expected.content,
        });
        await expect(readFile(join(vaultRoot, notePath), "utf8")).resolves.toBe(
          expected.content,
        );
      } else {
        expect(result.isError).toBe(true);
        expect(parseMcpRejection(result, "edit_note")).toMatchObject(
          serviceFailureFromContract(expected),
        );
        await expect(readFile(join(vaultRoot, notePath), "utf8")).resolves.toBe(
          initialContent,
        );
      }

      await transport.terminateSession();
    },
  );

  it("surfaces MCP persist failures without a success audit row and recovers the live session", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    const { client, transport } = await connectMcpClient(
      app,
      "mcp-persist-test",
    );

    await expect(
      mcpToolJson(client, "create_note", {
        vaultId: VAULT,
        path: "notes/readonly.md",
        content: "base\n",
      }),
    ).resolves.toMatchObject({ ok: true, path: "notes/readonly.md" });
    await mcpToolJson(client, "read_note", {
      vaultId: VAULT,
      path: "notes/readonly.md",
    });

    const beforeAudit = await readAuditRows(vaultRoot);
    await chmod(join(vaultRoot, "notes"), 0o500);
    const failed = await client.callTool({
      name: "append_note",
      arguments: {
        vaultId: VAULT,
        path: "notes/readonly.md",
        content: "unsaved\n",
      },
    });

    expect(failed.isError).toBe(true);
    expect(mcpText(failed)).toBe(
      'append_note rejected: {"ok":false,"error":"persist_failed","message":"Document edit could not be durably saved to disk."}',
    );
    await expect(
      readFile(join(vaultRoot, "notes/readonly.md"), "utf8"),
    ).resolves.toBe("base\n");
    expect(await readAuditRows(vaultRoot)).toHaveLength(beforeAudit.length);

    await chmod(join(vaultRoot, "notes"), 0o700);
    await expect(
      mcpToolJson(client, "append_note", {
        vaultId: VAULT,
        path: "notes/readonly.md",
        content: "recovered\n",
      }),
    ).resolves.toMatchObject({
      ok: true,
      content: "base\nunsaved\nrecovered\n",
    });
    await expect(
      readFile(join(vaultRoot, "notes/readonly.md"), "utf8"),
    ).resolves.toBe("base\nunsaved\nrecovered\n");

    const audit = await readAuditRows(vaultRoot);
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(audit.at(-1)).toMatchObject({
      operation: "append",
      actor: { kind: "mcp_client", client: "mcp-persist-test" },
      path: "notes/readonly.md",
    });

    await transport.terminateSession();
  });

  it("applies anchored splice disambiguation and structured rejections", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(
      join(vaultRoot, "ambiguous.md"),
      "foo bar foo baz foo",
    );
    const read = (await (
      await app.request(filePath("ambiguous.md"))
    ).json()) as { baseline: string };

    const ambiguous = await app.request(`${filePath("ambiguous.md")}/splice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseline: read.baseline,
        old_text: "foo",
        new_text: "FOO",
      }),
    });
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      ok: false,
      error: "ambiguous",
      match_count: 3,
    });

    const occurrence = await app.request(`${filePath("ambiguous.md")}/splice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseline: read.baseline,
        old_text: "foo",
        new_text: "FOO",
        occurrence: 2,
      }),
    });
    expect(occurrence.status).toBe(200);
    await expect(
      readFile(join(vaultRoot, "ambiguous.md"), "utf8"),
    ).resolves.toBe("foo bar FOO baz foo");

    const reread = (await (
      await app.request(filePath("ambiguous.md"))
    ).json()) as { baseline: string };
    const notFound = await app.request(`${filePath("ambiguous.md")}/splice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseline: reread.baseline,
        old_text: "missing",
        new_text: "x",
      }),
    });
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it.each([
    {
      name: "PUT JSON content",
      path: "bad-put.md",
      method: "PUT",
      body: { content: 42 },
      message: "content must be a string",
    },
    {
      name: "splice baseline",
      path: "bad-splice.md/splice",
      method: "POST",
      body: { old_text: "a", new_text: "b" },
      message: "baseline must be a string",
    },
    {
      name: "append content",
      path: "bad-append.md/append",
      method: "POST",
      body: { content: false },
      message: "content must be a string",
    },
    {
      name: "prepend content",
      path: "bad-prepend.md/prepend",
      method: "POST",
      body: {},
      message: "content must be a string",
    },
    {
      name: "file move target",
      path: "bad-move.md/move",
      method: "POST",
      body: { to: 42 },
      message: "to must be a string",
    },
  ])(
    "returns invalid_request for malformed file $name bodies",
    async ({ path, method, body, message }) => {
      const { app, vaultRoot } = await setupScopedVault();
      const response = await app.request(filePath(path), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "invalid_request",
        message,
      });
      await expect(
        stat(join(vaultRoot, ".kb2/audit/changes.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("returns invalid_request for a malformed folder move target body", async () => {
    const { app, vaultRoot } = await setupScopedVault();
    const response = await app.request(`${folderPath("bad-folder")}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: null }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_request",
      message: "to must be a string",
    });
    await expect(
      stat(join(vaultRoot, ".kb2/audit/changes.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends missing files, prepends after frontmatter, searches with context, and does not audit search", async () => {
    const { app, vaultRoot } = await setupScopedVault();

    const append = await app.request(`${filePath("notes/new.md")}/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "created by append\n" }),
    });
    expect(append.status).toBe(200);
    await expect(append.json()).resolves.toMatchObject({
      ok: true,
      path: "notes/new.md",
      content: "created by append\n",
    });
    await expect(
      readFile(join(vaultRoot, "notes/new.md"), "utf8"),
    ).resolves.toBe("created by append\n");

    await writeFileWithParents(
      join(vaultRoot, "notes/front.md"),
      "---\ntitle: Front\n---\nbody\n",
    );
    const prepend = await app.request(`${filePath("notes/front.md")}/prepend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "inserted\n" }),
    });
    expect(prepend.status).toBe(200);
    await expect(
      readFile(join(vaultRoot, "notes/front.md"), "utf8"),
    ).resolves.toBe("---\ntitle: Front\n---\ninserted\nbody\n");

    await writeFileWithParents(
      join(vaultRoot, "notes/deep/search.md"),
      "before\nneedle here\nafter\n",
    );
    await writeFileWithParents(
      join(vaultRoot, ".kb2/trash/hidden.md"),
      "needle hidden\n",
    );
    const search = await app.request(
      `/api/vaults/${VAULT}/search?q=NEEDLE&under=notes&context=1&limit=5`,
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      ok: true,
      total: 1,
      results: [
        {
          path: "notes/deep/search.md",
          line: 2,
          lineText: "needle here",
          context: { before: ["before"], after: ["after"] },
        },
      ],
    });

    const audit = await readAuditRows(vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual(["append", "prepend"]);
  });

  it("flushes dirty live sessions through a real HTTP barrier with durable file content", async () => {
    const { app, manager, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(join(vaultRoot, "notes/flush.md"), "");
    const session = manager.getSession("notes/flush.md");
    await session.open();
    const server = await startHttpApp(app);

    try {
      session.ydoc.getText("markdown").insert(0, "flush me now\n");
      const response = await fetch(
        `${server.origin}/api/vaults/${VAULT}/ops/flush`,
        { method: "POST" },
      );
      const body = (await response.json()) as {
        ok: boolean;
        flushed: number;
        durableAsOf: string;
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, flushed: 1 });
      expect(new Date(body.durableAsOf).toISOString()).toBe(body.durableAsOf);
      await expect(
        readFile(join(vaultRoot, "notes/flush.md"), "utf8"),
      ).resolves.toBe("flush me now\n");

      const clean = await fetch(
        `${server.origin}/api/vaults/${VAULT}/ops/flush`,
        { method: "POST" },
      );
      await expect(clean.json()).resolves.toMatchObject({
        ok: true,
        flushed: 0,
      });
    } finally {
      await server.close();
    }
  });

  it("maps flush persist failures through the canonical dialect while the loud session event fires", async () => {
    const { app, manager, vaultRoot } = await setupScopedVault();
    await writeFileWithParents(
      join(vaultRoot, "notes", "readonly.md"),
      "base\n",
    );
    const session = manager.getSession("notes/readonly.md");
    const events: DocumentSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    await session.open();
    const server = await startHttpApp(app);
    const notesDir = join(vaultRoot, "notes");

    try {
      await chmod(notesDir, 0o500);
      session.ydoc
        .getText("markdown")
        .insert(session.ydoc.getText("markdown").length, "unsaved\n");
      await waitUntil(
        () => events.some((event) => event.kind === "persist-failure"),
        () =>
          `Timed out waiting for persist-failure; events=${JSON.stringify(events)}`,
      );

      const response = await fetch(
        `${server.origin}/api/vaults/${VAULT}/ops/flush`,
        { method: "POST" },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "persist_failed",
        message: "Document edit could not be durably saved to disk.",
      });
      await expect(
        readFile(join(vaultRoot, "notes/readonly.md"), "utf8"),
      ).resolves.toBe("base\n");
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "persist-failure",
          path: "notes/readonly.md",
        }),
      );
    } finally {
      await chmod(notesDir, 0o700).catch(() => undefined);
      if (session.hasActivePersistFailure()) {
        session.ydoc
          .getText("markdown")
          .insert(session.ydoc.getText("markdown").length, "recovered\n");
        await session.flush().catch(() => undefined);
      }
      await server.close();
    }
  });

  it("streams change events over SSE without content bytes and disconnects cleanly", async () => {
    const { app } = await setupScopedVault();
    const server = await startHttpApp(app);
    const stream = await openSseStream(
      `${server.origin}/api/vaults/${VAULT}/events`,
    );
    const folder = "notes/ユニコード";
    const notePath = `${folder}/stream.md`;
    const movedPath = `${folder}/moved.md`;
    const secret = "SECRET_STREAM_BYTES_012";

    try {
      await expect(
        fetchJson(`${server.origin}${folderPath()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: folder }),
        }),
      ).resolves.toMatchObject({ ok: true, path: folder });
      await expect(
        fetchText(`${server.origin}${filePath(encodeVaultPath(notePath))}`, {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: "initial visible content\n",
        }),
      ).resolves.toMatchObject({ ok: true, path: notePath });
      await expect(
        fetchJson(
          `${server.origin}${folderPath(encodeVaultPath(folder))}/metadata`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ color: MINT }),
          },
        ),
      ).resolves.toMatchObject({ ok: true, path: folder });
      await expect(
        fetchJson(
          `${server.origin}${filePath(encodeVaultPath(notePath))}/append`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: secret }),
          },
        ),
      ).resolves.toMatchObject({ ok: true, path: notePath });
      await expect(
        fetchJson(
          `${server.origin}${filePath(encodeVaultPath(notePath))}/move`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ to: movedPath }),
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        fromPath: notePath,
        toPath: movedPath,
      });

      const events = await stream.waitForEvents(5);
      expect(events.map((event) => event.kind)).toEqual([
        "folder_created",
        "file_created",
        "folder_metadata_changed",
        "content_persisted",
        "file_moved",
      ]);
      expect(events[0]).toMatchObject({
        path: folder,
        actor: { kind: "user" },
      });
      expect(events[3]).toMatchObject({
        path: notePath,
        actor: { kind: "system" },
      });
      expect(events[4]).toMatchObject({
        fromPath: notePath,
        toPath: movedPath,
        actor: { kind: "user" },
      });
      expect(stream.raw()).not.toContain(secret);
    } finally {
      await stream.close();
      await server.close();
    }
  });

  it("covers vault info and non-live folder route branches", async () => {
    const { app } = await setupScopedVault();

    const mkdirResponse = await app.request(folderPath(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "folder" }),
    });
    expect(mkdirResponse.status).toBe(201);
    await expect(mkdirResponse.json()).resolves.toMatchObject({
      ok: true,
      path: "folder",
    });

    await app.request(filePath("folder/file.md"), {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    const blockedDelete = await app.request(folderPath("folder"), {
      method: "DELETE",
    });
    expect(blockedDelete.status).toBe(409);
    await expect(blockedDelete.json()).resolves.toMatchObject({
      ok: false,
      error: "folder_not_empty",
    });

    const moved = await app.request(`${folderPath("folder")}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "moved/folder" }),
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: "folder",
      toPath: "moved/folder",
    });

    const deleted = await app.request(
      `${folderPath("moved/folder")}?recursive=true`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      ok: true,
      path: "moved/folder",
    });

    const info = await app.request(`/api/vaults/${VAULT}/vault`);
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({
      ok: true,
      rootName: VAULT,
    });

    const missing = await app.request(`${filePath("missing.md")}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "next.md" }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("proxies non-API requests to the configured Vite dev server", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(`proxied ${request.method} ${request.url}`);
    });
    await listen(upstream);
    const port = (upstream.address() as AddressInfo).port;

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({
      statusFile: config.statusFile,
      webProxyTarget: `http://127.0.0.1:${port}`,
    });

    const rootResponse = await app.request("/");
    const clientRouteResponse = await app.request("/status?from=test");

    expect(rootResponse.status).toBe(200);
    await expect(rootResponse.text()).resolves.toBe("proxied GET /");

    expect(clientRouteResponse.status).toBe(200);
    await expect(clientRouteResponse.text()).resolves.toBe(
      "proxied GET /status?from=test",
    );

    await close(upstream);
  });

  it("returns an instructional response when no UI build is available", async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), "kb2-web-build-missing-"));
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
      },
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const response = await app.request("/");
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("KB-2 local UI is not built yet.");
    expect(body).toContain("pnpm dev");

    await rm(webBuildDir, { force: true, recursive: true });
  });
});

function fakeRelayLifecycleController(): RelayLifecycleController & {
  connectCalls: number;
  disconnectCalls: number;
} {
  let connected = false;
  const status = (): RelayLifecycleStatus => ({
    configured: true,
    started: connected,
    controlConnected: connected,
    reconnectScheduled: false,
  });
  return {
    connectCalls: 0,
    disconnectCalls: 0,
    status,
    connect() {
      this.connectCalls += 1;
      connected = true;
      return status();
    },
    disconnect() {
      this.disconnectCalls += 1;
      connected = false;
      return status();
    },
  };
}

interface StartedHttpApp {
  origin: string;
  close: () => Promise<void>;
}

async function startHttpApp(app: Hono): Promise<StartedHttpApp> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
      },
      (info) => {
        resolve({
          origin: `http://${info.address}:${info.port}`,
          close: () => closeStartedHttpApp(server),
        });
      },
    );
    server.once("error", reject);
  });
}

function closeStartedHttpApp(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

interface OpenSseStream {
  waitForEvents: (count: number) => Promise<VaultChangeEvent[]>;
  raw: () => string;
  close: () => Promise<void>;
}

async function openSseStream(url: string): Promise<OpenSseStream> {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) {
    throw new Error("Expected SSE response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: VaultChangeEvent[] = [];
  let raw = "";
  let buffer = "";
  let notify: (() => void) | undefined;

  const pump = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const text = decoder.decode(chunk.value, { stream: true });
        raw += text;
        buffer += text;
        parseSseBuffer();
        notify?.();
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();

  function parseSseBuffer(): void {
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      if (data) {
        events.push(JSON.parse(data) as VaultChangeEvent);
      }
      separator = buffer.indexOf("\n\n");
    }
  }

  return {
    waitForEvents: async (count) => {
      const deadline = Date.now() + 3000;
      while (events.length < count && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 25);
        });
      }
      if (events.length < count) {
        throw new Error(
          `Timed out waiting for ${count} SSE events; got ${JSON.stringify(events)}`,
        );
      }
      return events.slice(0, count);
    },
    raw: () => raw,
    close: async () => {
      abort.abort();
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
    },
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

async function fetchText(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  return fetchJson(url, init);
}

function encodeVaultPath(vaultPath: string): string {
  return vaultPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function connectMcpClient(
  app: Hono,
  clientName: string,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1/mcp"),
    {
      fetch: async (input, init) =>
        app.fetch(input instanceof Request ? input : new Request(input, init)),
    },
  );
  await client.connect(transport);
  return { client, transport };
}

async function mcpToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    mcpText(await client.callTool({ name, arguments: args })),
  ) as Record<string, unknown>;
}

function mcpText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!Array.isArray(result.content)) {
    throw new Error("Expected MCP content array");
  }
  const first = result.content[0] as
    | { type?: unknown; text?: unknown }
    | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected text MCP content");
  }
  return first.text;
}

function parseMcpRejection(
  result: Awaited<ReturnType<Client["callTool"]>>,
  toolName: string,
): Record<string, unknown> {
  const prefix = `${toolName} rejected: `;
  const text = mcpText(result);
  if (!text.startsWith(prefix)) {
    throw new Error(`Expected ${toolName} rejection, got ${text}`);
  }
  return JSON.parse(text.slice(prefix.length)) as Record<string, unknown>;
}

function serviceFailureFromContract(expected: object): Record<string, unknown> {
  if ("rejected" in expected) {
    const { rejected, ...rest } = expected as { rejected: string } & Record<
      string,
      unknown
    >;
    return { ...rest, error: rejected };
  }
  return expected as Record<string, unknown>;
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readAuditRows(
  root: string,
): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(
    join(root, ".kb2/audit/changes.jsonl"),
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readRawFolderMetadata(root: string): Promise<string> {
  return readFile(join(root, ".kb2/folders.yml"), "utf8");
}

async function readRawFileHistory(root: string): Promise<string> {
  return readFile(join(root, ".kb2/file-history.yml"), "utf8");
}

async function writeFileWithParents(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
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
