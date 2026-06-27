import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createLocalMcpEndpoint } from './server.js';
import type { LocalMcpVaultService, ServiceResult, VaultActor } from './types.js';

describe('local MCP server', () => {
  it('rejects requests that do not carry or initialize a valid MCP session', async () => {
    const endpoint = createLocalMcpEndpoint(emptyService());

    const getResponse = await endpoint.handleRequest(new Request('http://127.0.0.1/mcp'));
    expect(getResponse.status).toBe(400);
    await expect(getResponse.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid MCP session id provided'
      },
      id: null
    });

    const postResponse = await endpoint.handleRequest(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    }));
    expect(postResponse.status).toBe(400);

    await endpoint.close();
  });

  it('registers every tier-1 tool and forwards calls to the injected service with initialize attribution', async () => {
    const mutationActors: VaultActor[] = [];
    const service: LocalMcpVaultService = {
      vaultInfo: async () => ({ ok: true, rootName: 'demo-vault', fileCount: 1, folderCount: 1 }),
      listFiles: async (input) => ({ ok: true, entries: [{ path: input.under ?? 'note.md', kind: input.under ? 'folder' : 'file', size: 4, mtimeMs: 1, metadata: input.under ? { color: 'coral' } : undefined }] }),
      listFolderMetadata: async () => ({ ok: true, folders: { notes: { color: 'coral' } } }),
      getFolderMetadata: async (input) => ({ ok: true, path: input.path, metadata: { color: 'coral' } }),
      setFolderMetadata: async (input) => recordActor(mutationActors, input.actor, {
        ok: true,
        path: input.path,
        metadata: {
          ...(input.metadata.color ? { color: input.metadata.color } : {}),
          ...(input.metadata.icon ? { icon: input.metadata.icon } : {})
        },
        audit: audit(input.actor, 'write')
      }),
      readNote: async () => ({ ok: true, path: 'note.md', content: 'alpha beta', baseline: 'b1', size: 10, mtimeMs: 1 }),
      createNote: async (input) => recordActor(mutationActors, input.actor, { ok: true, path: input.path, audit: audit(input.actor, 'create') }),
      editNote: async (input) => recordActor(mutationActors, input.actor, input.baseline === 'stale'
        ? {
            ok: false,
            error: 'stale_doc',
            message: 'document changed since the provided baseline',
            current_content: 'alpha beta',
            baseline: 'fresh'
          }
        : { ok: true, path: input.path, content: input.newText, baseline: 'b2', audit: audit(input.actor, 'splice') }),
      appendNote: async (input) => recordActor(mutationActors, input.actor, { ok: true, path: input.path, content: input.content, baseline: 'b3', audit: audit(input.actor, 'append') }),
      prependNote: async (input) => recordActor(mutationActors, input.actor, { ok: true, path: input.path, content: input.content, baseline: 'b4', audit: audit(input.actor, 'prepend') }),
      deleteNote: async (input) => recordActor(mutationActors, input.actor, { ok: true, path: input.path, permanent: input.permanent, audit: audit(input.actor, 'delete') }),
      moveNote: async (input) => recordActor(mutationActors, input.actor, { ok: true, fromPath: input.fromPath, toPath: input.toPath, kind: 'file', audit: audit(input.actor, 'move') }),
      createFolder: async (input) => recordActor(mutationActors, input.actor, { ok: true, path: input.path, audit: audit(input.actor, 'mkdir') }),
      deleteFolder: async (input) => recordActor(mutationActors, input.actor, { ok: true, path: input.path, permanent: input.permanent, liveDeleted: [], audit: audit(input.actor, 'delete') }),
      moveFolder: async (input) => recordActor(mutationActors, input.actor, { ok: true, fromPath: input.fromPath, toPath: input.toPath, liveMoved: [], audit: audit(input.actor, 'move') }),
      search: async () => ({ ok: true, total: 1, results: [{ path: 'note.md', line: 1, lineText: 'alpha beta', context: { before: [], after: [] } }], truncated: false })
    };
    const endpoint = createLocalMcpEndpoint(service);
    const client = new Client({ name: 'sdk-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
      fetch: async (input, init) => endpoint.handleRequest(input instanceof Request ? input : new Request(input, init))
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'append_note',
      'create_folder',
      'create_note',
      'delete_folder',
      'delete_note',
      'edit_note',
      'get_folder_metadata',
      'list_files',
      'list_vaults',
      'move_folder',
      'move_note',
      'prepend_note',
      'read_note',
      'search',
      'set_folder_metadata',
      'vault_info'
    ]);

    // Every vault-data tool advertises the required vaultId; list_vaults does not.
    const vaultInfoTool = tools.tools.find((tool) => tool.name === 'vault_info');
    expect(vaultInfoTool?.inputSchema.properties).toHaveProperty('vaultId');
    expect(vaultInfoTool?.inputSchema.required ?? []).toContain('vaultId');
    const listVaultsTool = tools.tools.find((tool) => tool.name === 'list_vaults');
    expect(listVaultsTool?.inputSchema.properties ?? {}).not.toHaveProperty('vaultId');

    // A bare service normalizes to a single vault addressed by the synthetic
    // 'default' id; every data tool must pass it (there is no default fallback).
    const V = 'default';
    expect(await toolJson(client, 'vault_info', { vaultId: V })).toMatchObject({ ok: true, rootName: 'demo-vault' });
    expect(await toolJson(client, 'list_files', { vaultId: V, under: 'notes', depth: 1 })).toMatchObject({ ok: true, entries: [{ path: 'notes', metadata: { color: 'coral' } }] });
    expect(await toolJson(client, 'get_folder_metadata', { vaultId: V, path: 'notes' })).toMatchObject({ ok: true, path: 'notes', metadata: { color: 'coral' } });
    expect(await toolJson(client, 'set_folder_metadata', { vaultId: V, path: 'notes', color: 'mint', icon: null })).toMatchObject({ ok: true, path: 'notes', metadata: { color: 'mint' } });
    expect(await toolJson(client, 'read_note', { vaultId: V, path: 'note.md' })).toMatchObject({ ok: true, baseline: 'b1' });
    expect(await toolJson(client, 'create_note', { vaultId: V, path: 'created.md', content: 'created' })).toMatchObject({ ok: true, path: 'created.md' });
    expect(await toolJson(client, 'edit_note', { vaultId: V, path: 'note.md', baseline: 'b1', old_text: 'alpha', new_text: 'ALPHA' })).toMatchObject({ ok: true, content: 'ALPHA' });
    expect(await toolJson(client, 'append_note', { vaultId: V, path: 'note.md', content: '\nnext' })).toMatchObject({ ok: true, baseline: 'b3' });
    expect(await toolJson(client, 'prepend_note', { vaultId: V, path: 'note.md', content: 'first\n' })).toMatchObject({ ok: true, baseline: 'b4' });
    expect(await toolJson(client, 'delete_note', { vaultId: V, path: 'note.md' })).toMatchObject({ ok: true, path: 'note.md' });
    expect(await toolJson(client, 'move_note', { vaultId: V, from_path: 'note.md', to_path: 'moved.md' })).toMatchObject({ ok: true, toPath: 'moved.md' });
    expect(await toolJson(client, 'create_folder', { vaultId: V, path: 'folder' })).toMatchObject({ ok: true, path: 'folder' });
    expect(await toolJson(client, 'delete_folder', { vaultId: V, path: 'folder', recursive: true })).toMatchObject({ ok: true, path: 'folder' });
    expect(await toolJson(client, 'move_folder', { vaultId: V, from_path: 'old', to_path: 'new' })).toMatchObject({ ok: true, toPath: 'new' });
    expect(await toolJson(client, 'search', { vaultId: V, query: 'alpha' })).toMatchObject({ ok: true, total: 1 });

    // list_vaults is the discovery entry point and takes no vaultId.
    expect(await toolJson(client, 'list_vaults', {})).toMatchObject({
      ok: true,
      vaults: [{ id: 'default', displayName: 'default' }]
    });

    // An unknown vaultId is a clean tool error rather than a crash.
    const unknownVault = await client.callTool({ name: 'vault_info', arguments: { vaultId: 'missing' } });
    expect(unknownVault.isError).toBe(true);
    expect(textContent(unknownVault)).toBe('vault_info rejected: {"ok":false,"error":"not_found","message":"No vault with id \\"missing\\"."}');

    // A data-tool call WITHOUT vaultId is rejected (the param is required).
    const missingVaultId = await client.callTool({ name: 'vault_info', arguments: {} });
    expect(missingVaultId.isError).toBe(true);

    const stale = await client.callTool({
      name: 'edit_note',
      arguments: { vaultId: V, path: 'note.md', baseline: 'stale', old_text: 'alpha', new_text: 'ALPHA' }
    });
    expect(stale.isError).toBe(true);
    expect(textContent(stale)).toBe('edit_note rejected: {"ok":false,"error":"stale_doc","message":"document changed since the provided baseline","current_content":"alpha beta","baseline":"fresh"}');

    expect(mutationActors).toHaveLength(11);
    expect(mutationActors.every((actor) =>
      actor.kind === 'mcp_client' &&
      actor.id === 'local agent' &&
      actor.name === 'local agent' &&
      actor.client === 'sdk-test-client'
    )).toBe(true);

    await transport.terminateSession();
    await endpoint.close();
  });

  it('uses the endpoint-provided actor for an initialized MCP session', async () => {
    const mutationActors: VaultActor[] = [];
    const service = {
      ...emptyService(),
      createNote: async (input: { path: string; content: string; overwrite?: boolean; actor: VaultActor }) =>
        recordActor(mutationActors, input.actor, {
          ok: true,
          path: input.path,
          audit: audit(input.actor, 'create')
        })
    } satisfies LocalMcpVaultService;
    const actor: VaultActor = {
      kind: 'integration',
      id: 'integration-1',
      name: 'Integration One',
      client: 'sdk-test-client'
    };
    const endpoint = createLocalMcpEndpoint(service, {
      actorFromRequest: () => actor
    });
    const client = new Client({ name: 'sdk-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
      fetch: async (input, init) => endpoint.handleRequest(input instanceof Request ? input : new Request(input, init))
    });

    await client.connect(transport);
    expect(await toolJson(client, 'create_note', {
      vaultId: 'default',
      path: 'created.md',
      content: 'created'
    })).toMatchObject({ ok: true, path: 'created.md' });

    expect(mutationActors).toEqual([actor]);

    await transport.terminateSession();
    await endpoint.close();
  });
});

async function toolJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(textContent(await client.callTool({ name, arguments: args }))) as Record<string, unknown>;
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(result.content)) {
    throw new Error('Expected MCP content array');
  }
  const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected text MCP content');
  }
  return first.text;
}

function recordActor<T extends ServiceResult>(actors: VaultActor[], actor: VaultActor, result: T): T {
  actors.push(actor);
  return result;
}

function audit(actor: VaultActor, operation: string) {
  return {
    id: `${operation}-1`,
    ts: '2026-06-11T00:00:00.000Z',
    actor,
    operation,
    entityKind: 'file' as const,
    path: 'note.md',
    summary: operation
  };
}

function emptyService(): LocalMcpVaultService {
  const ok = async (): Promise<ServiceResult> => ({ ok: true });
  return {
    vaultInfo: ok,
    listFiles: ok,
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
    search: ok
  };
}
