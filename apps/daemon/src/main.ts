#!/usr/bin/env node
import { serve } from '@hono/node-server';
import {
  bindYjsWebSocket,
  type ClientDocumentSession,
  type DocumentSessionManager,
  type DocumentUpdateAttribution,
  type YjsWebSocketBindingOptions,
  type YjsWebSocketLike,
  type YjsWebSocketTimingEvent
} from '@kb-1/doc-session';
import { createLocalMcpEndpoint } from '@kb-1/local-mcp';
import { TunnelClient, type TunnelClientLogger } from '@kb-1/tunnel-client';
import type { VaultChangeEventKind } from '@kb-1/vault-service';
import { realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { classifyArtifactPath, validateVaultPath, type VaultActor } from '@kb-1/vault-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  ACTOR_HEADER,
  actorFromHeaders,
  createApp,
  mcpVaultProvider,
  type RelayLifecycleController
} from './app.js';
import {
  createDaemonConfig,
  DEFAULT_KB1_HOME_DIRNAME,
  DEFAULT_VAULT_SLUG,
  LEGACY_KB2_HOME_DIRNAME,
  LEGACY_VAULT_DIRNAME,
  type DaemonConfig,
  type ResolveConfigOptions
} from './config.js';
import { migrateDirectoryCopyVerifyCleanup } from './migrations.js';
import { writeDaemonStatus, type DaemonStatus } from './status.js';
import {
  migrateLegacyVaultLayout,
  VAULT_TRASH_DIRNAME,
  VaultRegistry,
  type VaultRegistryChangeEvent
} from './vault-registry.js';

const VAULT_TREE_CHANGED_TOPIC = 'vault.tree.changed';
const VAULT_CONTENT_CHANGED_TOPIC = 'vault.content.changed';
const DOCUMENT_TRACE_HEADER = 'x-kb1-document-trace-id';
const TREE_DIRTY_EVENT_KINDS = new Set<VaultChangeEventKind>([
  'file_created',
  'folder_created',
  'file_deleted',
  'folder_deleted',
  'file_moved',
  'folder_moved',
  'folder_metadata_changed',
  'vault_metadata_changed',
  'external_change_detected'
]);

export interface StartedDaemon {
  config: DaemonConfig;
  status: DaemonStatus;
  close: () => Promise<void>;
}

export type StartDaemonOptions = ResolveConfigOptions;

