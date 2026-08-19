import { Hono, type Context } from 'hono';
import {
  createLocalMcpEndpoint,
  type LocalMcpEndpoint,
  type LocalMcpVaultProvider
} from '@kb-1/local-mcp';
import {
  type ServiceErrorCode,
  type ServiceResult,
  type VaultActor,
  type VaultChangeEvent,
  type VaultService
} from '@kb-1/vault-service';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

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

export const ACTOR_HEADER = 'x-kb1-actor';
const MAX_ACTOR_HEADER_BYTES = 1024;

interface CreateAppOptions {
  statusFile: string;
  /** Live multi-vault registry powering vault CRUD and the `:id`-scoped data routes. */
  registry?: VaultRegistry;
  mcpEndpoint?: LocalMcpEndpoint;
  webBuildDir?: string;
  webProxyTarget?: string;
  actorDefault?: ActorDefault;
  relay?: RelayLifecycleController;
  shutdown?: ShutdownController;
  shutdownSignal?: AbortSignal;
}

export interface RelayLifecycleStatus {
  configured: boolean;
  started: boolean;
  controlConnected: boolean;
  reconnectScheduled: boolean;
}

export interface RelayLifecycleController {
  status(): RelayLifecycleStatus;
  connect(): RelayLifecycleStatus;
  disconnect(): RelayLifecycleStatus;
}

export interface ShutdownController {
  token: string;
  requested(): boolean;
  request(): void;
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
  /** Prefix to strip when extracting a `/raw/...` path from this scope. */
  rawPrefix(context: Context): string;
  /** Prefix to strip when extracting a `/folders/...` path from this scope. */
  foldersPrefix(context: Context): string;
}

interface MutationRequestSetup {
  service: VaultService;
  actor: VaultActor;
}

interface MutationPathRequestSetup extends MutationRequestSetup {
  path: string;
}

interface JsonMutationRequestSetup extends MutationRequestSetup {
  body: Record<string, unknown>;
}

interface JsonMutationPathRequestSetup extends MutationPathRequestSetup {
  body: Record<string, unknown>;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const api = new Hono();

  api.use('*', async (context, next) => {
    if (options.shutdown?.requested()) {
      return context.json({
        ok: false,
        error: 'shutting_down',
        message: 'The daemon is shutting down and is not accepting new work.'
      }, 503);
    }
    await next();
  });

  api.get('/health', async (context) => {
    const status = await readDaemonStatus(options.statusFile);

    return context.json({
      ok: true,
      service: SERVICE_NAME,
      status
    });
  });

  api.post('/control/shutdown', (context) => {
    const token = context.req.header('x-kb1-control-token');
    if (!options.shutdown || !token || !tokensMatch(token, options.shutdown.token)) {
      return context.json({
        ok: false,
        error: 'unauthorized',
        message: 'A valid daemon control token is required.'
      }, 401);
    }

    options.shutdown.request();
    return context.json({ ok: true, shuttingDown: true }, 202);
  });

  api.get('/relay/status', (context) => {
    return context.json({ ok: true, relay: relayStatus(options.relay) });
  });

  api.post('/relay/connect', (context) => {
    if (!options.relay) {
      return context.json({
        ok: false,
        error: 'relay_not_configured',
        message: 'Relay is not configured. Set KB1_RELAY_URL and KB1_RELAY_TOKEN before connecting.'
      }, 409);
    }

    return context.json({ ok: true, relay: options.relay.connect() });
  });

  api.post('/relay/disconnect', (context) => {
    return context.json({ ok: true, relay: options.relay?.disconnect() ?? relayStatus(undefined) });
  });

