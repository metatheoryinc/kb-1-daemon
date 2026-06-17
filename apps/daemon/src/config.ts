import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SERVICE_NAME = 'kb2d';
export const DEFAULT_PORT = 7382;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ACTOR_DEFAULT = 'user';

export type ActorDefault = 'user' | 'unknown';

export const DEFAULT_VAULT_SLUG = 'demo-vault';
export const LEGACY_VAULT_DIRNAME = 'demo-vault';
export const VAULTS_DIRNAME = 'vaults';

export interface DaemonConfig {
  serviceName: typeof SERVICE_NAME;
  host: string;
  port: number;
  webProxyTarget?: string;
  relay?: DaemonRelayConfig;
  actorDefault: ActorDefault;
  kb2Home: string;
  daemonHome: string;
  /** Directory that holds every vault: `<home>/vaults/<slug>/`. */
  vaultsHome: string;
  /**
   * Root of the default vault. Derived from the default slug under
   * `vaultsHome` for backward compatibility with the single-vault surface.
   */
  vaultRoot: string;
  statusFile: string;
  startedAt: string;
  pid: number;
}

export interface DaemonRelayConfig {
  relayUrl: string;
  token: string;
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

function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHost = env.KB2_HOST?.trim();
  return configuredHost && configuredHost.length > 0 ? configuredHost : DEFAULT_HOST;
}

export function resolveWebProxyTarget(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configuredTarget = env.KB2_WEB_PROXY_TARGET?.trim();
  return configuredTarget && configuredTarget.length > 0 ? configuredTarget : undefined;
}

export function resolveRelayConfig(env: NodeJS.ProcessEnv = process.env): DaemonRelayConfig | undefined {
  const relayUrl = env.KB2_RELAY_URL?.trim();
  const token = env.KB2_RELAY_TOKEN?.trim();

  if (!relayUrl && !token) {
    return undefined;
  }

  if (!relayUrl || !token) {
    throw new Error('KB2_RELAY_URL and KB2_RELAY_TOKEN must be supplied together.');
  }

  return {
    relayUrl: new URL(relayUrl).href,
    token
  };
}

export function resolveActorDefault(env: NodeJS.ProcessEnv = process.env): ActorDefault {
  const configuredDefault = env.KB2_ACTOR_DEFAULT?.trim();

  if (!configuredDefault) {
    return DEFAULT_ACTOR_DEFAULT;
  }

  if (configuredDefault === 'user' || configuredDefault === 'unknown') {
    return configuredDefault;
  }

  throw new Error(`KB2_ACTOR_DEFAULT must be "user" or "unknown". Received: ${configuredDefault}`);
}

export function createDaemonConfig(options: ResolveConfigOptions = {}): DaemonConfig {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const kb2Home = resolveKb2Home(env, homeDir);
  const daemonHome = join(kb2Home, 'daemon');
  const vaultsHome = join(kb2Home, VAULTS_DIRNAME);
  const vaultRoot = join(vaultsHome, DEFAULT_VAULT_SLUG);

  return {
    serviceName: SERVICE_NAME,
    host: resolveHost(env),
    port: resolvePort(env),
    webProxyTarget: resolveWebProxyTarget(env),
    relay: resolveRelayConfig(env),
    actorDefault: resolveActorDefault(env),
    kb2Home,
    daemonHome,
    vaultsHome,
    vaultRoot,
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