export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartedDaemon> {
  const config = createDaemonConfig(options);
  const env = options.env ?? process.env;
  const controlToken = env.KB1_CONTROL_TOKEN?.trim();

  for (const warning of config.deprecationWarnings) {
    console.warn(`[${config.serviceName}] ${warning}`);
  }

  await migrateLegacyDaemonHome(config.kb1Home);

  // Boot migration: copy -> verify -> cleanup the legacy single-vault layout.
  await migrateLegacyVaultLayout({
    legacyVaultDir: join(config.kb1Home, LEGACY_VAULT_DIRNAME),
    vaultsHome: config.vaultsHome,
    targetSlug: DEFAULT_VAULT_SLUG
  });

  // Discover every vault into a live registry: listable, addressable by slug,
  // and mutable at runtime (create/rename/soft-delete) with no restart.
  await mkdir(config.vaultsHome, { recursive: true });
  const trashHome = join(config.kb1Home, VAULT_TRASH_DIRNAME);
  const registry = await VaultRegistry.load(config.vaultsHome, trashHome, {
    historyCoalesceWindowMs: config.historyCoalesceWindowMs
  });

  // First boot: with no legacy vault to migrate and nothing discovered, stand up
  // a single starter vault seeded from the bundled kit. `create` performs the
  // seeding, so there is no separate seed path. After first boot, zero vaults is
  // a valid state — deleting every vault leaves the daemon serving an empty list.
  if (registry.list().length === 0) {
    const created = await registry.create({ displayName: DEFAULT_VAULT_SLUG, slug: DEFAULT_VAULT_SLUG });
    if (!created.ok) {
      throw new Error(`Failed to create the starter vault: ${created.message}`);
    }
  }

  // One MCP endpoint, every vault: vaultId resolution and vault enumeration both
  // go through the SAME live registry the HTTP layer uses — no second vault map.
  // Every data tool requires a vaultId; there is no default vault.
  const mcpEndpoint = createLocalMcpEndpoint(mcpVaultProvider(registry), {
    actorFromRequest: (request) => {
      const parsed = actorFromHeaders(
        request.headers.get(ACTOR_HEADER) ?? undefined
      );
      return parsed.ok ? parsed.actor : parsed;
    }
  });
  const relay = createRelayLifecycleController(config, registry);
  const shutdownSignal = new AbortController();
  let closeDaemon: (() => Promise<void>) | undefined;
  let shutdownRequested = false;
  const completeShutdownRequest = () => {
    const close = closeDaemon;
    if (!close) return;
    void close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };

  const app = createApp({
    statusFile: config.statusFile,
    registry,
    mcpEndpoint,
    webBuildDir: fileURLToPath(new URL('../../web/build', import.meta.url)),
    webProxyTarget: config.webProxyTarget,
    actorDefault: config.actorDefault,
    relay,
    shutdownSignal: shutdownSignal.signal,
    ...(controlToken ? {
      shutdown: {
        token: controlToken,
        requested: () => shutdownRequested,
        request() {
          if (shutdownRequested) return;
          shutdownRequested = true;
          setTimeout(completeShutdownRequest, 0);
        }
      }
    } : {})
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let closePromise: Promise<void> | undefined;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const activeDocumentConnections = new Set<Promise<void>>();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const server = serve(
      {
        fetch: app.fetch,
        hostname: config.host,
        port: config.port
      },
      async (info) => {
        try {
          const status = await writeDaemonStatus(config);
          settled = true;

          console.log(`${config.serviceName} listening on http://${info.address}:${info.port}`);
          console.log(`KB1_HOME=${config.kb1Home}`);
          if (config.webProxyTarget) {
            console.log(`KB1_WEB_PROXY_TARGET=${config.webProxyTarget}`);
          }
          console.log(`status=${config.statusFile}`);
          if (!shutdownRequested) {
            relay?.connect();
          }

          const close = closeDaemon;
          if (!close) {
            throw new Error('KB-1 close handler was not initialized.');
          }
          resolve({
            config,
            status,
            close
          });
        } catch (error) {
          server.close();
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    );

    closeDaemon = () => {
      if (!closePromise) {
        // Stop accepting HTTP mutations first. Closing MCP and WebSocket
        // transports then drains active work before the registry persists
        // and closes every document session.
        const serverClosed = closeServer(server);
        shutdownSignal.abort();
        closePromise = (async () => {
          const errors: unknown[] = [];
          try {
            relay?.disconnect();
          } catch (error) {
            errors.push(error);
          }

          const transportResults = await Promise.allSettled([
            mcpEndpoint.close(),
            closeWebSocketServer(webSocketServer, activeDocumentConnections),
            serverClosed
          ]);
          for (const result of transportResults) {
            if (result.status === 'rejected') {
              errors.push(result.reason);
            }
          }

          // Registry persistence is the last shutdown step, but it must still
          // run if one of the transport drains failed. Otherwise a transport
          // error can strand dirty document state in memory.
          try {
            await registry.close();
          } catch (error) {
            errors.push(error);
          }

          if (errors.length > 0) {
            throw new AggregateError(errors, 'KB-1 daemon shutdown did not complete cleanly.');
          }
        })();
      }
      return closePromise;
    };
    if (shutdownRequested) {
      setTimeout(completeShutdownRequest, 0);
    }

    server.on('upgrade', (request, socket, head) => {
      const documentTraceId = traceIdFromDocumentRequest(request);
      const documentTimingStartedAt = performance.now();
      const onDocumentTiming = documentTraceId
        ? (event: YjsWebSocketTimingEvent) => {
            logDocumentTiming(documentTraceId, documentTimingStartedAt, event);
          }
        : undefined;
      if (shutdownRequested) {
        socket.destroy();
        return;
      }
      const pathname = request.url ? new URL(request.url, `http://${request.headers.host ?? 'localhost'}`).pathname : '';
      // Resolve the addressed vault's document manager from the scoped
      // `/api/vaults/:id/files/.../yjs` path. An unknown vault or invalid path
      // is refused.
      const target = resolveWebSocketTarget(pathname, registry);
      if (!target) {
        socket.destroy();
        return;
      }

      const attribution = documentUpdateAttributionFromRequest(request);
      if (!attribution.ok) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        if (documentTraceId) {
          logDocumentTiming(documentTraceId, documentTimingStartedAt, {
            stage: 'websocket.accepted',
            durationMs: elapsedDocumentTimingMs(documentTimingStartedAt)
          });
        }
        // Track the connection's whole lifecycle — handshake, session open (which
        // may repair the session-state snapshot), and the bound stream — in the drain
        // set synchronously, before any await. Shutdown must wait for a connection
        // that is still opening, or its in-flight state write can outlive teardown.
        const lifecycle = (async () => {
          try {
            await bindDocumentWebSocketAfterAttach(
              () => target.manager.attachClientSession(target.documentPath),
              webSocket,
              {
                ...(attribution.attribution ? { attribution: attribution.attribution } : {}),
                ...(onDocumentTiming ? { onTiming: onDocumentTiming } : {})
              },
              () => {
                if (documentTraceId) {
                  logDocumentTiming(documentTraceId, documentTimingStartedAt, {
                    stage: 'document_session.attached',
                    durationMs: elapsedDocumentTimingMs(documentTimingStartedAt)
                  });
                }
              }
            );
          } catch (error) {
            console.error(error);
            webSocket.close(1011, 'Document session failed to open');
          }
        })();
        activeDocumentConnections.add(lifecycle);
        lifecycle.finally(() => {
          activeDocumentConnections.delete(lifecycle);
        }).catch(() => undefined);
      });
    });

    server.once('error', fail);
  });
}

