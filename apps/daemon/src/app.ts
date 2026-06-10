import { Hono } from 'hono';

import { SERVICE_NAME } from './config.js';
import { readDaemonStatus } from './status.js';

export interface CreateAppOptions {
  statusFile: string;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();

  app.get('/health', async (context) => {
    const status = await readDaemonStatus(options.statusFile);

    return context.json({
      ok: true,
      service: SERVICE_NAME,
      status
    });
  });

  return app;
}
