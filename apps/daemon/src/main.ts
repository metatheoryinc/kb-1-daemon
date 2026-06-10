#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  const app = createApp({
    statusFile: config.statusFile,
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
            close: () =>
              new Promise((closeResolve, closeReject) => {
                server.close((error) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }

                  closeResolve();
                });
              })
          });
        } catch (error) {
          server.close();
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    );

    server.once('error', fail);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDaemon().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
