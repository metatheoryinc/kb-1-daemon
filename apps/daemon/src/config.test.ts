import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  collectConfigDeprecationWarnings,
  createDaemonConfig,
  DEFAULT_HISTORY_COALESCE_WINDOW_MS,
  resolveActorDefault,
  resolveHistoryCoalesceWindowMs,
  resolveKb1Home,
  resolvePort,
  resolveRelayConfig,
  resolveWebProxyTarget
} from './config.js';

describe('daemon config', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'kb1-config-test-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  it('defaults KB1_HOME to a user-level .kb1 directory for new installs', () => {
    const homeDir = join(tempRoot, 'new-user-home');

    expect(resolveKb1Home({}, homeDir)).toBe(join(homeDir, '.kb1'));
  });

  it('uses KB1_HOME when supplied', () => {
    const kb1Home = join(tempRoot, 'configured-home');

    expect(resolveKb1Home({ KB1_HOME: kb1Home }, '/ignored')).toBe(kb1Home);
  });

  it('expands a home-relative KB1_HOME override', () => {
    const homeDir = join(tempRoot, 'user-home');

    expect(resolveKb1Home({ KB1_HOME: '~/workspace' }, homeDir)).toBe(join(homeDir, 'workspace'));
  });

  it('defaults to .kb1 even when a legacy .kb2 home exists', async () => {
    const homeDir = join(tempRoot, 'upgrade-user-home');
    await mkdir(join(homeDir, '.kb2'), { recursive: true });

    expect(resolveKb1Home({}, homeDir)).toBe(join(homeDir, '.kb1'));
    expect(collectConfigDeprecationWarnings({}, homeDir)).toEqual([]);
  });

  it('prefers an existing .kb1 home over a legacy .kb2 home', async () => {
    const homeDir = join(tempRoot, 'dual-home-user');
    await mkdir(join(homeDir, '.kb1'), { recursive: true });
    await mkdir(join(homeDir, '.kb2'), { recursive: true });

    expect(resolveKb1Home({}, homeDir)).toBe(join(homeDir, '.kb1'));
  });

  it('ignores KB2_HOME', () => {
    const legacyHome = join(tempRoot, 'legacy-configured-home');

    expect(resolveKb1Home({ KB2_HOME: legacyHome }, tempRoot)).toBe(join(tempRoot, '.kb1'));
    expect(collectConfigDeprecationWarnings({ KB2_HOME: legacyHome }, tempRoot)).toEqual([]);
  });

  it('uses KB1_HOME when KB2_HOME is also supplied', () => {
    const kb1Home = join(tempRoot, 'primary-home');
    const legacyHome = join(tempRoot, 'legacy-home');

    expect(resolveKb1Home({ KB1_HOME: kb1Home, KB2_HOME: legacyHome }, '/ignored')).toBe(kb1Home);
    expect(collectConfigDeprecationWarnings({ KB1_HOME: kb1Home, KB2_HOME: legacyHome }, '/ignored')).toEqual([]);
  });

  it('resolves host, port, daemon directory, and status path', () => {
    const now = new Date('2026-06-10T15:00:00.000Z');
    const kb1Home = join(tempRoot, 'daemon-home');
    const config = createDaemonConfig({
      env: {
        KB1_HOME: kb1Home,
        KB1_HOST: '0.0.0.0',
        KB1_PORT: '8399',
        KB1_WEB_PROXY_TARGET: 'http://127.0.0.1:5173',
        KB1_RELAY_URL: 'http://127.0.0.1:9920/t/dev1',
        KB1_RELAY_TOKEN: 'test-token'
      },
      now,
      pid: 1234
    });

    expect(config).toEqual({
      serviceName: 'kb1d',
      host: '0.0.0.0',
      port: 8399,
      webProxyTarget: 'http://127.0.0.1:5173',
      relay: {
        relayUrl: 'http://127.0.0.1:9920/t/dev1',
        token: 'test-token'
      },
      actorDefault: 'user',
      historyCoalesceWindowMs: DEFAULT_HISTORY_COALESCE_WINDOW_MS,
      kb1Home,
      daemonHome: join(kb1Home, 'daemon'),
      vaultsHome: join(kb1Home, 'vaults'),
      vaultRoot: join(kb1Home, 'vaults', 'demo-vault'),
      statusFile: join(kb1Home, 'daemon', 'status.json'),
      startedAt: now.toISOString(),
      pid: 1234,
      deprecationWarnings: []
    });
  });

  it('defaults to localhost and the scaffold port', () => {
    const config = createDaemonConfig({ env: {}, homeDir: join(tempRoot, 'kb1-home') });

    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.actorDefault).toBe('user');
    expect(config.historyCoalesceWindowMs).toBe(DEFAULT_HISTORY_COALESCE_WINDOW_MS);
  });

  it('rejects invalid ports', () => {
    expect(() => resolvePort({ KB1_PORT: 'abc' })).toThrow(/KB1_PORT/);
    expect(resolvePort({ KB2_PORT: '0' })).toBe(DEFAULT_PORT);
  });

  it('uses KB1_WEB_PROXY_TARGET when supplied', () => {
    expect(resolveWebProxyTarget({ KB1_WEB_PROXY_TARGET: ' http://127.0.0.1:5173 ' })).toBe('http://127.0.0.1:5173');
    expect(resolveWebProxyTarget({ KB1_WEB_PROXY_TARGET: ' ' })).toBeUndefined();
  });

  it('ignores KB2 values when resolving current env config', () => {
    expect(resolvePort({ KB1_PORT: '8399', KB2_PORT: '9999' })).toBe(8399);
    expect(resolvePort({ KB2_PORT: '9999' })).toBe(DEFAULT_PORT);
    expect(resolveWebProxyTarget({
      KB1_WEB_PROXY_TARGET: 'http://127.0.0.1:5173',
      KB2_WEB_PROXY_TARGET: 'http://127.0.0.1:9999'
    })).toBe('http://127.0.0.1:5173');
    expect(resolveWebProxyTarget({ KB2_WEB_PROXY_TARGET: 'http://127.0.0.1:9999' })).toBeUndefined();
  });

  it('keeps relay integration disabled by default', () => {
    expect(resolveRelayConfig({})).toBeUndefined();
    expect(createDaemonConfig({ env: {}, homeDir: join(tempRoot, 'kb1-home') }).relay).toBeUndefined();
  });

  it('requires relay URL and token together', () => {
    expect(() => resolveRelayConfig({ KB1_RELAY_URL: 'http://127.0.0.1:9920/t/dev1' })).toThrow(/KB1_RELAY_URL/);
    expect(resolveRelayConfig({ KB2_RELAY_TOKEN: 'test-token' })).toBeUndefined();
  });

  it('normalizes relay URL when supplied', () => {
    expect(resolveRelayConfig({
      KB1_RELAY_URL: ' http://127.0.0.1:9920/t/dev1 ',
      KB1_RELAY_TOKEN: ' test-token ',
      KB1_DAEMON_VERSION: ' 0.1.0 ',
      KB1_DAEMON_BUILD: ' registry.fly.io/kb1@sha256:abc123 '
    })).toEqual({
      relayUrl: 'http://127.0.0.1:9920/t/dev1',
      token: 'test-token',
      daemonVersion: '0.1.0',
      daemonBuild: 'registry.fly.io/kb1@sha256:abc123'
    });
  });

  it('resolves the REST actor default mode', () => {
    expect(resolveActorDefault({})).toBe('user');
    expect(resolveActorDefault({ KB1_ACTOR_DEFAULT: ' unknown ' })).toBe('unknown');
    expect(resolveActorDefault({ KB2_ACTOR_DEFAULT: 'unknown' })).toBe('user');
    expect(() => resolveActorDefault({ KB1_ACTOR_DEFAULT: 'system' })).toThrow(/KB1_ACTOR_DEFAULT/);
  });

  it('resolves the history coalescing window', () => {
    expect(resolveHistoryCoalesceWindowMs({})).toBe(DEFAULT_HISTORY_COALESCE_WINDOW_MS);
    expect(resolveHistoryCoalesceWindowMs({ KB1_HISTORY_COALESCE_WINDOW_MS: ' 0 ' })).toBe(0);
    expect(resolveHistoryCoalesceWindowMs({ KB2_HISTORY_COALESCE_WINDOW_MS: '120000' })).toBe(DEFAULT_HISTORY_COALESCE_WINDOW_MS);
    expect(() => resolveHistoryCoalesceWindowMs({ KB1_HISTORY_COALESCE_WINDOW_MS: '-1' })).toThrow(/KB1_HISTORY_COALESCE_WINDOW_MS/);
    expect(resolveHistoryCoalesceWindowMs({ KB2_HISTORY_COALESCE_WINDOW_MS: 'five' })).toBe(DEFAULT_HISTORY_COALESCE_WINDOW_MS);
  });

  it('does not report KB2 deprecation warnings because KB2 env is not honored', () => {
    expect(collectConfigDeprecationWarnings({
      KB2_PORT: '7382',
      KB2_RELAY_URL: 'http://127.0.0.1:9920/t/dev1',
      KB2_RELAY_TOKEN: 'test-token'
    }, tempRoot)).toEqual([]);
  });
});
