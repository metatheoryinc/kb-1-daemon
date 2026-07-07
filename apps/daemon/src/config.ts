import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SERVICE_NAME = 'kb1d';
export const LEGACY_SERVICE_NAME = 'kb2d';
export const DEFAULT_PORT = 7382;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ACTOR_DEFAULT = 'user';
export const DEFAULT_HISTORY_COALESCE_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_KB1_HOME_DIRNAME = '.kb1';
export const LEGACY_KB2_HOME_DIRNAME = '.kb2';

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
  historyCoalesceWindowMs: number;
  kb1Home: string;
  daemonHome: string;
  /** Directory that holds every vault: `<home>/vaults/<slug>/`. */
  vaultsHome: string;
  /**
   * Well-known root of the vault stood up on first boot (and the legacy
   * migration target): `<vaultsHome>/<default slug>/`. A convenience pointer to
   * that location — the daemon serves vaults through the registry, not this path.
   */
  vaultRoot: string;
  statusFile: string;
  startedAt: string;
  pid: number;
  deprecationWarnings: string[];
}

export interface DaemonRelayConfig {
  relayUrl: string;
  token: string;
  daemonVersion?: string;
  daemonBuild?: string;
}

export interface ResolveConfigOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: Date;
  pid?: number;
}

type ResolvedEnvValue = {
  value: string | undefined;
  primaryName: string;
  legacyName: string;
  legacyUsed: boolean;
  legacyPresent: boolean;
};

export function resolveKb1Home(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir()
): string {
  return resolveKb1HomeResult(env, homeDir).home;
}

function resolveKb1HomeResult(
  env: NodeJS.ProcessEnv,
  homeDir: string
): { home: string; deprecationWarnings: string[] } {
  const configuredHome = resolveEnvValue(env, 'HOME');
  if (configuredHome.value) {
    return {
      home: resolve(expandHome(configuredHome.value, homeDir)),
      deprecationWarnings: deprecationWarningsFor(configuredHome)
    };
  }

  const kb1Home = join(homeDir, DEFAULT_KB1_HOME_DIRNAME);
  const legacyKb2Home = join(homeDir, LEGACY_KB2_HOME_DIRNAME);
  if (!pathExists(kb1Home) && pathExists(legacyKb2Home)) {
    return {
      home: resolve(legacyKb2Home),
      deprecationWarnings: [
        `Using existing legacy ${LEGACY_KB2_HOME_DIRNAME} home because ${DEFAULT_KB1_HOME_DIRNAME} does not exist yet. New installs use ${DEFAULT_KB1_HOME_DIRNAME}; set KB1_HOME to choose a different location.`
      ]
    };
  }

  return { home: resolve(kb1Home), deprecationWarnings: [] };
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const configuredPort = resolveEnvValue(env, 'PORT').value;

  if (!configuredPort) {
    return DEFAULT_PORT;
  }

  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`KB1_PORT/KB2_PORT must be an integer between 1 and 65535. Received: ${configuredPort}`);
  }

  return port;
}

function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHost = resolveEnvValue(env, 'HOST').value;
  return configuredHost && configuredHost.length > 0 ? configuredHost : DEFAULT_HOST;
}

export function resolveWebProxyTarget(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configuredTarget = resolveEnvValue(env, 'WEB_PROXY_TARGET').value;
  return configuredTarget && configuredTarget.length > 0 ? configuredTarget : undefined;
}

