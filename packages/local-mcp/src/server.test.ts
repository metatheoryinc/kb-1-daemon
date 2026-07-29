import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";

import { createLocalMcpEndpoint } from "./server.js";
import type {
  LocalMcpVaultService,
  ServiceResult,
  VaultActor,
} from "./types.js";

const CORAL = "#fda4af";
const MINT = "#a7f3d0";
type ServiceInput<Name extends keyof LocalMcpVaultService> =
  Parameters<LocalMcpVaultService[Name]>[0];

describe("local MCP server", () => {
  it("rejects requests that do not carry or initialize a valid MCP session", async () => {
    const endpoint = createLocalMcpEndpoint(emptyService());

    const getResponse = await endpoint.handleRequest(
      new Request("http://127.0.0.1/mcp"),
    );
    expect(getResponse.status).toBe(400);
    await expect(getResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid MCP session id provided",
      },
      id: null,
    });

    const postResponse = await endpoint.handleRequest(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      }),
    );
    expect(postResponse.status).toBe(400);
    await expect(postResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid MCP session id provided",
      },
      id: null,
    });

    await endpoint.close();
  });

  it("waits for an accepted initialization request before closing sessions", async () => {
    const endpoint = createLocalMcpEndpoint(emptyService());
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "init-race-test", version: "1.0.0" },
        },
      }),
    });
    const cloneRequest = request.clone.bind(request);
    let releaseParsing: (() => void) | undefined;
    const parseGate = new Promise<void>((resolve) => {
      releaseParsing = resolve;
    });
    let markParsingStarted: (() => void) | undefined;
    const parsingStarted = new Promise<void>((resolve) => {
      markParsingStarted = resolve;
    });
    vi.spyOn(request, "clone").mockImplementation(() => {
      const clone = cloneRequest();
      const parseJson = clone.json.bind(clone);
      vi.spyOn(clone, "json").mockImplementation(async () => {
        markParsingStarted?.();
        await parseGate;
        return parseJson();
      });
      return clone;
    });

    const initialization = endpoint.handleRequest(request);
    await within(parsingStarted, "initialization parsing did not start");
    let closeResolved = false;
    const closing = endpoint.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseParsing?.();
    const response = await within(
      initialization,
      "initialization did not finish",
    );
    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(closeResolved).toBe(false);
    const responseBody = await within(
      response.text(),
      "initialization response body did not finish",
    );
    expect(responseBody).toContain('"serverInfo"');
    await within(closing, "endpoint close did not finish after initialization");
  });

  it("finishes draining when an admitted response body is cancelled", async () => {
    const endpoint = createLocalMcpEndpoint(emptyService());
    const response = await endpoint.handleRequest(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "cancel-test", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    let closeResolved = false;
    const closing = endpoint.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    await response.body?.cancel("client disconnected");
    await within(closing, "endpoint close did not finish after cancellation");
  });

  it("releases request tracking when dispatch rejects", async () => {
    const endpoint = createLocalMcpEndpoint(emptyService());
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    vi.spyOn(request, "clone").mockImplementation(() => {
      throw new Error("request body unavailable");
    });

    await expect(endpoint.handleRequest(request)).rejects.toThrow(
      "request body unavailable",
    );
    await within(
      endpoint.close(),
      "endpoint close did not finish after dispatch rejection",
    );
  });

  it("registers every tier-1 tool and forwards calls to the injected service with initialize attribution", async () => {
    const mutationActors: VaultActor[] = [];
    const fixturePath = fileURLToPath(new URL("./server.test.ts", import.meta.url));
    const service: LocalMcpVaultService = {
      vaultInfo: async () => ({
        ok: true,
        rootName: "demo-vault",
        fileCount: 1,
        folderCount: 1,
      }),
      listFiles: async (input: ServiceInput<"listFiles">) => ({
        ok: true,
        entries: [
          {
            path: input.under ?? "note.md",
            kind: input.under ? "folder" : "file",
            size: 4,
            mtimeMs: 1,
            artifact: input.under
              ? undefined
              : {
                  kind: "text",
                  contentType: "text/markdown; charset=utf-8",
                  editable: true,
                  preview: "markdown",
                },
            metadata: input.under ? { color: CORAL } : undefined,
          },
          ...(input.under
            ? []
            : [
                {
                  path: "assets/pixel.png",
                  kind: "file" as const,
                  size: 8,
                  mtimeMs: 2,
                  artifact: {
                    kind: "attachment" as const,
                    contentType: "image/png",
                    editable: false,
                    preview: "image",
                  },
                },
              ]),
        ],
      }),
      listFolderMetadata: async () => ({
        ok: true,
        folders: { notes: { color: CORAL } },
      }),
      getFolderMetadata: async (input: ServiceInput<"getFolderMetadata">) => ({
        ok: true,
        path: input.path,
        metadata: { color: CORAL },
      }),
      setFolderMetadata: async (input: ServiceInput<"setFolderMetadata">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          metadata: {
            ...(input.metadata.color ? { color: input.metadata.color } : {}),
          },
          audit: audit(input.actor, "write"),
        }),
      readNote: async () => ({
        ok: true,
        path: "note.md",
        content: "alpha beta",
        baseline: "b1",
        size: 10,
        mtimeMs: 1,
      }),
      readRawFile: async (input: ServiceInput<"readRawFile">) => ({
        ok: true,
        path: input.path,
        filePath: fixturePath,
        size: 8,
        mtimeMs: 2,
        artifact: {
          kind: "attachment",
          contentType: "image/png",
          editable: false,
          preview: "image",
        },
      }),
      writeRawFile: async (input: ServiceInput<"writeRawFile">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          size: input.bytes.byteLength,
          mtimeMs: 3,
          artifact: {
            kind: "attachment" as const,
            contentType: "image/png",
            editable: false,
            preview: "image" as const,
          },
          audit: audit(input.actor, "create"),
        }),
      createNote: async (input: ServiceInput<"createNote">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          audit: audit(input.actor, "create"),
        }),
      editNote: async (input: ServiceInput<"editNote">) =>
        recordActor(
          mutationActors,
          input.actor,
          input.baseline === "stale"
            ? {
                ok: false,
                error: "stale_doc",
                message: "document changed since the provided baseline",
                current_content: "alpha beta",
                baseline: "fresh",
              }
            : {
                ok: true,
                path: input.path,
                content: input.newText,
                baseline: "b2",
                audit: audit(input.actor, "splice"),
              },
        ),
      appendNote: async (input: ServiceInput<"appendNote">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          content: input.content,
          baseline: "b3",
          audit: audit(input.actor, "append"),
        }),
      prependNote: async (input: ServiceInput<"prependNote">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          content: input.content,
          baseline: "b4",
          audit: audit(input.actor, "prepend"),
        }),
      deleteNote: async (input: ServiceInput<"deleteNote">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          permanent: input.permanent,
          audit: audit(input.actor, "delete"),
        }),
      moveNote: async (input: ServiceInput<"moveNote">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          fromPath: input.fromPath,
          toPath: input.toPath,
          kind: "file",
          audit: audit(input.actor, "move"),
        }),
      createFolder: async (input: ServiceInput<"createFolder">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          audit: audit(input.actor, "mkdir"),
        }),
      deleteFolder: async (input: ServiceInput<"deleteFolder">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          permanent: input.permanent,
          liveDeleted: [],
          audit: audit(input.actor, "delete"),
        }),
      moveFolder: async (input: ServiceInput<"moveFolder">) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          fromPath: input.fromPath,
          toPath: input.toPath,
          liveMoved: [],
          audit: audit(input.actor, "move"),
        }),
      search: async () => ({
        ok: true,
        total: 1,
        results: [
          {
            path: "note.md",
            line: 1,
            lineText: "alpha beta",
            context: { before: [], after: [] },
          },
        ],
        truncated: false,
      }),
    };
    const endpoint = createLocalMcpEndpoint(service);
    const client = new Client({ name: "sdk-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1/mcp"),
      {
        fetch: async (input, init) =>
          endpoint.handleRequest(
            input instanceof Request ? input : new Request(input, init),
          ),
      },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "append_note",
      "create_folder",
      "create_note",
      "delete_folder",
      "delete_note",
      "edit_note",
      "get_folder_metadata",
      "list_attachments",
      "list_files",
      "list_vaults",
      "move_folder",
      "move_note",
      "prepend_note",
      "read_attachment",
      "read_note",
      "search",
      "set_folder_metadata",
      "upload_attachment",
      "vault_info",
    ]);

    // Every vault-data tool advertises the required vaultId; list_vaults does not.
    const vaultInfoTool = tools.tools.find(
      (tool) => tool.name === "vault_info",
    );
    expect(vaultInfoTool?.inputSchema.properties).toHaveProperty("vaultId");
    expect(vaultInfoTool?.inputSchema.required ?? []).toContain("vaultId");
    const listVaultsTool = tools.tools.find(
      (tool) => tool.name === "list_vaults",
    );
    expect(listVaultsTool?.inputSchema.properties ?? {}).not.toHaveProperty(
      "vaultId",
    );

    // A bare service normalizes to a single vault addressed by the synthetic
    // 'default' id; every data tool must pass it (there is no default fallback).
    const V = "default";
    expect(await toolJson(client, "vault_info", { vaultId: V })).toMatchObject({
      ok: true,
      rootName: "demo-vault",
    });
    expect(
      await toolJson(client, "list_files", {
        vaultId: V,
        under: "notes",
        depth: 1,
      }),
    ).toMatchObject({
      ok: true,
      entries: [{ path: "notes", metadata: { color: CORAL } }],
    });
    expect(
      await toolJson(client, "list_attachments", { vaultId: V }),
    ).toMatchObject({
      ok: true,
      attachments: [{ path: "assets/pixel.png", preview: "image" }],
    });
    expect(
      await toolJson(client, "get_folder_metadata", {
        vaultId: V,
        path: "notes",
      }),
    ).toMatchObject({ ok: true, path: "notes", metadata: { color: CORAL } });
    expect(
      await toolJson(client, "set_folder_metadata", {
        vaultId: V,
        path: "notes",
        color: MINT,
      }),
    ).toMatchObject({ ok: true, path: "notes", metadata: { color: MINT } });
    expect(
      await toolJson(client, "read_note", { vaultId: V, path: "note.md" }),
    ).toMatchObject({ ok: true, baseline: "b1" });
    expect(
      await toolJson(client, "read_attachment", {
        vaultId: V,
        path: "assets/pixel.png",
      }),
    ).toMatchObject({ ok: true, path: "assets/pixel.png", preview: "image" });
    expect(
      await toolJson(client, "upload_attachment", {
        vaultId: V,
        path: "assets/agent.png",
        content_base64: Buffer.from("tiny").toString("base64"),
      }),
    ).toMatchObject({ ok: true, path: "assets/agent.png", size: 4 });
    expect(
      await toolJson(client, "create_note", {
        vaultId: V,
        path: "created.md",
        content: "created",
      }),
    ).toMatchObject({ ok: true, path: "created.md" });
    expect(
      await toolJson(client, "edit_note", {
        vaultId: V,
        path: "note.md",
        baseline: "b1",
        old_text: "alpha",
        new_text: "ALPHA",
      }),
    ).toMatchObject({ ok: true, content: "ALPHA" });
    expect(
      await toolJson(client, "append_note", {
        vaultId: V,
        path: "note.md",
        content: "\nnext",
      }),
    ).toMatchObject({ ok: true, baseline: "b3" });
    expect(
      await toolJson(client, "prepend_note", {
        vaultId: V,
        path: "note.md",
        content: "first\n",
      }),
    ).toMatchObject({ ok: true, baseline: "b4" });
    expect(
      await toolJson(client, "delete_note", { vaultId: V, path: "note.md" }),
    ).toMatchObject({ ok: true, path: "note.md" });
    expect(
      await toolJson(client, "move_note", {
        vaultId: V,
        from_path: "note.md",
        to_path: "moved.md",
      }),
    ).toMatchObject({ ok: true, toPath: "moved.md" });
    expect(
      await toolJson(client, "create_folder", { vaultId: V, path: "folder" }),
    ).toMatchObject({ ok: true, path: "folder" });
    expect(
      await toolJson(client, "delete_folder", {
        vaultId: V,
        path: "folder",
        recursive: true,
      }),
    ).toMatchObject({ ok: true, path: "folder" });
    expect(
      await toolJson(client, "move_folder", {
        vaultId: V,
        from_path: "old",
        to_path: "new",
      }),
    ).toMatchObject({ ok: true, toPath: "new" });
    expect(
      await toolJson(client, "search", { vaultId: V, query: "alpha" }),
    ).toMatchObject({ ok: true, total: 1 });

    // list_vaults is the discovery entry point and takes no vaultId.
    expect(await toolJson(client, "list_vaults", {})).toMatchObject({
      ok: true,
      vaults: [{ id: "default", displayName: "default" }],
    });

    // An unknown vaultId is a clean tool error rather than a crash.
    const unknownVault = await client.callTool({
      name: "vault_info",
      arguments: { vaultId: "missing" },
    });
    expect(unknownVault.isError).toBe(true);
    expect(textContent(unknownVault)).toBe(
      'vault_info rejected: {"ok":false,"error":"not_found","message":"No vault with id \\"missing\\"."}',
    );

    // A data-tool call WITHOUT vaultId is rejected (the param is required).
    const missingVaultId = await client.callTool({
      name: "vault_info",
      arguments: {},
    });
    expect(missingVaultId.isError).toBe(true);

    const stale = await client.callTool({
      name: "edit_note",
      arguments: {
        vaultId: V,
        path: "note.md",
        baseline: "stale",
        old_text: "alpha",
        new_text: "ALPHA",
      },
    });
    expect(stale.isError).toBe(true);
    expect(textContent(stale)).toBe(
      'edit_note rejected: {"ok":false,"error":"stale_doc","message":"document changed since the provided baseline","current_content":"alpha beta","baseline":"fresh"}',
    );

    expect(mutationActors).toHaveLength(12);
    expect(
      mutationActors.every(
        (actor) =>
          actor.kind === "mcp_client" &&
          actor.id === "local agent" &&
          actor.name === "local agent" &&
          actor.client === "sdk-test-client",
      ),
    ).toBe(true);

    await transport.terminateSession();
    await endpoint.close();
  });

  it("uses the endpoint-provided actor for an initialized MCP session", async () => {
    const mutationActors: VaultActor[] = [];
    const service = {
      ...emptyService(),
      createNote: async (input: {
        path: string;
        content: string;
        overwrite?: boolean;
        actor: VaultActor;
      }) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          audit: audit(input.actor, "create"),
        }),
    } satisfies LocalMcpVaultService;
    const actor: VaultActor = {
      kind: "integration",
      id: "integration-1",
      name: "Integration One",
      client: "sdk-test-client",
    };
    const endpoint = createLocalMcpEndpoint(service, {
      actorFromRequest: () => actor,
    });
    const client = new Client({ name: "sdk-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1/mcp"),
      {
        fetch: async (input, init) =>
          endpoint.handleRequest(
            input instanceof Request ? input : new Request(input, init),
          ),
      },
    );

    await client.connect(transport);
    expect(
      await toolJson(client, "create_note", {
        vaultId: "default",
        path: "created.md",
        content: "created",
      }),
    ).toMatchObject({ ok: true, path: "created.md" });

    expect(mutationActors).toEqual([actor]);

    await transport.terminateSession();
    await endpoint.close();
  });

  it("waits for an in-flight tool mutation before closing MCP transports", async () => {
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    let markMutationFinished: (() => void) | undefined;
    const mutationFinished = new Promise<void>((resolve) => {
      markMutationFinished = resolve;
    });
    const service = {
      ...emptyService(),
      appendNote: async () => {
        markMutationStarted?.();
        await mutationGate;
        markMutationFinished?.();
        return { ok: true as const };
      },
    } satisfies LocalMcpVaultService;
    const endpoint = createLocalMcpEndpoint(service);
    const client = new Client({ name: "drain-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1/mcp"),
      {
        fetch: async (input, init) =>
          endpoint.handleRequest(
            input instanceof Request ? input : new Request(input, init),
          ),
      },
    );

    await client.connect(transport);
    const mutation = toolJson(client, "append_note", {
      vaultId: "default",
      path: "note.md",
      content: "pending",
    });
    await within(mutationStarted, "mutation did not start");

    let closeResolved = false;
    const closing = endpoint.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseMutation?.();
    await within(mutationFinished, "mutation service did not finish");
    await within(closing, "endpoint close did not finish");
    await expect(within(mutation, "mutation did not finish")).resolves.toEqual({
      ok: true,
    });

    const rejected = await endpoint.handleRequest(
      new Request("http://127.0.0.1/mcp"),
    );
    expect(rejected.status).toBe(503);
  });

  it("drains an admitted request whose tool starts during shutdown", async () => {
    let sessionId: string | null = null;
    let markMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const service = {
      ...emptyService(),
      appendNote: async () => {
        markMutationStarted?.();
        return { ok: true as const };
      },
    } satisfies LocalMcpVaultService;
    const endpoint = createLocalMcpEndpoint(service);
    const client = new Client({
      name: "admission-drain-test-client",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1/mcp"),
      {
        fetch: async (input, init) => {
          const response = await endpoint.handleRequest(
            input instanceof Request ? input : new Request(input, init),
          );
          sessionId ??= response.headers.get("mcp-session-id");
          return response;
        },
      },
    );
    await client.connect(transport);
    expect(sessionId).toBeTruthy();

    let releaseBody: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                  name: "append_note",
                  arguments: {
                    vaultId: "default",
                    path: "note.md",
                    content: "admitted",
                  },
                },
              }),
            ),
          );
          controller.close();
        };
      },
    });
    const admittedRequest = endpoint.handleRequest(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId!,
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    const closing = endpoint.close();

    releaseBody?.();
    await within(mutationStarted, "admitted mutation did not start");
    const response = await within(
      admittedRequest,
      "admitted request did not finish",
    );
    expect(response.status).toBe(200);
    const responseBody = await within(
      response.text(),
      "admitted request response body did not finish",
    );
    expect(responseBody).toContain('"id":2');
    expect(responseBody).toContain('"result"');
    await within(closing, "endpoint close did not finish");
  });
});

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function toolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    textContent(await client.callTool({ name, arguments: args })),
  ) as Record<string, unknown>;
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
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