export interface AwaitedDocumentWebSocket extends YjsWebSocketLike {
  once(event: 'close' | 'error', listener: () => void): this;
  off(event: 'close' | 'error', listener: () => void): this;
}

export async function bindDocumentWebSocketAfterAttach(
  attach: () => Promise<ClientDocumentSession>,
  socket: AwaitedDocumentWebSocket,
  options: YjsWebSocketBindingOptions = {},
  onAttached: () => void = () => {},
  bind: typeof bindYjsWebSocket = bindYjsWebSocket
): Promise<void> {
  let lease: ClientDocumentSession | undefined;
  let closedBeforeBinding = socket.readyState !== 1;
  let observingEarlyClose = true;
  const observeEarlyClose = (): void => {
    closedBeforeBinding = true;
  };
  socket.once('close', observeEarlyClose);
  socket.once('error', observeEarlyClose);

  try {
    lease = await attach();
    onAttached();
    if (closedBeforeBinding || socket.readyState !== 1) {
      return;
    }

    // bindYjsWebSocket installs its own close/error listeners synchronously
    // before its first await, so transferring observation here has no event gap.
    socket.off('close', observeEarlyClose);
    socket.off('error', observeEarlyClose);
    observingEarlyClose = false;
    const binding = await bind(lease.session, socket, options);
    await binding.closed;
  } finally {
    if (observingEarlyClose) {
      socket.off('close', observeEarlyClose);
      socket.off('error', observeEarlyClose);
    }
    lease?.release();
  }
}

async function migrateLegacyDaemonHome(kb1Home: string): Promise<void> {
  const legacyHome = legacyDaemonHomeFor(kb1Home);
  if (!legacyHome) return;

  await migrateDirectoryCopyVerifyCleanup({
    source: legacyHome,
    target: kb1Home
  });
}

function legacyDaemonHomeFor(kb1Home: string): string | undefined {
  const leaf = basename(kb1Home);
  if (leaf === DEFAULT_KB1_HOME_DIRNAME) {
    return join(dirname(kb1Home), LEGACY_KB2_HOME_DIRNAME);
  }
  if (leaf === 'kb1') {
    return join(dirname(kb1Home), 'kb2');
  }
  return undefined;
}

