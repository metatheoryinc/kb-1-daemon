#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { DocumentSessionManager, bindYjsWebSocket } from '@kb-2/doc-session';
import { createLocalMcpEndpoint } from '@kb-2/local-mcp';
import { TunnelClient, type TunnelClientLogger } from '@kb-2/tunnel-client';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readVaultFile, validateVaultPath, writeVaultFile } from '@kb-2/vault-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { createApp } from './app.js';
import { createDaemonConfig, type DaemonConfig } from './config.js';
import { writeDaemonStatus, type DaemonStatus } from './status.js';
import { createVaultService } from '@kb-2/vault-service';

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
  const documentSessions = new DocumentSessionManager({ root: config.vaultRoot });
  const hasDemoDocument = await seedDemoDocument(config.vaultRoot);
  const demoDocumentSession = hasDemoDocument ? documentSessions.getSession(DEMO_DOCUMENT_PATH) : undefined;
  await demoDocumentSession?.open();
  const vaultService = createVaultService({
    vaultRoot: config.vaultRoot,
    documentSessions
  });
  const mcpEndpoint = createLocalMcpEndpoint(vaultService);

  const app = createApp({
    statusFile: config.statusFile,
    vaultRoot: config.vaultRoot,
    vaultService,
    documentSessions,
    demoDocumentSession,
    mcpEndpoint,
    webBuildDir: fileURLToPath(new URL('../../web/build', import.meta.url)),
    webProxyTarget: config.webProxyTarget
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
              await documentSessions.close();
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
      const documentPath = documentPathFromWebSocketPath(pathname);
      if (!documentPath) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void (async () => {
          const bindingLease = documentSessions.attachClientSession(documentPath);
          try {
            const binding = await bindYjsWebSocket(bindingLease.session, webSocket);
            activeDocumentConnections.add(binding.closed);
            binding.closed.finally(() => {
              activeDocumentConnections.delete(binding.closed);
              bindingLease.release();
            }).catch(() => undefined);
          } catch (error) {
            bindingLease.release();
            console.error(error);
            webSocket.close(1011, 'Document session failed to open');
          }
        })();
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

function documentPathFromWebSocketPath(pathname: string): string | undefined {
  if (pathname === DEMO_DOCUMENT_YJS_PATH) {
    return DEMO_DOCUMENT_PATH;
  }

  const prefix = '/api/files/';
  const suffix = '/yjs';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }

  try {
    const candidate = decodeURIComponent(pathname.slice(prefix.length, -suffix.length));
    return validateVaultPath(candidate, 'file');
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
