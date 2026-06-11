#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { DEMO_DOCUMENT_YJS_PATH, DocumentSessionManager, bindYjsWebSocket } from '@kb-2/doc-session';
import { validateVaultPath } from '@kb-2/vault-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { createApp } from './app.js';
import { createDaemonConfig, type DaemonConfig } from './config.js';
import { writeDaemonStatus, type DaemonStatus } from './status.js';

export interface StartedDaemon {
  config: DaemonConfig;
  status: DaemonStatus;
  close: () => Promise<void>;
}

export async function startDaemon(): Promise<StartedDaemon> {
  const config = createDaemonConfig();
  const documentSessions = new DocumentSessionManager({ root: config.vaultRoot });
  const demoDocumentSession = documentSessions.getSession('hello-world.md');
  await demoDocumentSession.open();

  const app = createApp({
    statusFile: config.statusFile,
    vaultRoot: config.vaultRoot,
    documentSessions,
    demoDocumentSession,
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

          resolve({
            config,
            status,
            close: async () => {
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

function documentPathFromWebSocketPath(pathname: string): string | undefined {
  if (pathname === DEMO_DOCUMENT_YJS_PATH) {
    return 'hello-world.md';
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