function createRelayLifecycleController(
  config: DaemonConfig,
  registry: VaultRegistry
): RelayLifecycleController | undefined {
  if (!config.relay) {
    return undefined;
  }

  const daemonUrl = new URL(`http://${config.host}:${config.port}`);
  const client = new TunnelClient({
    relayUrl: new URL(config.relay.relayUrl),
    daemonUrl,
    token: config.relay.token,
    daemonVersion: config.relay.daemonVersion,
    daemonBuild: config.relay.daemonBuild,
    dialbackPoolSize: config.relay.dialbackPoolSize,
    logger: daemonRelayLogger,
  });
  let unsubscribeVaultEvents: (() => void) | undefined;
  const ensureVaultEventSubscription = () => {
    if (unsubscribeVaultEvents) return;
    unsubscribeVaultEvents = registry.onVaultEvent((event) => {
      for (const relayEvent of relayEventsForVaultChange(event)) {
        client.sendRelayEvent(relayEvent);
      }
    });
  };
  const releaseVaultEventSubscription = () => {
    unsubscribeVaultEvents?.();
    unsubscribeVaultEvents = undefined;
  };
  return {
    status() {
      return { configured: true, ...client.status() };
    },
    connect() {
      client.start();
      ensureVaultEventSubscription();
      return { configured: true, ...client.status() };
    },
    disconnect() {
      releaseVaultEventSubscription();
      client.stop();
      return { configured: true, ...client.status() };
    },
  };
}

function isTreeDirtyVaultEvent(event: VaultRegistryChangeEvent): boolean {
  return TREE_DIRTY_EVENT_KINDS.has(event.event.kind)
    && (event.event.kind !== 'external_change_detected' || event.event.path === '');
}

export function relayEventsForVaultChange(event: VaultRegistryChangeEvent): Array<{
  topic: string;
  resource: Record<string, string>;
}> {
  const relayEvents: Array<{
    topic: string;
    resource: Record<string, string>;
  }> = [];
  if (isTreeDirtyVaultEvent(event)) {
    relayEvents.push({
      topic: VAULT_TREE_CHANGED_TOPIC,
      resource: { vaultSlug: event.vaultSlug, cause: event.event.kind }
    });
  }
  if (
    event.event.kind === 'content_persisted'
    || (event.event.kind === 'external_change_detected' && event.event.path !== '')
  ) {
    relayEvents.push({
      topic: VAULT_CONTENT_CHANGED_TOPIC,
      resource: { vaultSlug: event.vaultSlug, path: event.event.path }
    });
  }
  return relayEvents;
}

const daemonRelayLogger: TunnelClientLogger = {
  log(level, message, fields) {
    const entry = fields ? { message, ...fields } : { message };
    if (level === 'error') {
      console.error('[relay]', entry);
      return;
    }
    if (level === 'warn') {
      console.warn('[relay]', entry);
      return;
    }
    console.log('[relay]', entry);
  },
};

interface WebSocketTarget {
  manager: DocumentSessionManager;
  documentPath: string;
}

/**
 * Resolve a Yjs WebSocket path to the document manager and vault-relative path
 * it addresses. Only the scoped `/api/vaults/:id/files/.../yjs` path is served;
 * there is no flat (default-vault) path. Returns `undefined` for an unknown id
 * or invalid path so the upgrade is refused.
 */
function resolveWebSocketTarget(
  pathname: string,
  registry: VaultRegistry
): WebSocketTarget | undefined {
  const suffix = '/yjs';
  if (!pathname.endsWith(suffix)) {
    return undefined;
  }

  const scoped = parseScopedFilesPath(pathname.slice(0, -suffix.length));
  if (!scoped) {
    return undefined;
  }

  const instance = registry.get(scoped.id);
  if (!instance) {
    return undefined;
  }
  const documentPath = safeValidateFilePath(scoped.rawPath);
  return documentPath ? { manager: instance.manager, documentPath } : undefined;
}

function documentUpdateAttributionFromRequest(
  request: IncomingMessage
): { ok: true; attribution?: DocumentUpdateAttribution } | { ok: false } {
  const parsed = actorFromHeaders(
    firstHeaderValue(request.headers[ACTOR_HEADER])
  );
  if (!parsed.ok) return { ok: false };
  return {
    ok: true,
    ...(parsed.actor ? { attribution: documentUpdateAttributionForActor(parsed.actor) } : {})
  };
}

