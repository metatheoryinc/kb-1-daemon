import { Hono, type Context } from 'hono';
import {
  createLocalMcpEndpoint,
  type LocalMcpEndpoint,
  type LocalMcpVaultProvider
} from '@kb-2/local-mcp';
import {
  type ServiceErrorCode,
  type ServiceResult,
  type VaultActor,
  type VaultChangeEvent,
  type VaultService
} from '@kb-2/vault-service';
import { resolve } from 'node:path';

import { SERVICE_NAME, type ActorDefault } from './config.js';
import {
  filePathParam,
  queryNumber,
  readJsonObject,
  readRequiredString,
  readSpliceRequest,
  requestTextContent
} from './request-helpers.js';
import { readDaemonStatus } from './status.js';
import { missingUiBuildResponse, proxyUi, serveUi } from './ui-static.js';
import type {
  VaultRegistry,
  VaultRegistryErrorCode
} from './vault-registry.js';

const ACTOR_HEADER = 'x-kb2-actor';
const MAX_ACTOR_HEADER_BYTES = 1024;

export interface CreateAppOptions {
  statusFile: string;
  /** Live multi-vault registry powering vault CRUD and the `:id`-scoped data routes. */
  registry?: VaultRegistry;
  mcpEndpoint?: LocalMcpEndpoint;
  webBuildDir?: string;
  webProxyTarget?: string;
  actorDefault?: ActorDefault;
}

/**
 * How a data route resolves the vault it operates on and the path prefixes used
 * to slice the vault-relative file/folder path out of the request URL. Every
 * vault-scoped route shares the exact same handlers; only this resolver differs.
 */
interface VaultRouteScope {
  /** Resolve the addressed vault service, or a clean failure for an unknown id. */
  resolve(context: Context): ServiceResult<{ service: VaultService }>;
  /** Prefix to strip when extracting a `/files/...` path from this scope. */
  filesPrefix(context: Context): string;
  /** Prefix to strip when extracting a `/folders/...` path from this scope. */
  foldersPrefix(context: Context): string;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const api = new Hono();

  api.get('/health', async (context) => {
    const status = await readDaemonStatus(options.statusFile);

    return context.json({
      ok: true,
      service: SERVICE_NAME,
      status
    });
  });

  if (options.registry) {
    const registry = options.registry;
    const actorDefault = options.actorDefault ?? 'user';

    // One MCP endpoint addresses every vault. vaultId resolution and vault
    // enumeration go through the registry — the same source of truth as the HTTP
    // layer. Every data tool requires a vaultId; there is no default vault.
    const mcpEndpoint = options.mcpEndpoint ?? createLocalMcpEndpoint(mcpVaultProvider(registry));
    app.all('/mcp', async (context) => {
      return mcpEndpoint.handleRequest(context.req.raw);
    });

    // Vault management: list, create (live, no restart), rename (displayName
    // only), and soft-delete (folder to trash, removed from the live registry).
    // Zero vaults is a valid state: `list` simply returns an empty array.
    api.get('/vaults', (context) => {
      return context.json({ ok: true, vaults: registry.list() });
    });

    api.post('/vaults', async (context) => {
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const displayName = readRequiredString(body.body, 'displayName');
      if (!displayName.ok) return mapServiceResult(context, displayName);
      const slug = readRequiredString(body.body, 'slug');
      if (!slug.ok) return mapServiceResult(context, slug);
      const created = await registry.create({ displayName: displayName.value, slug: slug.value });
      return mapRegistryResult(context, created, created.ok ? { vault: created.vault } : undefined, 201);
    });

    api.put('/vaults/:id', async (context) => {
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const displayName = readRequiredString(body.body, 'displayName');
      if (!displayName.ok) return mapServiceResult(context, displayName);
      const renamed = await registry.rename(vaultIdParam(context), { displayName: displayName.value });
      return mapRegistryResult(context, renamed, renamed.ok ? { vault: renamed.vault } : undefined);
    });

    api.delete('/vaults/:id', async (context) => {
      const deleted = await registry.softDelete(vaultIdParam(context));
      return mapRegistryResult(context, deleted, deleted.ok ? {} : undefined);
    });

    // `:id`-scoped data routes — the only way to reach vault content. `:id`
    // resolves to that vault's instance from the registry; an unknown id is a
    // clean 404 (never a crash), which keeps zero-vaults a valid runtime state.
    const scopedScope: VaultRouteScope = {
      resolve: (context) => {
        const id = vaultIdParam(context);
        const instance = registry.get(id);
        if (!instance) {
          return { ok: false, error: 'not_found', message: `No vault with id "${id}".` };
        }
        return { ok: true, service: instance.service };
      },
      filesPrefix: (context) => `/api/vaults/${vaultIdParam(context)}/files/`,
      foldersPrefix: (context) => `/api/vaults/${vaultIdParam(context)}/folders/`
    };
    registerVaultDataRoutes(api, scopedScope, actorDefault, '/vaults/:id');
  }

