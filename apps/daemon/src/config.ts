import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SERVICE_NAME = 'kb2d';
export const DEFAULT_PORT = 7382;
export const DEFAULT_HOST = '127.0.0.1';

export interface DaemonConfig {
  serviceName: typeof SERVICE_NAME;
  host: string;
  port: number;
  webProxyTarget?: string;
  kb2Home: string;
  daemonHome: string;
  demoDocumentFile: string;
  statusFile: string;
  startedAt: string;
  pid: number;
}

export interface ResolveConfigOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: Date;
  pid?: number;
}

export function resolveKb2Home(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir()
): string {
  const configuredHome = env.KB2_HOME?.trim();
  const rawHome = configuredHome && configuredHome.length > 0
    ? expandHome(configuredHome, homeDir)
    : join(homeDir, '.kb2');

  return resolve(rawHome);
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const configuredPort = env.KB2_PORT?.trim();

  if (!configuredPort) {
    return DEFAULT_PORT;
  }

  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`KB2_PORT must be an integer between 1 and 65535. Received: ${configuredPort}`);
  }

  return port;
}

export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHost = env.KB2_HOST?.trim();
  return configuredHost && configuredHost.length > 0 ? configuredHost : DEFAULT_HOST;
}

export function resolveWebProxyTarget(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configuredTarget = env.KB2_WEB_PROXY_TARGET?.trim();
  return configuredTarget && configuredTarget.length > 0 ? configuredTarget : undefined;
}

export function createDaemonConfig(options: ResolveConfigOptions = {}): DaemonConfig {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const kb2Home = resolveKb2Home(env, homeDir);
  const daemonHome = join(kb2Home, 'daemon');
  const demoDocumentFile = join(kb2Home, 'demo-vault', 'hello-world.md');

  return {
    serviceName: SERVICE_NAME,
    host: resolveHost(env),
    port: resolvePort(env),
    webProxyTarget: resolveWebProxyTarget(env),
    kb2Home,
    daemonHome,
    demoDocumentFile,
    statusFile: join(daemonHome, 'status.json'),
    startedAt: (options.now ?? new Date()).toISOString(),
    pid: options.pid ?? process.pid
  };
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') {
    return homeDir;
  }

  if (input.startsWith('~/')) {
    return join(homeDir, input.slice(2));
  }

  return input;
}
