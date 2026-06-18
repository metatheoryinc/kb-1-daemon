#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { bindYjsWebSocket, type DocumentSessionManager } from '@kb-2/doc-session';
import { createLocalMcpEndpoint } from '@kb-2/local-mcp';
import { TunnelClient, type TunnelClientLogger } from '@kb-2/tunnel-client';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readVaultFile, validateVaultPath, writeVaultFile } from '@kb-2/vault-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { createApp, mcpVaultProvider } from './app.js';
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
  VaultRegistry
} from './vault-registry.js';

const DEMO_DOCUMENT_PATH = 'hello-world.md';
const DEMO_DOCUMENT_YJS_PATH = '/api/demo-document/yjs';
const DEFAULT_DEMO_DOCUMENT_CONTENT = [
  '# Hello KB-2',
  '',
  'This Markdown file is served by the local KB-2 daemon.',
  ''
].join('\n');

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

  // Fresh install: ensure the vaults directory and a default vault exist, then
  // seed the demo document into the default vault.
  await mkdir(config.vaultsHome, { recursive: true });
  await mkdir(config.vaultRoot, { recursive: true });
  const hasDemoDocument = await seedDemoDocument(config.vaultRoot);

  // Discover every vault into a live registry: listable, addressable by slug,
  // and mutable at runtime (create/rename/soft-delete) with no restart.
  const trashHome = join(config.kb2Home, VAULT_TRASH_DIRNAME);
  const registry = await VaultRegistry.load(config.vaultsHome, trashHome);

  const defaultInstance = registry.get(DEFAULT_VAULT_SLUG);
  if (!defaultInstance) {
    throw new Error(`Default vault "${DEFAULT_VAULT_SLUG}" was not discovered after boot.`);
  }

  // Backward compat: the existing single-vault HTTP/WS/MCP surface operates on
  // the default vault's instance.
  const documentSessions = defaultInstance.manager;
  const vaultService = defaultInstance.service;
  const demoDocumentSession = hasDemoDocument ? documentSessions.getSession(DEMO_DOCUMENT_PATH) : undefined;
  await demoDocumentSession?.open();

  // One MCP endpoint, every vault: vaultId resolution and vault enumeration both
  // go through the SAME live registry the HTTP layer uses — no second vault map.
  // Omitted vaultId targets the default vault, keeping the single-vault MCP
  // surface backward compatible.
  const mcpEndpoint = createLocalMcpEndpoint(mcpVaultProvider(vaultService, registry));

  const app = createApp({
    statusFile: config.statusFile,
    vaultRoot: config.vaultRoot,
    vaultService,
    documentSessions,
    registry,
    demoDocumentSession,
    mcpEndpoint,
    webBuildDir: fileURLToPath(new URL('../../web/build', import.meta.url)),
    webProxyTarget: config.webProxyTarget,
    actorDefault: config.actorDefault
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
          const tunnelClient = createRelayTunnelClient(config);
          tunnelClient?.start();

          resolve({
            config,
            status,
            close: async () => {
              tunnelClient?.stop();
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
      // Resolve the addressed vault's document manager: the flat WS path uses
      // the default vault, the `/api/vaults/:id/...` path uses that vault.
      const target = resolveWebSocketTarget(pathname, documentSessions, registry);
      if (!target) {
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
            const binding = await bindYjsWebSocket(bindingLease.session, webSocket);
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

function createRelayTunnelClient(config: DaemonConfig): TunnelClient | undefined {
  if (!config.relay) {
    return undefined;
  }

  const daemonUrl = new URL(`http://${config.host}:${config.port}`);
  return new TunnelClient({
    relayUrl: new URL(config.relay.relayUrl),
    daemonUrl,
    token: config.relay.token,
    logger: daemonRelayLogger,
  });
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

async function seedDemoDocument(vaultRoot: string): Promise<boolean> {
  const existing = await readVaultFile({ root: vaultRoot }, DEMO_DOCUMENT_PATH);
  if (existing.ok) return true;
  if (existing.error !== 'not_found') {
    throw new Error(existing.message);
  }

  if (await hasMarkdownFiles(vaultRoot) || await hasKb2State(vaultRoot)) {
    return false;
  }

  const seeded = await writeVaultFile(
    { root: vaultRoot, actor: { kind: 'system' } },
    { path: DEMO_DOCUMENT_PATH, content: DEFAULT_DEMO_DOCUMENT_CONTENT }
  );
  if (!seeded.ok) {
    throw new Error(seeded.message);
  }
  return true;
}

async function hasKb2State(vaultRoot: string): Promise<boolean> {
  try {
    await readdir(join(vaultRoot, '.kb2'), { withFileTypes: true });
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function hasMarkdownFiles(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === '.kb2') {
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      return true;
    }
    if (entry.isDirectory() && await hasMarkdownFiles(join(directory, entry.name))) {
      return true;
    }
  }

  return false;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

interface WebSocketTarget {
  manager: DocumentSessionManager;
  documentPath: string;
}

/**
 * Resolve a Yjs WebSocket path to the document manager and vault-relative path
 * it addresses. Recognizes the demo-document alias, the flat `/api/files/.../yjs`
 * path (default vault), and the scoped `/api/vaults/:id/files/.../yjs` path
 * (the addressed vault). Returns `undefined` for an unknown id or invalid path.
 */
function resolveWebSocketTarget(
  pathname: string,
  defaultManager: DocumentSessionManager,
  registry: VaultRegistry
): WebSocketTarget | undefined {
  if (pathname === DEMO_DOCUMENT_YJS_PATH) {
    return { manager: defaultManager, documentPath: DEMO_DOCUMENT_PATH };
  }

  const suffix = '/yjs';
  if (!pathname.endsWith(suffix)) {
    return undefined;
  }

  const scoped = parseScopedFilesPath(pathname.slice(0, -suffix.length));
  if (scoped) {
    const instance = registry.get(scoped.id);
    if (!instance) {
      return undefined;
    }
    const documentPath = safeValidateFilePath(scoped.rawPath);
    return documentPath ? { manager: instance.manager, documentPath } : undefined;
  }

  const flatPrefix = '/api/files/';
  if (!pathname.startsWith(flatPrefix)) {
    return undefined;
  }
  const documentPath = safeValidateFilePath(pathname.slice(flatPrefix.length, -suffix.length));
  return documentPath ? { manager: defaultManager, documentPath } : undefined;
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