export function resolveRelayConfig(env: NodeJS.ProcessEnv = process.env): DaemonRelayConfig | undefined {
  const relayUrl = resolveEnvValue(env, 'RELAY_URL').value;
  const token = resolveEnvValue(env, 'RELAY_TOKEN').value;

  if (!relayUrl && !token) {
    return undefined;
  }

  if (!relayUrl || !token) {
    throw new Error('KB1_RELAY_URL/KB2_RELAY_URL and KB1_RELAY_TOKEN/KB2_RELAY_TOKEN must be supplied together.');
  }

  const daemonVersion = resolveEnvValue(env, 'DAEMON_VERSION').value;
  const daemonBuild = resolveEnvValue(env, 'DAEMON_BUILD').value;

  return {
    relayUrl: new URL(relayUrl).href,
    token,
    ...(daemonVersion ? { daemonVersion } : {}),
    ...(daemonBuild ? { daemonBuild } : {})
  };
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveActorDefault(env: NodeJS.ProcessEnv = process.env): ActorDefault {
  const configuredDefault = resolveEnvValue(env, 'ACTOR_DEFAULT').value;

  if (!configuredDefault) {
    return DEFAULT_ACTOR_DEFAULT;
  }

  if (configuredDefault === 'user' || configuredDefault === 'unknown') {
    return configuredDefault;
  }

  throw new Error(`KB1_ACTOR_DEFAULT/KB2_ACTOR_DEFAULT must be "user" or "unknown". Received: ${configuredDefault}`);
}

export function resolveHistoryCoalesceWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const configuredWindow = resolveEnvValue(env, 'HISTORY_COALESCE_WINDOW_MS').value;

  if (!configuredWindow) {
    return DEFAULT_HISTORY_COALESCE_WINDOW_MS;
  }

  const windowMs = Number(configuredWindow);
  if (!Number.isInteger(windowMs) || windowMs < 0) {
    throw new Error(`KB1_HISTORY_COALESCE_WINDOW_MS/KB2_HISTORY_COALESCE_WINDOW_MS must be a non-negative integer. Received: ${configuredWindow}`);
  }

  return windowMs;
}

export function collectConfigDeprecationWarnings(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir()
): string[] {
  const warnings = [
    ...resolveKb1HomeResult(env, homeDir).deprecationWarnings
  ];
  for (const suffix of [
    'HOME',
    'HOST',
    'PORT',
    'WEB_PROXY_TARGET',
    'RELAY_URL',
    'RELAY_TOKEN',
    'DAEMON_VERSION',
    'DAEMON_BUILD',
    'ACTOR_DEFAULT',
    'HISTORY_COALESCE_WINDOW_MS'
  ]) {
    warnings.push(...deprecationWarningsFor(resolveEnvValue(env, suffix)));
  }
  return [...new Set(warnings)];
}

export function createDaemonConfig(options: ResolveConfigOptions = {}): DaemonConfig {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const kb1HomeResult = resolveKb1HomeResult(env, homeDir);
  const kb1Home = kb1HomeResult.home;
  const daemonHome = join(kb1Home, 'daemon');
  const vaultsHome = join(kb1Home, VAULTS_DIRNAME);
  const vaultRoot = join(vaultsHome, DEFAULT_VAULT_SLUG);

  return {
    serviceName: SERVICE_NAME,
    host: resolveHost(env),
    port: resolvePort(env),
    webProxyTarget: resolveWebProxyTarget(env),
    relay: resolveRelayConfig(env),
    actorDefault: resolveActorDefault(env),
    historyCoalesceWindowMs: resolveHistoryCoalesceWindowMs(env),
    kb1Home,
    daemonHome,
    vaultsHome,
    vaultRoot,
    statusFile: join(daemonHome, 'status.json'),
    startedAt: (options.now ?? new Date()).toISOString(),
    pid: options.pid ?? process.pid,
    deprecationWarnings: collectConfigDeprecationWarnings(env, homeDir)
  };
}

function resolveEnvValue(env: NodeJS.ProcessEnv, suffix: string): ResolvedEnvValue {
  const primaryName = `KB1_${suffix}`;
  const legacyName = `KB2_${suffix}`;
  const primary = optionalEnv(env[primaryName]);
  const legacy = optionalEnv(env[legacyName]);

  return {
    value: primary ?? legacy,
    primaryName,
    legacyName,
    legacyUsed: primary === undefined && legacy !== undefined,
    legacyPresent: legacy !== undefined
  };
}

function deprecationWarningsFor(resolved: ResolvedEnvValue): string[] {
  if (!resolved.legacyPresent) {
    return [];
  }

  if (resolved.legacyUsed) {
    return [`${resolved.legacyName} is deprecated; use ${resolved.primaryName} instead.`];
  }

  return [`${resolved.legacyName} is deprecated and ignored because ${resolved.primaryName} is set.`];
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
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
