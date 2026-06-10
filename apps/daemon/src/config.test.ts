import { join, resolve } from 'node:path';

import { DEFAULT_HOST, DEFAULT_PORT, createDaemonConfig, resolveKb2Home, resolvePort } from './config.js';

describe('daemon config', () => {
  it('defaults KB2_HOME to a user-level .kb2 directory', () => {
    const homeDir = resolve('/tmp/kb2-home-test');

    expect(resolveKb2Home({}, homeDir)).toBe(join(homeDir, '.kb2'));
  });

  it('uses KB2_HOME when supplied', () => {
    const kb2Home = resolve('/tmp/kb2-configured-home');

    expect(resolveKb2Home({ KB2_HOME: kb2Home }, '/ignored')).toBe(kb2Home);
  });

  it('expands a home-relative KB2_HOME override', () => {
    const homeDir = resolve('/tmp/kb2-user-home');

    expect(resolveKb2Home({ KB2_HOME: '~/workspace' }, homeDir)).toBe(join(homeDir, 'workspace'));
  });

  it('resolves host, port, daemon directory, and status path', () => {
    const now = new Date('2026-06-10T15:00:00.000Z');
    const kb2Home = resolve('/tmp/kb2-daemon-home');
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home,
        KB2_HOST: '0.0.0.0',
        KB2_PORT: '8399'
      },
      now,
      pid: 1234
    });

    expect(config).toEqual({
      serviceName: 'kb2d',
      host: '0.0.0.0',
      port: 8399,
      kb2Home,
      daemonHome: join(kb2Home, 'daemon'),
      statusFile: join(kb2Home, 'daemon', 'status.json'),
      startedAt: now.toISOString(),
      pid: 1234
    });
  });

  it('defaults to localhost and the scaffold port', () => {
    const config = createDaemonConfig({ env: {}, homeDir: resolve('/tmp/kb2-home') });

    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('rejects invalid ports', () => {
    expect(() => resolvePort({ KB2_PORT: 'abc' })).toThrow(/KB2_PORT/);
    expect(() => resolvePort({ KB2_PORT: '0' })).toThrow(/KB2_PORT/);
  });
});