function recordActor<T extends ServiceResult>(
  actors: VaultActor[],
  actor: VaultActor,
  result: T,
): T {
  actors.push(actor);
  return result;
}

type AuditOperation =
  | "create"
  | "write"
  | "mkdir"
  | "delete"
  | "move"
  | "splice"
  | "append"
  | "prepend";

function audit(actor: VaultActor, operation: AuditOperation) {
  return {
    id: `${operation}-1`,
    ts: "2026-06-11T00:00:00.000Z",
    actor,
    operation,
    entityKind: "file" as const,
    path: "note.md",
    summary: operation,
  };
}

function emptyService(): LocalMcpVaultService {
  const ok = async (): Promise<ServiceResult> => ({ ok: true });
  const actor: VaultActor = { kind: "system" };
  return {
    vaultInfo: ok,
    listFiles: ok,
    readRawFile: async (input) => ({
      ok: true,
      path: input.path,
      filePath: fileURLToPath(new URL("./server.test.ts", import.meta.url)),
      size: 1,
      mtimeMs: 1,
      artifact: {
        kind: "attachment",
        contentType: "application/octet-stream",
        editable: false,
        preview: "download",
      },
    }),
    writeRawFile: async (input) => ({
      ok: true,
      path: input.path,
      size: input.bytes.byteLength,
      mtimeMs: 1,
      artifact: {
        kind: "attachment",
        contentType: "application/octet-stream",
        editable: false,
        preview: "download",
      },
      audit: audit(actor, "write"),
    }),
    readNote: ok,
    createNote: ok,
    listFolderMetadata: ok,
    getFolderMetadata: ok,
    setFolderMetadata: ok,
    editNote: ok,
    appendNote: ok,
    prependNote: ok,
    deleteNote: ok,
    moveNote: ok,
    createFolder: ok,
    deleteFolder: ok,
    moveFolder: ok,
    search: ok,
  };
}
