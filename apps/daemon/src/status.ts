import { mkdir, readFile, writeFile } from 'node:fs/promises';

import type { DaemonConfig } from './config.js';

export interface DaemonStatus {
  serviceName: string;
  startedAt: string;
  kb2Home: string;
  daemonHome: string;
  statusFile: string;
  pid: number;
  nodeVersion: string;
}

export async function writeDaemonStatus(config: DaemonConfig): Promise<DaemonStatus> {
  const status: DaemonStatus = {
    serviceName: config.serviceName,
    startedAt: config.startedAt,
    kb2Home: config.kb2Home,
    daemonHome: config.daemonHome,
    statusFile: config.statusFile,
    pid: config.pid,
    nodeVersion: process.version
  };

  await mkdir(config.daemonHome, { recursive: true });
  await writeFile(config.statusFile, `${JSON.stringify(status, null, 2)}\n`, 'utf8');

  return status;
}

export async function readDaemonStatus(statusFile: string): Promise<DaemonStatus> {
  const contents = await readFile(statusFile, 'utf8');
  const parsed = JSON.parse(contents) as unknown;

  if (!isDaemonStatus(parsed)) {
    throw new Error(`Daemon status file is missing required fields: ${statusFile}`);
  }

  return parsed;
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const status = value as Record<string, unknown>;

  return typeof status.serviceName === 'string'
    && typeof status.startedAt === 'string'
    && typeof status.kb2Home === 'string'
    && typeof status.daemonHome === 'string'
    && typeof status.statusFile === 'string'
    && typeof status.pid === 'number'
    && typeof status.nodeVersion === 'string';
}