  if (options.registry) {
    const registry = options.registry;
    const actorDefault = options.actorDefault ?? 'user';

    // One MCP endpoint addresses every vault. vaultId resolution and vault
    // enumeration go through the registry — the same source of truth as the HTTP
    // layer. Every data tool requires a vaultId; there is no default vault.
    const mcpEndpoint = options.mcpEndpoint ?? createLocalMcpEndpoint(mcpVaultProvider(registry), {
      actorFromRequest: (request) => {
        const parsed = actorFromHeaders(
          request.headers.get(ACTOR_HEADER) ?? undefined
        );
        return parsed.ok ? parsed.actor : parsed;
      }
    });
    app.all('/mcp', async (context) => {
      if (options.shutdown?.requested()) {
        return context.json({
          ok: false,
          error: 'shutting_down',
          message: 'The daemon is shutting down and is not accepting new work.'
        }, 503);
      }
      return mcpEndpoint.handleRequest(context.req.raw);
    });

    // Vault management: list, create (live, no restart), rename (displayName
    // only), and soft-delete (folder to trash, removed from the live registry).
    // Zero vaults is a valid state: `list` simply returns an empty array.
    api.get('/vaults', (context) => {
      return context.json({ ok: true, vaults: registry.list() });
    });

    api.get('/storage', async (context) => {
      return context.json({
        ok: true,
        usedBytes: await registry.storageUsageBytes()
      });
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

    api.put('/vaults/:id/metadata', async (context) => {
      const instance = registry.get(vaultIdParam(context));
      if (!instance) {
        return mapRegistryResult(context, {
          ok: false,
          error: 'not_found',
          message: `No vault with id "${vaultIdParam(context)}".`
        }, undefined);
      }
      const actor = actorFromRequest(context, actorDefault);
      if (!actor.ok) return mapServiceResult(context, actor);
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const metadata = readFolderMetadataBody(body.body);
      if (!metadata.ok) return mapServiceResult(context, metadata);
      const updated = await registry.setMetadata(
        instance.entry.slug,
        metadata.metadata,
        actor.actor
      );
      return mapRegistryResult(context, updated, updated.ok ? { vault: updated.vault } : undefined);
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
      rawPrefix: (context) => `/api/vaults/${vaultIdParam(context)}/raw/`,
      foldersPrefix: (context) => `/api/vaults/${vaultIdParam(context)}/folders/`
    };
    api.get('/vaults/:id/events', (context) => {
      const id = vaultIdParam(context);
      if (!registry.get(id)) {
        return mapServiceResult(context, { ok: false, error: 'not_found', message: `No vault with id "${id}".` });
      }
      return registryEventStreamResponse(registry, id, options.shutdownSignal);
    });
    registerVaultDataRoutes(api, scopedScope, actorDefault, '/vaults/:id', options.shutdownSignal);
  }

  app.route('/api', api);

  const webBuildDir = options.webBuildDir;
  const webProxyTarget = options.webProxyTarget;

  if (webProxyTarget || webBuildDir) {
    app.notFound(async (context) => {
      const { pathname } = new URL(context.req.url);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return notFoundResponse(context);
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

function tokensMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function relayStatus(relay: RelayLifecycleController | undefined): RelayLifecycleStatus {
  return relay?.status() ?? {
    configured: false,
    started: false,
    controlConnected: false,
    reconnectScheduled: false
  };
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
  basePath = '',
  shutdownSignal?: AbortSignal
): void {
  router.post(`${basePath}/ops/flush`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    return mapServiceResult(context, await resolved.service.flushDirtySessions());
  });

  router.get(`${basePath}/events`, (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    return eventStreamResponse(resolved.service, shutdownSignal);
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

  router.get(`${basePath}/raw/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const rawPath = filePathParam(context.req.path, scope.rawPrefix(context));
    const result = await resolved.service.readRawFile({ path: rawPath });
    if (!result.ok) return mapServiceResult(context, result);
    return rawFileResponse(context, result);
  });

  router.put(`${basePath}/raw/*`, async (context) => {
    const request = routePathMutationRequest(context, scope, actorDefault, scope.rawPrefix(context));
    if (!request.ok) return mapServiceResult(context, request);
    const bytes = new Uint8Array(await context.req.raw.arrayBuffer());
    const overwrite = context.req.query('overwrite') === 'true';
    return mapServiceResult(context, await request.service.writeRawFile({
      path: request.path,
      bytes,
      overwrite,
      actor: request.actor
    }), overwrite ? 200 : 201);
  });

  router.get(`${basePath}/files/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    if (context.req.path.endsWith('/history/content')) {
      const filePath = filePathParam(context.req.path, scope.filesPrefix(context), '/history/content');
      const id = context.req.query('id');
      if (!id) {
        return mapServiceResult(context, {
          ok: false,
          error: 'invalid_request',
          message: 'History version id is required.'
        });
      }
      return mapServiceResult(context, await resolved.service.readNoteHistoryVersion({
        path: filePath,
        id
      }));
    }
    if (context.req.path.endsWith('/history')) {
      const filePath = filePathParam(context.req.path, scope.filesPrefix(context), '/history');
      return mapServiceResult(context, await resolved.service.listNoteHistory({
        path: filePath,
        before: context.req.query('before'),
        beforeId: context.req.query('beforeId'),
        limit: queryNumber(context, 'limit')
      }));
    }
    const filePath = filePathParam(context.req.path, scope.filesPrefix(context));
    return mapServiceResult(context, await resolved.service.readNote({ path: filePath }));
  });

  router.put(`${basePath}/files/*`, async (context) => {
    const request = routePathMutationRequest(context, scope, actorDefault, scope.filesPrefix(context));
    if (!request.ok) return mapServiceResult(context, request);
    const content = await requestTextContent(context.req.raw);
    if (!content.ok) return mapServiceResult(context, content);
    const overwrite = context.req.query('overwrite') === 'true';
    return mapServiceResult(context, await request.service.createNote({
      path: request.path,
      content: content.content,
      overwrite,
      actor: request.actor
    }), overwrite ? 200 : 201);
  });

  router.delete(`${basePath}/files/*`, async (context) => {
    const request = routePathMutationRequest(context, scope, actorDefault, scope.filesPrefix(context));
    if (!request.ok) return mapServiceResult(context, request);
    const permanent = context.req.query('permanent') === 'true';
    return mapServiceResult(context, await request.service.deleteNote({
      path: request.path,
      permanent,
      actor: request.actor
    }));
  });

  router.post(`${basePath}/files/*`, async (context) => {
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const service = resolved.service;
    const filesPrefix = scope.filesPrefix(context);

    if (context.req.path.endsWith('/history/boundary')) {
      const filePath = filePathParam(context.req.path, filesPrefix, '/history/boundary');
      return mapServiceResult(context, await service.createNoteHistoryBoundary({
        path: filePath
      }));
    }

    if (context.req.path.endsWith('/splice')) {
      const request = await serviceJsonPathMutationRequest(context, service, actorDefault, filesPrefix, '/splice');
      if (!request.ok) return mapServiceResult(context, request);
      const splice = readSpliceRequest({ body: request.body });
      if (!splice.ok) return mapServiceResult(context, splice);
      return mapServiceResult(context, await service.editNote({
        path: request.path,
        baseline: splice.baseline,
        oldText: splice.request.oldText,
        newText: splice.request.newText,
        before: splice.request.before,
        after: splice.request.after,
        occurrence: splice.request.occurrence,
        actor: request.actor
      }));
    }

    if (context.req.path.endsWith('/append')) {
      const request = await serviceJsonPathMutationRequest(context, service, actorDefault, filesPrefix, '/append');
      if (!request.ok) return mapServiceResult(context, request);
      const content = readRequiredString(request.body, 'content');
      if (!content.ok) return mapServiceResult(context, content);
      return mapServiceResult(context, await service.appendNote({
        path: request.path,
        content: content.value,
        actor: request.actor
      }));
    }

    if (context.req.path.endsWith('/prepend')) {
      const request = await serviceJsonPathMutationRequest(context, service, actorDefault, filesPrefix, '/prepend');
      if (!request.ok) return mapServiceResult(context, request);
      const content = readRequiredString(request.body, 'content');
      if (!content.ok) return mapServiceResult(context, content);
      return mapServiceResult(context, await service.prependNote({
        path: request.path,
        content: content.value,
        actor: request.actor
      }));
    }

    if (!context.req.path.endsWith('/move')) {
      return notFoundResponse(context);
    }

    const request = await serviceJsonPathMutationRequest(context, service, actorDefault, filesPrefix, '/move');
    if (!request.ok) return mapServiceResult(context, request);
    const to = readRequiredString(request.body, 'to');
    if (!to.ok) return mapServiceResult(context, to);
    // Move operations record the move but do not rewrite wikilinks; link-index handling lands later.
    return mapServiceResult(context, await service.moveNote({
      fromPath: request.path,
      toPath: to.value,
      actor: request.actor
    }));
  });

  router.post(`${basePath}/folders`, async (context) => {
    const request = await routeJsonMutationRequest(context, scope, actorDefault);
    if (!request.ok) return mapServiceResult(context, request);
    const folderPath = typeof request.body.path === 'string' ? request.body.path : '';
    return mapServiceResult(context, await request.service.createFolder({
      path: folderPath,
      actor: request.actor
    }), 201);
  });

  router.get(`${basePath}/folders/*`, async (context) => {
    if (!context.req.path.endsWith('/metadata')) {
      return notFoundResponse(context);
    }
    const resolved = scope.resolve(context);
    if (!resolved.ok) return mapServiceResult(context, resolved);
    const folderPath = filePathParam(context.req.path, scope.foldersPrefix(context), '/metadata');
    return mapServiceResult(context, await resolved.service.getFolderMetadata({ path: folderPath }));
  });

  router.put(`${basePath}/folders/*`, async (context) => {
    if (!context.req.path.endsWith('/metadata')) {
      return notFoundResponse(context);
    }
    const request = await routeJsonPathMutationRequest(
      context,
      scope,
      actorDefault,
      scope.foldersPrefix(context),
      '/metadata'
    );
    if (!request.ok) return mapServiceResult(context, request);
    const metadata = readFolderMetadataBody(request.body);
    if (!metadata.ok) return mapServiceResult(context, metadata);
    return mapServiceResult(context, await request.service.setFolderMetadata({
      path: request.path,
      metadata: metadata.metadata,
      actor: request.actor
    }));
  });

  router.delete(`${basePath}/folders/*`, async (context) => {
    const request = routePathMutationRequest(context, scope, actorDefault, scope.foldersPrefix(context));
    if (!request.ok) return mapServiceResult(context, request);
    const recursive = context.req.query('recursive') === 'true';
    const permanent = context.req.query('permanent') === 'true';
    return mapServiceResult(context, await request.service.deleteFolder({
      path: request.path,
      recursive,
      permanent,
      actor: request.actor
    }));
  });

  router.post(`${basePath}/folders/*`, async (context) => {
    if (!context.req.path.endsWith('/move')) {
      return notFoundResponse(context);
    }
    const request = await routeJsonPathMutationRequest(
      context,
      scope,
      actorDefault,
      scope.foldersPrefix(context),
      '/move'
    );
    if (!request.ok) return mapServiceResult(context, request);
    const to = readRequiredString(request.body, 'to');
    if (!to.ok) return mapServiceResult(context, to);
    // Move operations record the move but do not rewrite wikilinks; link-index handling lands later.
    return mapServiceResult(context, await request.service.moveFolder({
      fromPath: request.path,
      toPath: to.value,
      actor: request.actor
    }));
  });
}

function routeMutationRequest(
  context: Context,
  scope: VaultRouteScope,
  actorDefault: ActorDefault
): ServiceResult<MutationRequestSetup> {
  const resolved = scope.resolve(context);
  if (!resolved.ok) return resolved;
  return serviceMutationRequest(context, resolved.service, actorDefault);
}

function routePathMutationRequest(
  context: Context,
  scope: VaultRouteScope,
  actorDefault: ActorDefault,
  prefix: string,
  suffix = ''
): ServiceResult<MutationPathRequestSetup> {
  const request = routeMutationRequest(context, scope, actorDefault);
  if (!request.ok) return request;
  return { ok: true, ...addMutationPath(context, request, prefix, suffix) };
}

async function routeJsonMutationRequest(
  context: Context,
  scope: VaultRouteScope,
  actorDefault: ActorDefault
): Promise<ServiceResult<JsonMutationRequestSetup>> {
  const request = routeMutationRequest(context, scope, actorDefault);
  if (!request.ok) return request;
  return readMutationJson(context, request);
}

async function routeJsonPathMutationRequest(
  context: Context,
  scope: VaultRouteScope,
  actorDefault: ActorDefault,
  prefix: string,
  suffix = ''
): Promise<ServiceResult<JsonMutationPathRequestSetup>> {
  const request = routePathMutationRequest(context, scope, actorDefault, prefix, suffix);
  if (!request.ok) return request;
  return readMutationJson(context, request);
}

function serviceMutationRequest(
  context: Context,
  service: VaultService,
  actorDefault: ActorDefault
): ServiceResult<MutationRequestSetup> {
  const actor = actorFromRequest(context, actorDefault);
  if (!actor.ok) return actor;
  return { ok: true, service, actor: actor.actor };
}

async function serviceJsonPathMutationRequest(
  context: Context,
  service: VaultService,
  actorDefault: ActorDefault,
  prefix: string,
  suffix = ''
): Promise<ServiceResult<JsonMutationPathRequestSetup>> {
  const request = serviceMutationRequest(context, service, actorDefault);
  if (!request.ok) return request;
  const pathRequest = addMutationPath(context, request, prefix, suffix);
  return readMutationJson(context, pathRequest);
}

function addMutationPath(
  context: Context,
  request: MutationRequestSetup,
  prefix: string,
  suffix = ''
): MutationPathRequestSetup {
  return {
    ...request,
    path: filePathParam(context.req.path, prefix, suffix)
  };
}

async function readMutationJson<T extends MutationRequestSetup>(
  context: Context,
  request: T
): Promise<ServiceResult<T & { body: Record<string, unknown> }>> {
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) return body;
  return { ok: true, ...request, body: body.body };
}

function eventStreamResponse(vaultService: VaultService, shutdownSignal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let removeAbortListener: () => void = () => undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = vaultService.onEvent((event) => {
        controller.enqueue(encoder.encode(formatServerSentEvent(event)));
      });
      const abort = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        controller.close();
      };
      shutdownSignal?.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => shutdownSignal?.removeEventListener('abort', abort);
      if (shutdownSignal?.aborted) abort();
    },
    cancel() {
      closed = true;
      removeAbortListener();
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

function registryEventStreamResponse(
  registry: VaultRegistry,
  vaultId: string,
  shutdownSignal?: AbortSignal
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let removeAbortListener: () => void = () => undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = registry.onVaultEvent((event) => {
        if (event.vaultSlug !== vaultId) return;
        controller.enqueue(encoder.encode(formatServerSentEvent(event.event)));
      });
      const abort = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        controller.close();
      };
      shutdownSignal?.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => shutdownSignal?.removeEventListener('abort', abort);
      if (shutdownSignal?.aborted) abort();
    },
    cancel() {
      closed = true;
      removeAbortListener();
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

type RawFileReadResult = Awaited<ReturnType<VaultService['readRawFile']>>;
type RawFileReadSuccess = Extract<RawFileReadResult, { ok: true }>;

function rawFileResponse(context: Context, result: RawFileReadSuccess): Response {
  const etag = rawFileEtag(result.size, result.mtimeMs);
  const headers = new Headers({
    'content-type': result.artifact.contentType,
    'content-length': String(result.size),
    etag,
    'cache-control': 'private, max-age=3600',
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff'
  });

  if (context.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  const stream = Readable.toWeb(createReadStream(result.filePath)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers });
}

function rawFileEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.trunc(mtimeMs)}"`;
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

function notFoundResponse(context: Context, message = 'Not found'): Response {
  return mapServiceResult(context, { ok: false, error: 'not_found', message });
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

function statusForServiceError(error: ServiceErrorCode): 400 | 404 | 409 | 413 | 415 | 500 {
  switch (error) {
    case 'invalid_actor':
    case 'invalid_path':
    case 'invalid_metadata':
    case 'invalid_request':
      return 400;
    case 'not_editable':
      return 415;
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
  const parsed = actorFromHeaders(
    context.req.header(ACTOR_HEADER)
  );

  if (!parsed.ok) return parsed;
  return { ok: true, actor: parsed.actor ?? defaultActor(actorDefault) };
}

export function actorFromHeaders(
  rawKb1Actor: string | undefined
): ServiceResult<{ actor?: VaultActor }> {
  return actorFromHeader(rawKb1Actor, ACTOR_HEADER);
}

function actorFromHeader(
  rawActor: string | undefined,
  headerName = ACTOR_HEADER
): ServiceResult<{ actor?: VaultActor }> {
  if (rawActor === undefined) {
    return { ok: true };
  }

  if (new TextEncoder().encode(rawActor).byteLength > MAX_ACTOR_HEADER_BYTES) {
    return invalidActor(`${headerName} must be 1 KiB or smaller`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawActor);
  } catch {
    return invalidActor(`${headerName} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidActor(`${headerName} must be a JSON object`);
  }

  const actor = parsed as Record<string, unknown>;
  if (actor.kind !== 'user' && actor.kind !== 'integration') {
    return invalidActor(`${headerName}.kind must be "user" or "integration"`);
  }

  const id = readOptionalActorString(actor, 'id', headerName);
  if (!id.ok) return id;
  const name = readOptionalActorString(actor, 'name', headerName);
  if (!name.ok) return name;
  const client = readOptionalActorString(actor, 'client', headerName);
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

function defaultActor(actorDefault: ActorDefault): VaultActor {
  if (actorDefault === 'unknown') {
    return { kind: 'unknown' };
  }

  return { kind: 'user', id: 'local user', name: 'local user' };
}

function readOptionalActorString(
  actor: Record<string, unknown>,
  key: 'id' | 'name' | 'client',
  headerName = ACTOR_HEADER
): ServiceResult<{ value?: string }> {
  if (!Object.prototype.hasOwnProperty.call(actor, key)) {
    return { ok: true };
  }

  if (typeof actor[key] !== 'string') {
    return invalidActor(`${headerName}.${key} must be a string when provided`);
  }

  return { ok: true, value: actor[key] };
}

function invalidActor(message: string): ServiceResult<never> {
  return { ok: false, error: 'invalid_actor', message };
}

function readFolderMetadataBody(body: Record<string, unknown>): ServiceResult<{ metadata: { color?: string | null } }> {
  const metadata: { color?: string | null } = {};

  if (Object.prototype.hasOwnProperty.call(body, 'color')) {
    if (body.color !== null && typeof body.color !== 'string') {
      return { ok: false, error: 'invalid_request', message: 'color must be a string or null when provided' };
    }
    metadata.color = body.color;
  }

  return { ok: true, metadata };
}
