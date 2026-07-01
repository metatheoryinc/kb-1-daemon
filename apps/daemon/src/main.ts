#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { bindYjsWebSocket, type DocumentSessionManager, type DocumentUpdateAttribution } from '@kb-2/doc-session';
import { createLocalMcpEndpoint } from '@kb-2/local-mcp';
import { TunnelClient, type TunnelClientLogger } from '@kb-2/tunnel-client';
import type { VaultChangeEventKind } from '@kb-2/vault-service';
import type { IncomingMessage } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateVaultPath, type VaultActor } from '@kb-2/vault-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { ACTOR_HEADER, actorFromHeader, createApp, mcpVaultProvider, type RelayLifecycleController } from './app.js';
import {
  createDaemonConfig,
  DEFAULT_VAULT_SLUG,
  LEGACY_VAULT_DIRNAME,
  type DaemonConfig
} from './config.js';
import { writeDaemonStatus, type DaemonStatus } from './status.js';
import {
  migrateLegacyVaultLayout,
  VAULT_TRASH_DIRNAME,
  VaultRegistry,
  type VaultRegistryChangeEvent
} from './vault-registry.js';

const VAULT_TREE_CHANGED_TOPIC = 'vault.tree.changed';
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

export async function startDaemon(): Promise<StartedDaemon> {
  const config = createDaemonConfig();

  // Boot migration: copy -> verify -> cleanup the legacy single-vault layout.
  await migrateLegacyVaultLayout({
    legacyVaultDir: join(config.kb2Home, LEGACY_VAULT_DIRNAME),
    vaultsHome: config.vaultsHome,
    targetSlug: DEFAULT_VAULT_SLUG
  });

  // Discover every vault into a live registry: listable, addressable by slug,
  // and mutable at runtime (create/rename/soft-delete) with no restart.
  await mkdir(config.vaultsHome, { recursive: true });
  const trashHome = join(config.kb2Home, VAULT_TRASH_DIRNAME);
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
  const mcpEndpoint = createLocalMcpEndpoint(mcpVaultProvider(registry));
  const relay = createRelayLifecycleController(config, registry);

  const app = createApp({
    statusFile: config.statusFile,
    registry,
    mcpEndpoint,
    webBuildDir: fileURLToPath(new URL('../../web/build', import.meta.url)),
    webProxyTarget: config.webProxyTarget,
    actorDefault: config.actorDefault,
    relay
  });

  return new Promise((resolve, reject) => {
    let settled = false;
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
          console.log(`KB2_HOME=${config.kb2Home}`);
          if (config.webProxyTarget) {
            console.log(`KB2_WEB_PROXY_TARGET=${config.webProxyTarget}`);
          }
          console.log(`status=${config.statusFile}`);
          relay?.connect();

          resolve({
            config,
            status,
            close: async () => {
              relay?.disconnect();
              await mcpEndpoint.close();
              await closeWebSocketServer(webSocketServer, activeDocumentConnections);
              await closeServer(server);
              await registry.close();
            }
          });
        } catch (error) {
          server.close();
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    );

    server.on('upgrade', (request, socket, head) => {
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
        // Track the connection's whole lifecycle — handshake, session open (which
        // writes the session-state snapshot), and the bound stream — in the drain
        // set synchronously, before any await. Shutdown must wait for a connection
        // that is still opening, or its in-flight state write can outlive teardown.
        const lifecycle = (async () => {
          const bindingLease = target.manager.attachClientSession(target.documentPath);
          try {
            const binding = await bindYjsWebSocket(
              bindingLease.session,
              webSocket,
              attribution.attribution ? { attribution: attribution.attribution } : {}
            );
            try {
              await binding.closed;
            } finally {
              bindingLease.release();
            }
          } catch (error) {
            bindingLease.release();
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
    logger: daemonRelayLogger,
  });
  let unsubscribeVaultEvents: (() => void) | undefined;
  const ensureVaultEventSubscription = () => {
    if (unsubscribeVaultEvents) return;
    unsubscribeVaultEvents = registry.onVaultEvent((event) => {
      if (!isTreeDirtyVaultEvent(event)) return;

      client.sendRelayEvent({
        topic: VAULT_TREE_CHANGED_TOPIC,
        resource: { vaultSlug: event.vaultSlug, cause: event.event.kind },
      });
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
  const parsed = actorFromHeader(firstHeaderValue(request.headers[ACTOR_HEADER]));
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
    return validateVaultPath(decodeURIComponent(rawPath), 'file');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
