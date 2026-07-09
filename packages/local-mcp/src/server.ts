import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

import type {
  LocalMcpActor,
  LocalMcpVaultProvider,
  LocalMcpVaultService,
  ServiceFailure,
} from "./types.js";

const localAgentActor = (client: string): LocalMcpActor => ({
  kind: "mcp_client",
  id: "local agent",
  name: "local agent",
  client,
});
const unknownActor: LocalMcpActor = localAgentActor("unknown local caller");

/** The single synthetic vault id used when the endpoint is built from a bare service. */
const SINGLE_VAULT_ID = "default";
const MAX_INLINE_ATTACHMENT_BYTES = 4 * 1024;

export interface LocalMcpEndpoint {
  handleRequest(request: Request): Promise<Response>;
  close(): Promise<void>;
}

interface LocalMcpEndpointOptions {
  actorFromRequest?: (
    request: Request,
  ) => LocalMcpActor | ServiceFailure | undefined;
}

interface LocalMcpServerOptions {
  actor?: LocalMcpActor;
}

interface SessionRecord {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

/**
 * Accepts either a live multi-vault provider (the daemon's registry adapter) or
 * a bare service for the legacy single-vault path. Both wire the same one MCP
 * endpoint; a bare service is normalized to a one-vault provider so the tool
 * surface is identical either way.
 */
type LocalMcpVaultSource = LocalMcpVaultProvider | LocalMcpVaultService;

export function createLocalMcpEndpoint(
  source: LocalMcpVaultSource,
  options: LocalMcpEndpointOptions = {},
): LocalMcpEndpoint {
  const provider = asProvider(source);
  const sessions = new Map<string, SessionRecord>();

  return {
    async handleRequest(request) {
      const sessionId = request.headers.get("mcp-session-id") ?? undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        return existing.transport.handleRequest(request);
      }

      const parsedBody =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      if (request.method !== "POST" || !isInitializeRequest(parsedBody)) {
        return jsonRpcError(
          "Bad Request: No valid MCP session id provided",
          400,
        );
      }

      const actor = options.actorFromRequest?.(request);
      if (isServiceFailure(actor)) {
        return jsonRpcError(`Bad Request: ${actor.message}`, 400);
      }

      let assignedSessionId: string | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (nextSessionId) => {
          assignedSessionId = nextSessionId;
        },
      });
      const server = createLocalMcpServer(provider, { actor });

      transport.onclose = () => {
        const id = transport.sessionId ?? assignedSessionId;
        if (id) sessions.delete(id);
      };

      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody });
      const id = transport.sessionId ?? assignedSessionId;
      if (id) {
        sessions.set(id, { server, transport });
      }
      return response;
    },
    async close() {
      const records = [...sessions.values()];
      sessions.clear();
      await Promise.all(records.map(({ server }) => server.close()));
    },
  };
}

