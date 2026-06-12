import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

import type { LocalMcpActor, LocalMcpVaultService, ServiceFailure } from './types.js';

const unknownActor: LocalMcpActor = { kind: 'mcp_client', client: 'unknown local caller' };

export interface LocalMcpEndpoint {
  handleRequest(request: Request): Promise<Response>;
  close(): Promise<void>;
}

interface SessionRecord {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export function createLocalMcpEndpoint(service: LocalMcpVaultService): LocalMcpEndpoint {
  const sessions = new Map<string, SessionRecord>();

  return {
    async handleRequest(request) {
      const sessionId = request.headers.get('mcp-session-id') ?? undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        return existing.transport.handleRequest(request);
      }

      const parsedBody = request.method === 'POST' ? await request.clone().json().catch(() => undefined) : undefined;
      if (request.method !== 'POST' || !isInitializeRequest(parsedBody)) {
        return jsonRpcError('Bad Request: No valid MCP session id provided', 400);
      }

      let assignedSessionId: string | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (nextSessionId) => {
          assignedSessionId = nextSessionId;
        }
      });
      const server = createLocalMcpServer(service);

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
    }
  };
}

export function createLocalMcpServer(service: LocalMcpVaultService): McpServer {
  const server = new McpServer({
    name: 'kb-2-local-daemon',
    version: '0.0.0'
  });

  const actor = (): LocalMcpActor => {
    const client = server.server.getClientVersion()?.name?.trim();
    return client ? { kind: 'mcp_client', client } : unknownActor;
  };

  registerTool<{}>(server, 'vault_info', {
    description: 'Return the vault root name plus file and folder counts. Read-only; writes no audit row.',
    inputSchema: {}
  }, async () => service.vaultInfo());

  registerTool<{ under?: string; depth?: number }>(server, 'list_files', {
    description: 'List files and folders under a vault folder, including inline metadata on folder entries. Depth and entry caps mirror the daemon API. Read-only; writes no audit row.',
    inputSchema: {
      under: z.string().optional().describe('Folder path to list under. Omit for the vault root.'),
      depth: z.number().int().nonnegative().optional().describe('Maximum recursive depth to return.')
    }
  }, async (input) => service.listFiles(input));

  registerTool<{ path: string }>(server, 'get_folder_metadata', {
    description: 'Read durable folder color/icon metadata from .kb2/folders.yml. Read-only; writes no audit row.',
    inputSchema: {
      path: z.string().describe('Vault-relative folder path.')
    }
  }, async (input) => service.getFolderMetadata(input));

  registerTool<{ path: string; color?: string | null; icon?: string | null }>(server, 'set_folder_metadata', {
    description: 'Merge durable folder color/icon metadata into .kb2/folders.yml. Use null to clear a key. Mutations are audited as mcp_client.',
    inputSchema: {
      path: z.string().describe('Vault-relative folder path.'),
      color: z.string().nullable().optional().describe('Accent color name to set, or null to clear.'),
      icon: z.string().nullable().optional().describe('Icon name to set, or null to clear.')
    }
  }, async (input) => service.setFolderMetadata({
    path: input.path,
    metadata: {
      ...(Object.prototype.hasOwnProperty.call(input, 'color') ? { color: input.color } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'icon') ? { icon: input.icon } : {})
    },
    actor: actor()
  }));

  registerTool<{ path: string }>(server, 'read_note', {
    description: 'Read a Markdown note and return content, stat fields, and baseline. Use baseline for edit_note retry loops. Read-only; writes no audit row.',
    inputSchema: {
      path: z.string().describe('Vault-relative Markdown file path.')
    }
  }, async (input) => service.readNote(input));

  registerTool<{ path: string; content: string; overwrite?: boolean }>(server, 'create_note', {
    description: 'Create a Markdown note without clobbering by default. Set overwrite to replace existing content. Mutations are audited as mcp_client.',
    inputSchema: {
      path: z.string().describe('Vault-relative Markdown file path to create.'),
      content: z.string().default('').describe('Full note content.'),
      overwrite: z.boolean().optional().describe('Replace an existing note when true.')
    }
  }, async (input) => service.createNote({ ...input, actor: actor() }));

  registerTool<{
    path: string;
    baseline: string;
    old_text: string;
    new_text: string;
    before?: string;
    after?: string;
    occurrence?: number;
  }>(server, 'edit_note', {
    description: 'Apply the Chunk 008 anchored splice contract verbatim. Requires a read_note baseline plus old_text/new_text and optional before/after/occurrence anchors. Rejected results are returned intact: stale_doc includes current_content and fresh baseline; ambiguous includes match_count; size rejects include limits; persist_failed means the edit was not durably saved and has no success audit row.',
    inputSchema: {
      path: z.string().describe('Vault-relative Markdown file path to edit.'),
      baseline: z.string().describe('Baseline returned by read_note.'),
      old_text: z.string().describe('Text to replace, LF-normalized.'),
      new_text: z.string().describe('Replacement text, LF-normalized.'),
      before: z.string().optional().describe('Optional text immediately before old_text for disambiguation.'),
      after: z.string().optional().describe('Optional text immediately after old_text for disambiguation.'),
      occurrence: z.number().int().positive().optional().describe('1-based match occurrence to edit when anchors still match multiple ranges.')
    }
  }, async (input) => service.editNote({
    path: input.path,
    baseline: input.baseline,
    oldText: input.old_text,
    newText: input.new_text,
    before: input.before,
    after: input.after,
    occurrence: input.occurrence,
    actor: actor()
  }));

  registerTool<{ path: string; content: string }>(server, 'append_note', {
    description: 'Append content to a note, creating it when missing. Mutations flow through live sessions and are audited as mcp_client.',
    inputSchema: {
      path: z.string().describe('Vault-relative Markdown file path.'),
      content: z.string().describe('Content to append.')
    }
  }, async (input) => service.appendNote({ ...input, actor: actor() }));

  registerTool<{ path: string; content: string }>(server, 'prepend_note', {
    description: 'Prepend content to an existing note after frontmatter when present. Mutations flow through live sessions and are audited as mcp_client.',
    inputSchema: {
      path: z.string().describe('Vault-relative Markdown file path.'),
      content: z.string().describe('Content to prepend.')
    }
  }, async (input) => service.prependNote({ ...input, actor: actor() }));

  registerTool<{ path: string; permanent?: boolean }>(server, 'delete_note', {
    description: 'Delete a note. By default it is moved into .kb2/trash; set permanent for an irreversible delete. Mutations are audited as mcp_client.',
    inputSchema: {
      path: z.string().describe('Vault-relative Markdown file path.'),
      permanent: z.boolean().optional().describe('Permanently remove instead of moving to trash.')
    }
  }, async (input) => service.deleteNote({ ...input, actor: actor() }));

  registerTool<{ from_path: string; to_path: string }>(server, 'move_note', {
    description: 'Move or rename a note and rekey any live session. Wikilinks are not rewritten. Mutations are audited as mcp_client.',
    inputSchema: {
      from_path: z.string().describe('Current vault-relative Markdown file path.'),
      to_path: z.string().describe('Destination vault-relative Markdown file path.')
    }
  }, async (input) => service.moveNote({ fromPath: input.from_path, toPath: input.to_path, actor: actor() }));

  registerTool<{ path: string }>(server, 'create_folder', {
    description: 'Create a folder. Mutations are audited as mcp_client when a folder is newly created.',
    inputSchema: {
      path: z.string().describe('Vault-relative folder path.')
    }
  }, async (input) => service.createFolder({ ...input, actor: actor() }));

  registerTool<{ path: string; recursive?: boolean; permanent?: boolean }>(server, 'delete_folder', {
    description: 'Delete a folder. Non-empty folders require recursive=true. By default deletion moves to .kb2/trash; permanent removes directly. Mutations are audited as mcp_client.',
    inputSchema: {
      path: z.string().describe('Vault-relative folder path.'),
      recursive: z.boolean().optional().describe('Allow deleting a non-empty folder.'),
      permanent: z.boolean().optional().describe('Permanently remove instead of moving to trash.')
    }
  }, async (input) => service.deleteFolder({ ...input, actor: actor() }));

  registerTool<{ from_path: string; to_path: string }>(server, 'move_folder', {
    description: 'Move or rename a folder and rekey any live sessions below it. Wikilinks are not rewritten. Mutations are audited as mcp_client.',
    inputSchema: {
      from_path: z.string().describe('Current vault-relative folder path.'),
      to_path: z.string().describe('Destination vault-relative folder path.')
    }
  }, async (input) => service.moveFolder({ fromPath: input.from_path, toPath: input.to_path, actor: actor() }));

  registerTool<{ query: string; under?: string; context?: number; limit?: number; offset?: number }>(server, 'search', {
    description: 'Search vault notes with optional folder scope, context lines, and pagination. Read-only; writes no audit row.',
    inputSchema: {
      query: z.string().describe('Search query.'),
      under: z.string().optional().describe('Folder path to search under.'),
      context: z.number().int().nonnegative().optional().describe('Context lines around each match.'),
      limit: z.number().int().positive().optional().describe('Maximum hits to return.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.')
    }
  }, async (input) => service.search(input));

  return server;
}

function registerTool<TInput extends object>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Record<string, z.ZodType> },
  handler: (input: TInput) => Promise<unknown>
): void {
  server.registerTool(name, config, async (input) => {
    const result = await handler(input as TInput);
    if (isServiceFailure(result)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} rejected: ${JSON.stringify(result)}` }]
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  });
}

function isServiceFailure(value: unknown): value is ServiceFailure {
  return Boolean(value && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok === false);
}

function jsonRpcError(message: string, status: number): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message
    },
    id: null
  }), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}
