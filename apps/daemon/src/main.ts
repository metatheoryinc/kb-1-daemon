#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';

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
  const status = await writeDaemonStatus(config);
  const app = createApp({ statusFile: config.statusFile });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port
    },
    (info) => {
      console.log(`${config.serviceName} listening on http://${info.address}:${info.port}`);
      console.log(`KB2_HOME=${config.kb2Home}`);
      console.log(`status=${config.statusFile}`);
    }
  );

  return {
    config,
    status,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDaemon().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