  app.route('/api', api);

  const webBuildDir = options.webBuildDir;
  const webProxyTarget = options.webProxyTarget;

  if (webProxyTarget || webBuildDir) {
    app.notFound(async (context) => {
      const { pathname } = new URL(context.req.url);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      if (webProxyTarget) {
        return proxyUi(webProxyTarget, context.req.raw);
      }

      if (!webBuildDir) {
        return missingUiBuildResponse(resolve('apps/web/build'));
      }

      return serveUi(webBuildDir, pathname);
    });
  }

  return app;
}

/**
 * Register the per-vault data routes (vault info, tree, search, files, folders)
 * on `router` under `basePath`. The `scope` resolves which vault service each
 * request hits and which URL prefixes to strip when extracting vault-relative
 * paths, keeping the file/folder/tree/search logic in exactly one place.
 */
function registerVaultDataRoutes(
  router: Hono,
  scope: VaultRouteScope,
  actorDefault: ActorDefault,
  basePath = ''
): void {
  router.post(`${basePath}/ops/flush`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    return mapServiceResult(context, await resolved.service.flushDirtySessions());
  });

  router.get(`${basePath}/events`, (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    return eventStreamResponse(resolved.service);
  });

  router.get(`${basePath}/vault`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    return mapServiceResult(context, await resolved.service.vaultInfo());
  });

  router.get(`${basePath}/tree`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const depthRaw = context.req.query('depth');
    const depth = depthRaw === undefined ? undefined : Number(depthRaw);
    return mapServiceResult(context, await resolved.service.listFiles({
      under: context.req.query('under'),
      ...(depth !== undefined && Number.isInteger(depth) ? { depth } : {})
    }));
  });

  router.get(`${basePath}/search`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    return mapServiceResult(context, await resolved.service.search({
      query: context.req.query('q') ?? '',
      under: context.req.query('under'),
      context: queryNumber(context, 'context'),
      limit: queryNumber(context, 'limit'),
      offset: queryNumber(context, 'offset')
    }));
  });

  router.get(`${basePath}/files/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const filePath = filePathParam(context.req.path, scope.filesPrefix(context));
    return mapServiceResult(context, await resolved.service.readNote({ path: filePath }));
  });

  router.put(`${basePath}/files/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const filePath = filePathParam(context.req.path, scope.filesPrefix(context));
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const content = await requestTextContent(context.req.raw);
    if (!content.ok) return mapServiceResult(context, content);
    const overwrite = context.req.query('overwrite') === 'true';
    return mapServiceResult(context, await resolved.service.createNote({
      path: filePath,
      content: content.content,
      overwrite,
      actor: actor.actor
    }), overwrite ? 200 : 201);
  });

  router.delete(`${basePath}/files/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const filePath = filePathParam(context.req.path, scope.filesPrefix(context));
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const permanent = context.req.query('permanent') === 'true';
    return mapServiceResult(context, await resolved.service.deleteNote({
      path: filePath,
      permanent,
      actor: actor.actor
    }));
  });

  router.post(`${basePath}/files/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const service = resolved.service;
    const filesPrefix = scope.filesPrefix(context);

    if (context.req.path.endsWith('/splice')) {
      const actor = actorFromRequest(context, actorDefault);
      if (!actor.ok) return mapServiceResult(context, actor);
      const filePath = filePathParam(context.req.path, filesPrefix, '/splice');
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const splice = readSpliceRequest(body);
      if (!splice.ok) return mapServiceResult(context, splice);
      return mapServiceResult(context, await service.editNote({
        path: filePath,
        baseline: splice.baseline,
        oldText: splice.request.oldText,
        newText: splice.request.newText,
        before: splice.request.before,
        after: splice.request.after,
        occurrence: splice.request.occurrence,
        actor: actor.actor
      }));
    }

    if (context.req.path.endsWith('/append')) {
      const actor = actorFromRequest(context, actorDefault);
      if (!actor.ok) return mapServiceResult(context, actor);
      const filePath = filePathParam(context.req.path, filesPrefix, '/append');
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const content = readRequiredString(body.body, 'content');
      if (!content.ok) return mapServiceResult(context, content);
      return mapServiceResult(context, await service.appendNote({
        path: filePath,
        content: content.value,
        actor: actor.actor
      }));
    }

    if (context.req.path.endsWith('/prepend')) {
      const actor = actorFromRequest(context, actorDefault);
      if (!actor.ok) return mapServiceResult(context, actor);
      const filePath = filePathParam(context.req.path, filesPrefix, '/prepend');
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const content = readRequiredString(body.body, 'content');
      if (!content.ok) return mapServiceResult(context, content);
      return mapServiceResult(context, await service.prependNote({
        path: filePath,
        content: content.value,
        actor: actor.actor
      }));
    }

    if (!context.req.path.endsWith('/move')) {
      return context.json({ ok: false, error: 'Not found' }, 404);
    }

    const fromPath = filePathParam(context.req.path, filesPrefix, '/move');
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const body = await readJsonObject(context.req.raw);
    if (!body.ok) return mapServiceResult(context, body);
    const to = readRequiredString(body.body, 'to');
    if (!to.ok) return mapServiceResult(context, to);
    // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
    return mapServiceResult(context, await service.moveNote({
      fromPath,
      toPath: to.value,
      actor: actor.actor
    }));
  });

  router.post(`${basePath}/folders`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const body = await readJsonObject(context.req.raw);
    if (!body.ok) return mapServiceResult(context, body);
    const folderPath = typeof body.body.path === 'string' ? body.body.path : '';
    return mapServiceResult(context, await resolved.service.createFolder({
      path: folderPath,
      actor: actor.actor
    }), 201);
  });

  router.get(`${basePath}/folders/*`, async (context) => {
    if (!context.req.path.endsWith('/metadata')) {
      return context.json({ ok: false, error: 'Not found' }, 404);
    }
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const folderPath = filePathParam(context.req.path, scope.foldersPrefix(context), '/metadata');
    return mapServiceResult(context, await resolved.service.getFolderMetadata({ path: folderPath }));
  });

  router.put(`${basePath}/folders/*`, async (context) => {
    if (!context.req.path.endsWith('/metadata')) {
      return context.json({ ok: false, error: 'Not found' }, 404);
    }
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const folderPath = filePathParam(context.req.path, scope.foldersPrefix(context), '/metadata');
    const body = await readJsonObject(context.req.raw);
    if (!body.ok) return mapServiceResult(context, body);
    const metadata = readFolderMetadataBody(body.body);
    if (!metadata.ok) return mapServiceResult(context, metadata);
    return mapServiceResult(context, await resolved.service.setFolderMetadata({
      path: folderPath,
      metadata: metadata.metadata,
      actor: actor.actor
    }));
  });

  router.delete(`${basePath}/folders/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const folderPath = filePathParam(context.req.path, scope.foldersPrefix(context));
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const recursive = context.req.query('recursive') === 'true';
    const permanent = context.req.query('permanent') === 'true';
    return mapServiceResult(context, await resolved.service.deleteFolder({
      path: folderPath,
      recursive,
      permanent,
      actor: actor.actor
    }));
  });

  router.post(`${basePath}/folders/*`, async (context) => {
    if (!context.req.path.endsWith('/move')) {
      return context.json({ ok: false, error: 'Not found' }, 404);
    }
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const actor = actorFromRequest(context, actorDefault);
    if (!actor.ok) return mapServiceResult(context, actor);
    const fromPath = filePathParam(context.req.path, scope.foldersPrefix(context), '/move');
    const body = await readJsonObject(context.req.raw);
    if (!body.ok) return mapServiceResult(context, body);
    const to = readRequiredString(body.body, 'to');
    if (!to.ok) return mapServiceResult(context, to);
    // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
    return mapServiceResult(context, await resolved.service.moveFolder({
      fromPath,
      toPath: to.value,
      actor: actor.actor
    }));
  });
}

function eventStreamResponse(vaultService: VaultService): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = vaultService.onEvent((event) => {
        controller.enqueue(encoder.encode(formatServerSentEvent(event)));
      });
    },
    cancel() {
      unsubscribe();
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  });
}

function formatServerSentEvent(event: VaultChangeEvent): string {
  return `event: change\ndata: ${JSON.stringify(event)}\n\n`;
}

function mapServiceResult(
  context: Context,
  result: ServiceResult,
  okStatus: 200 | 201 = 200
): Response {
  if (result.ok) {
    return context.json(result, okStatus);
  }

  return context.json(result, statusForServiceError(result.error));
}

/**
 * Adapt the live registry to the MCP layer's vault provider. vaultId resolution
 * and vault enumeration both read from the same registry the HTTP routes use, so
 * the MCP endpoint never holds a second vault map. There is no default vault:
 * every data tool must address a vault by id.
 */
export function mcpVaultProvider(registry: VaultRegistry): LocalMcpVaultProvider {
  return {
    resolve: (id) => registry.get(id)?.service,
    list: () => registry.list()
  };
}

/**
 * Map a vault-management result onto an HTTP response. A slug collision is a
 * clean 409, an unknown vault a 404, and a bad request a 400 — never a crash.
 */
function mapRegistryResult(
  context: Context,
  result: { ok: true } | { ok: false; error: VaultRegistryErrorCode; message: string },
  okBody: Record<string, unknown> | undefined,
  okStatus: 200 | 201 = 200
): Response {
  if (result.ok) {
    return context.json({ ok: true, ...(okBody ?? {}) }, okStatus);
  }

  return context.json(result, statusForRegistryError(result.error));
}

/** The `:id` path param, normalized to a string (an absent id can match no vault). */
function vaultIdParam(context: Context): string {
  return context.req.param('id') ?? '';
}

function statusForRegistryError(error: VaultRegistryErrorCode): 400 | 404 | 409 {
  switch (error) {
    case 'invalid_request':
      return 400;
    case 'not_found':
      return 404;
    case 'already_exists':
      return 409;
  }
}

function statusForServiceError(error: ServiceErrorCode): 400 | 404 | 409 | 413 | 500 {
  switch (error) {
    case 'invalid_actor':
    case 'invalid_path':
    case 'invalid_metadata':
    case 'invalid_request':
      return 400;
    case 'metadata_parse_failed':
      return 500;
    case 'not_found':
      return 404;
    case 'already_exists':
    case 'path_collision':
    case 'folder_not_empty':
      return 409;
    case 'entry_cap_exceeded':
    case 'too_large_splice':
    case 'too_large_document':
      return 413;
    case 'persist_failed':
      return 500;
    case 'stale_doc':
    case 'ambiguous':
      return 409;
  }
}

function actorFromRequest(context: Context, actorDefault: ActorDefault): ServiceResult<{ actor: VaultActor }> {
  const rawActor = context.req.header(ACTOR_HEADER);

  if (rawActor === undefined) {
    return { ok: true, actor: { kind: actorDefault } };
  }

  if (new TextEncoder().encode(rawActor).byteLength > MAX_ACTOR_HEADER_BYTES) {
    return invalidActor(`${ACTOR_HEADER} must be 1 KiB or smaller`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawActor);
  } catch {
    return invalidActor(`${ACTOR_HEADER} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidActor(`${ACTOR_HEADER} must be a JSON object`);
  }

  const actor = parsed as Record<string, unknown>;
  if (actor.kind !== 'user' && actor.kind !== 'integration') {
    return invalidActor(`${ACTOR_HEADER}.kind must be "user" or "integration"`);
  }

  const id = readOptionalActorString(actor, 'id');
  if (!id.ok) return id;
  const name = readOptionalActorString(actor, 'name');
  if (!name.ok) return name;
  const client = readOptionalActorString(actor, 'client');
  if (!client.ok) return client;

  return {
    ok: true,
    actor: {
      kind: actor.kind,
      ...(id.value !== undefined ? { id: id.value } : {}),
      ...(name.value !== undefined ? { name: name.value } : {}),
      ...(client.value !== undefined ? { client: client.value } : {})
    }
  };
}

function readOptionalActorString(
  actor: Record<string, unknown>,
  key: 'id' | 'name' | 'client'
): ServiceResult<{ value?: string }> {
  if (!Object.prototype.hasOwnProperty.call(actor, key)) {
    return { ok: true };
  }

  if (typeof actor[key] !== 'string') {
    return invalidActor(`${ACTOR_HEADER}.${key} must be a string when provided`);
  }

  return { ok: true, value: actor[key] };
}

function invalidActor(message: string): ServiceResult<never> {
  return { ok: false, error: 'invalid_actor', message };
}

function readFolderMetadataBody(body: Record<string, unknown>): ServiceResult<{ metadata: { color?: string | null; icon?: string | null } }> {
  const metadata: { color?: string | null; icon?: string | null } = {};

  if (Object.prototype.hasOwnProperty.call(body, 'color')) {
    if (body.color !== null && typeof body.color !== 'string') {
      return { ok: false, error: 'invalid_request', message: 'color must be a string or null when provided' };
    }
    metadata.color = body.color;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'icon')) {
    if (body.icon !== null && typeof body.icon !== 'string') {
      return { ok: false, error: 'invalid_request', message: 'icon must be a string or null when provided' };
    }
    metadata.icon = body.icon;
  }

  return { ok: true, metadata };
}