export function createLocalMcpServer(
  source: LocalMcpVaultSource,
  options: LocalMcpServerOptions = {},
): McpServer {
  const provider = asProvider(source);
  const server = new McpServer({
    // Coordinated wire identifier: keep byte-for-byte stable until all clients
    // and the cloud relay are migrated together.
    name: "kb-1-local-daemon",
    version: "0.0.0",
  });

  const actor = (): LocalMcpActor => {
    if (options.actor) return options.actor;
    const client = server.server.getClientVersion()?.name?.trim();
    return client ? localAgentActor(client) : unknownActor;
  };

  // Resolve the addressed vault's service. vaultId is required on every data
  // tool — there is no default vault. An unknown vaultId returns a clean
  // tool-level failure rather than throwing.
  const resolve = (
    vaultId: string,
  ): { ok: true; service: LocalMcpVaultService } | ServiceFailure => {
    const service = provider.resolve(vaultId);
    if (!service) {
      return {
        ok: false,
        error: "not_found",
        message: `No vault with id "${vaultId}".`,
      };
    }
    return { ok: true, service };
  };

  /** The required `vaultId` field shared by every vault-data tool's input schema. */
  const vaultIdField = {
    vaultId: z
      .string()
      .describe(
        "Vault slug to target (required). Discover ids with list_vaults.",
      ),
  };

  registerTool<{}>(
    server,
    "list_vaults",
    {
      description:
        "List every vault this daemon serves, each as { id, displayName, metadata? }. Use a vault id as the required vaultId parameter on any other tool to target that vault. Read-only; writes no audit row.",
      inputSchema: {},
    },
    async () => ({ ok: true, vaults: provider.list() }),
  );

  registerVaultTool<{}>(
    server,
    resolve,
    "vault_info",
    {
      description:
        "Return the vault root name plus file and folder counts. Read-only; writes no audit row.",
      inputSchema: {},
    },
    (service) => service.vaultInfo(),
  );

  registerVaultTool<{ under?: string; depth?: number }>(
    server,
    resolve,
    "list_files",
    {
      description:
        "List files and folders under a vault folder, including inline metadata on folder entries. Depth and entry caps mirror the daemon API. Read-only; writes no audit row.",
      inputSchema: {
        under: z
          .string()
          .optional()
          .describe("Folder path to list under. Omit for the vault root."),
        depth: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Maximum recursive depth to return."),
      },
    },
    (service, input) => service.listFiles(input),
  );

  registerVaultTool<{ folder?: string; kind?: "image" | "attachment" }>(
    server,
    resolve,
    "list_attachments",
    {
      description:
        "List binary attachments in a vault, optionally scoped to a folder and/or images only. Markdown/text documents are excluded; use list_files for editable notes.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional folder path. Omit for the vault root."),
        kind: z
          .enum(["image", "attachment"])
          .optional()
          .describe("Use image for image files, attachment for non-image binaries."),
      },
    },
    async (service, input) => {
      const listed = await service.listFiles({
        under: input.folder,
        depth: Number.MAX_SAFE_INTEGER,
      });
      if (!listed.ok) return listed;
      return {
        ok: true,
        attachments: attachmentRows(listed as { entries?: unknown }, input.kind),
      };
    },
  );

  registerVaultTool<{ path: string }>(
    server,
    resolve,
    "read_attachment",
    {
      description:
        "Read a binary attachment by vault-relative path. Images are returned as a native MCP image block plus metadata; non-image attachments return base64 text.",
      inputSchema: {
        path: z.string().describe("Vault-relative attachment path."),
      },
    },
    async (service, input) => {
      const result = await service.readRawFile({ path: input.path });
      if (!result.ok) return result;
      if (result.artifact.kind !== "attachment") {
        return {
          ok: false,
          error: "invalid_request",
          message: `"${input.path}" is an editable text document, not an attachment. Use read_note instead.`,
        };
      }

      const contentBase64 = (await readFile(result.filePath)).toString("base64");
      const metadata = {
        path: result.path,
        contentType: result.artifact.contentType,
        preview: result.artifact.preview,
        size: result.size,
        mtimeMs: result.mtimeMs,
      };
      if (result.artifact.preview === "image") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, ...metadata }, null, 2) },
            {
              type: "image",
              data: contentBase64,
              mimeType: result.artifact.contentType,
            },
          ],
        };
      }

      return {
        ok: true,
        ...metadata,
        contentBase64,
      };
    },
  );

  registerVaultTool<{
    path: string;
    content_base64: string;
    overwrite?: boolean;
  }>(server, resolve, "upload_attachment", {
    description:
      "Upload a tiny binary attachment inline as base64. The destination path is vault-relative and explicit. Inline uploads are capped at 4 KiB; larger attachment side-channel upload is a follow-up.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative destination path, e.g. assets/screenshot.png."),
      content_base64: z
        .string()
        .refine((value) => base64ByteUpperBound(value) <= MAX_INLINE_ATTACHMENT_BYTES, {
          message:
            "content_base64 decodes to more than 4 KiB. Inline attachment uploads are capped at 4 KiB.",
        })
        .describe("Raw file bytes encoded as base64, without a data URL prefix."),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace an existing file at path when true."),
    },
  }, async (service, input) => {
    if (!isAttachmentPath(input.path)) {
      return {
        ok: false,
        error: "invalid_request",
        message: "upload_attachment only writes binary attachment paths, not editable text documents.",
      };
    }
    const bytes = decodeBase64(input.content_base64);
    if (!bytes) {
      return {
        ok: false,
        error: "invalid_request",
        message: "content_base64 is not valid base64.",
      };
    }
    return service.writeRawFile({
      path: input.path,
      bytes,
      overwrite: input.overwrite,
      actor: actor(),
    });
  });

  registerVaultTool<{ path: string }>(
    server,
    resolve,
    "get_folder_metadata",
    {
      description:
        "Read durable folder color metadata from .kb1/folders.yml. Read-only; writes no audit row.",
      inputSchema: {
        path: z.string().describe("Vault-relative folder path."),
      },
    },
    (service, input) => service.getFolderMetadata(input),
  );

  registerVaultTool<{
    path: string;
    color?: string | null;
  }>(
    server,
    resolve,
    "set_folder_metadata",
    {
      description:
        "Merge durable folder color metadata into .kb1/folders.yml. Use null to clear the color. Mutations are audited as mcp_client.",
      inputSchema: {
        path: z.string().describe("Vault-relative folder path."),
        color: z
          .string()
          .nullable()
          .optional()
          .describe("Hex color or inherit to set, or null to clear."),
      },
    },
    (service, input) =>
      service.setFolderMetadata({
        path: input.path,
        metadata: {
          ...(Object.prototype.hasOwnProperty.call(input, "color")
            ? { color: input.color }
            : {}),
        },
        actor: actor(),
      }),
  );

  registerVaultTool<{ path: string }>(
    server,
    resolve,
    "read_note",
    {
      description:
        "Read a Markdown note and return content, stat fields, and baseline. Use baseline for edit_note retry loops. Read-only; writes no audit row.",
      inputSchema: {
        path: z.string().describe("Vault-relative Markdown file path."),
      },
    },
    (service, input) => service.readNote(input),
  );

  registerVaultTool<{ path: string; content: string; overwrite?: boolean }>(
    server,
    resolve,
    "create_note",
    {
      description:
        "Create a Markdown note without clobbering by default. Set overwrite to replace existing content. Mutations are audited as mcp_client.",
      inputSchema: {
        path: z
          .string()
          .describe("Vault-relative Markdown file path to create."),
        content: z.string().default("").describe("Full note content."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace an existing note when true."),
      },
    },
    (service, input) =>
      service.createNote({
        path: input.path,
        content: input.content,
        overwrite: input.overwrite,
        actor: actor(),
      }),
  );

  registerVaultTool<{
    path: string;
    baseline: string;
    old_text: string;
    new_text: string;
    before?: string;
    after?: string;
    occurrence?: number;
  }>(
    server,
    resolve,
    "edit_note",
    {
      description:
        "Apply the anchored splice contract. Requires a read_note baseline plus old_text/new_text and optional before/after/occurrence anchors. Rejected results are returned intact: stale_doc includes current_content and fresh baseline; ambiguous includes match_count; size rejects include limits; persist_failed means the edit was not durably saved and has no success audit row.",
      inputSchema: {
        path: z.string().describe("Vault-relative Markdown file path to edit."),
        baseline: z.string().describe("Baseline returned by read_note."),
        old_text: z.string().describe("Text to replace, LF-normalized."),
        new_text: z.string().describe("Replacement text, LF-normalized."),
        before: z
          .string()
          .optional()
          .describe(
            "Optional text immediately before old_text for disambiguation.",
          ),
        after: z
          .string()
          .optional()
          .describe(
            "Optional text immediately after old_text for disambiguation.",
          ),
        occurrence: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "1-based match occurrence to edit when anchors still match multiple ranges.",
          ),
      },
    },
    (service, input) =>
      service.editNote({
        path: input.path,
        baseline: input.baseline,
        oldText: input.old_text,
        newText: input.new_text,
        before: input.before,
        after: input.after,
        occurrence: input.occurrence,
        actor: actor(),
      }),
  );

  registerVaultTool<{ path: string; content: string }>(
    server,
    resolve,
    "append_note",
    {
      description:
        "Append content to a note, creating it when missing. Mutations flow through live sessions and are audited as mcp_client.",
      inputSchema: {
        path: z.string().describe("Vault-relative Markdown file path."),
        content: z.string().describe("Content to append."),
      },
    },
    (service, input) =>
      service.appendNote({
        path: input.path,
        content: input.content,
        actor: actor(),
      }),
  );

  registerVaultTool<{ path: string; content: string }>(
    server,
    resolve,
    "prepend_note",
    {
      description:
        "Prepend content to an existing note after frontmatter when present. Mutations flow through live sessions and are audited as mcp_client.",
      inputSchema: {
        path: z.string().describe("Vault-relative Markdown file path."),
        content: z.string().describe("Content to prepend."),
      },
    },
    (service, input) =>
      service.prependNote({
        path: input.path,
        content: input.content,
        actor: actor(),
      }),
  );

  registerVaultTool<{ path: string; permanent?: boolean }>(
    server,
    resolve,
    "delete_note",
    {
      description:
        "Delete a note. By default it is moved into .kb1/trash; set permanent for an irreversible delete. Mutations are audited as mcp_client.",
      inputSchema: {
        path: z.string().describe("Vault-relative Markdown file path."),
        permanent: z
          .boolean()
          .optional()
          .describe("Permanently remove instead of moving to trash."),
      },
    },
    (service, input) =>
      service.deleteNote({
        path: input.path,
        permanent: input.permanent,
        actor: actor(),
      }),
  );

  registerVaultTool<{ from_path: string; to_path: string }>(
    server,
    resolve,
    "move_note",
    {
      description:
        "Move or rename a note and rekey any live session. Wikilinks are not rewritten. Mutations are audited as mcp_client.",
      inputSchema: {
        from_path: z
          .string()
          .describe("Current vault-relative Markdown file path."),
        to_path: z
          .string()
          .describe("Destination vault-relative Markdown file path."),
      },
    },
    (service, input) =>
      service.moveNote({
        fromPath: input.from_path,
        toPath: input.to_path,
        actor: actor(),
      }),
  );

  registerVaultTool<{ path: string }>(
    server,
    resolve,
    "create_folder",
    {
      description:
        "Create a folder. Mutations are audited as mcp_client when a folder is newly created.",
      inputSchema: {
        path: z.string().describe("Vault-relative folder path."),
      },
    },
    (service, input) =>
      service.createFolder({ path: input.path, actor: actor() }),
  );

  registerVaultTool<{ path: string; recursive?: boolean; permanent?: boolean }>(
    server,
    resolve,
    "delete_folder",
    {
      description:
        "Delete a folder. Non-empty folders require recursive=true. By default deletion moves to .kb1/trash; permanent removes directly. Mutations are audited as mcp_client.",
      inputSchema: {
        path: z.string().describe("Vault-relative folder path."),
        recursive: z
          .boolean()
          .optional()
          .describe("Allow deleting a non-empty folder."),
        permanent: z
          .boolean()
          .optional()
          .describe("Permanently remove instead of moving to trash."),
      },
    },
    (service, input) =>
      service.deleteFolder({
        path: input.path,
        recursive: input.recursive,
        permanent: input.permanent,
        actor: actor(),
      }),
  );

  registerVaultTool<{ from_path: string; to_path: string }>(
    server,
    resolve,
    "move_folder",
    {
      description:
        "Move or rename a folder and rekey any live sessions below it. Wikilinks are not rewritten. Mutations are audited as mcp_client.",
      inputSchema: {
        from_path: z.string().describe("Current vault-relative folder path."),
        to_path: z.string().describe("Destination vault-relative folder path."),
      },
    },
    (service, input) =>
      service.moveFolder({
        fromPath: input.from_path,
        toPath: input.to_path,
        actor: actor(),
      }),
  );

  registerVaultTool<{
    query: string;
    under?: string;
    context?: number;
    limit?: number;
    offset?: number;
  }>(
    server,
    resolve,
    "search",
    {
      description:
        "Search vault notes with optional folder scope, context lines, and pagination. Read-only; writes no audit row.",
      inputSchema: {
        query: z.string().describe("Search query."),
        under: z.string().optional().describe("Folder path to search under."),
        context: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Context lines around each match."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum hits to return."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Pagination offset."),
      },
    },
    (service, input) => service.search(input),
  );

  return server;

  /**
   * Register a vault-data tool: its schema carries the required `vaultId`, and
   * the handler receives the resolved service. An unknown `vaultId` short-circuits
   * to a clean tool error before the service is ever touched.
   */
  function registerVaultTool<TInput extends object>(
    target: McpServer,
    resolveVault: (
      vaultId: string,
    ) => { ok: true; service: LocalMcpVaultService } | ServiceFailure,
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodType> },
    handler: (service: LocalMcpVaultService, input: TInput) => Promise<unknown>,
  ): void {
    registerTool<TInput & { vaultId: string }>(
      target,
      name,
      {
        description: config.description,
        inputSchema: { ...config.inputSchema, ...vaultIdField },
      },
      async ({ vaultId, ...rest }) => {
        const resolved = resolveVault(vaultId);
        if (!resolved.ok) {
          return resolved;
        }
        return handler(resolved.service, rest as unknown as TInput);
      },
    );
  }
}