function documentUpdateAttributionForActor(actor: VaultActor): DocumentUpdateAttribution {
  const attributedActor: Record<string, string> = { kind: actor.kind };
  if (actor.id !== undefined) attributedActor.id = actor.id;
  if (actor.name !== undefined) attributedActor.name = actor.name;
  if (actor.client !== undefined) attributedActor.client = actor.client;
  return { actor: attributedActor };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function traceIdFromDocumentRequest(request: IncomingMessage): string | undefined {
  const value = firstHeaderValue(request.headers[DOCUMENT_TRACE_HEADER]);
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function logDocumentTiming(
  traceId: string,
  startedAt: number,
  event: {
    stage: string;
    durationMs: number;
    observedAtMs?: number;
    outcome?: string;
    ackId?: string;
    documentChars?: number;
    stateVectorBytes?: number;
    stateVectorFingerprint?: string;
    updateBytes?: number;
    updateFingerprint?: string;
  }
): void {
  console.log('[document timing]', {
    component: 'daemon',
    traceId,
    stage: event.stage,
    elapsedMs:
      event.observedAtMs === undefined
        ? elapsedDocumentTimingMs(startedAt)
        : elapsedDocumentTimingMs(startedAt, event.observedAtMs),
    durationMs: event.durationMs,
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.ackId ? { ackId: event.ackId } : {}),
    ...(event.documentChars !== undefined ? { documentChars: event.documentChars } : {}),
    ...(event.stateVectorBytes !== undefined ? { stateVectorBytes: event.stateVectorBytes } : {}),
    ...(event.stateVectorFingerprint ? { stateVectorFingerprint: event.stateVectorFingerprint } : {}),
    ...(event.updateBytes !== undefined ? { updateBytes: event.updateBytes } : {}),
    ...(event.updateFingerprint ? { updateFingerprint: event.updateFingerprint } : {})
  });
}

function elapsedDocumentTimingMs(startedAt: number, observedAtMs = performance.now()): number {
  return Math.max(0, Math.round((observedAtMs - startedAt) * 100) / 100);
}

/** Parse `/api/vaults/<id>/files/<rawPath>` into its id and raw file path. */
function parseScopedFilesPath(pathWithoutYjs: string): { id: string; rawPath: string } | undefined {
  const prefix = '/api/vaults/';
  if (!pathWithoutYjs.startsWith(prefix)) {
    return undefined;
  }

  const rest = pathWithoutYjs.slice(prefix.length);
  const filesMarker = '/files/';
  const markerIndex = rest.indexOf(filesMarker);
  if (markerIndex <= 0) {
    return undefined;
  }

  const id = rest.slice(0, markerIndex);
  const rawPath = rest.slice(markerIndex + filesMarker.length);
  if (id.length === 0 || rawPath.length === 0) {
    return undefined;
  }

  return { id, rawPath };
}

function safeValidateFilePath(rawPath: string): string | undefined {
  try {
    const filePath = validateVaultPath(decodeURIComponent(rawPath), 'file');
    return classifyArtifactPath(filePath).editable ? filePath : undefined;
  } catch {
    return undefined;
  }
}

async function closeWebSocketServer(server: WebSocketServer, activeDocumentConnections: Set<Promise<void>>): Promise<void> {
  for (const client of server.clients) {
    client.close(1001, 'Daemon shutting down');
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      Promise.allSettled(activeDocumentConnections).then(() => resolve(), reject);
    });
  });
}

function closeServer(server: ReturnType<typeof serve>): Promise<void> {
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

export function isDaemonCliEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return metaUrl === pathToFileURL(argv1).href;
  }
}

if (isDaemonCliEntrypoint(import.meta.url, process.argv[1])) {
  let startedDaemon: StartedDaemon | undefined;
  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      if (!startedDaemon) {
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
        return;
      }

      startedDaemon.close().then(
        () => {
          process.exitCode = signal === 'SIGINT' ? 130 : 143;
        },
        (error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        }
      );
    });
  }

  startDaemon().then((daemon) => {
    startedDaemon = daemon;
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