function asProvider(source: LocalMcpVaultSource): LocalMcpVaultProvider {
  if (isProvider(source)) {
    return source;
  }
  // Bare service: a single vault addressed by the synthetic 'default' id. There
  // is no default-vault fallback — callers must pass vaultId: 'default' to reach
  // it, the same as any other vault.
  const service = source;
  return {
    resolve: (id) => (id === SINGLE_VAULT_ID ? service : undefined),
    list: () => [{ id: SINGLE_VAULT_ID, displayName: SINGLE_VAULT_ID }],
  };
}

function isProvider(
  source: LocalMcpVaultSource,
): source is LocalMcpVaultProvider {
  return (
    typeof (source as LocalMcpVaultProvider).resolve === "function" &&
    typeof (source as LocalMcpVaultProvider).list === "function"
  );
}

function registerTool<TInput extends object>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Record<string, z.ZodType> },
  handler: (input: TInput) => Promise<unknown>,
): void {
  server.registerTool(name, config, async (input) => {
    const result = await handler(input as TInput);
    if (isDirectToolResult(result)) {
      return result;
    }
    if (isServiceFailure(result)) {
      return {
        isError: true,
        content: [
          { type: "text", text: `${name} rejected: ${JSON.stringify(result)}` },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });
}

type DirectToolResult = {
  isError?: boolean;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

function isDirectToolResult(value: unknown): value is DirectToolResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "content" in value &&
      Array.isArray((value as { content?: unknown }).content),
  );
}

function isServiceFailure(value: unknown): value is ServiceFailure {
  return Boolean(
    value &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false,
  );
}

interface ListedVaultEntry {
  path: string;
  kind: "file" | "folder";
  size?: number;
  mtimeMs?: number;
  artifact?: {
    kind: "text" | "attachment";
    contentType: string;
    editable: boolean;
    preview: string;
  };
}

function attachmentRows(
  result: { entries?: unknown },
  kind: "image" | "attachment" | undefined,
): Array<{
  path: string;
  contentType: string;
  preview: string;
  size: number;
  mtimeMs: number;
}> {
  const entries = Array.isArray(result.entries) ? result.entries : [];
  return entries.flatMap((entry): Array<{
    path: string;
    contentType: string;
    preview: string;
    size: number;
    mtimeMs: number;
  }> => {
    if (!isListedVaultEntry(entry)) return [];
    if (entry.kind !== "file" || entry.artifact?.kind !== "attachment") return [];
    if (kind === "image" && entry.artifact.preview !== "image") return [];
    if (kind === "attachment" && entry.artifact.preview === "image") return [];
    return [{
      path: entry.path,
      contentType: entry.artifact.contentType,
      preview: entry.artifact.preview,
      size: entry.size ?? 0,
      mtimeMs: entry.mtimeMs ?? 0,
    }];
  });
}

function isListedVaultEntry(value: unknown): value is ListedVaultEntry {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { path?: unknown }).path === "string" &&
      ((value as { kind?: unknown }).kind === "file" ||
        (value as { kind?: unknown }).kind === "folder"),
  );
}

function base64ByteUpperBound(value: string): number {
  return Math.ceil((value.length * 3) / 4);
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  return Buffer.from(value, "base64");
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkdn",
  ".txt",
  ".log",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".yml",
  ".yaml",
  ".xml",
  ".toml",
  ".ini",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
]);

function isAttachmentPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return !TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

function jsonRpcError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}
