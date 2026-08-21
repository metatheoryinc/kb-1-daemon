import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { spawnPnpm, terminateProcessTree } from './process-runner.mjs';

test('spawnPnpm uses one validated shell command on Windows', () => {
  const calls = [];
  const child = {};
  const result = spawnPnpm(
    ['--filter', '@kb-1/daemon', 'dev'],
    { env: { TEST: 'true' }, shell: false, stdio: 'inherit' },
    {
      platform: 'win32',
      spawnImpl(...args) {
        calls.push(args);
        return child;
      }
    }
  );

  assert.equal(result, child);
  assert.deepEqual(calls, [[
    'pnpm --filter @kb-1/daemon dev',
    { env: { TEST: 'true' }, shell: true, stdio: 'inherit' }
  ]]);
});

test('spawnPnpm accepts the full Nx check arguments on Windows', () => {
  const calls = [];
  spawnPnpm(
    ['exec', 'nx', 'run-many', '-t', 'typecheck', 'test', 'build', '--parallel=3', '--exclude=web'],
    { stdio: 'inherit' },
    {
      platform: 'win32',
      spawnImpl(...args) {
        calls.push(args);
        return {};
      }
    }
  );

  assert.deepEqual(calls, [[
    'pnpm exec nx run-many -t typecheck test build --parallel=3 --exclude=web',
    { shell: true, stdio: 'inherit' }
  ]]);
});

test('spawnPnpm rejects shell metacharacters on Windows', () => {
  let spawned = false;
  assert.throws(
    () => spawnPnpm(
      ['dev', '&&', 'malicious'],
      {},
      {
        platform: 'win32',
        spawnImpl() {
          spawned = true;
        }
      }
    ),
    /Unsafe Windows pnpm argument/
  );
  assert.equal(spawned, false);
});

test('spawnPnpm keeps direct argument spawning on non-Windows platforms', () => {
  const calls = [];
  const options = { shell: false, stdio: 'inherit' };
  spawnPnpm(
    ['check'],
    options,
    {
      platform: 'darwin',
      spawnImpl(...args) {
        calls.push(args);
        return {};
      }
    }
  );

  assert.deepEqual(calls, [['pnpm', ['check'], options]]);
});

test('terminateProcessTree runs taskkill against the full Windows process tree', async () => {
  const calls = [];
  const child = runningChild(4123);

  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl(...args) {
      calls.push(args);
      const taskkill = new EventEmitter();
      queueMicrotask(() => taskkill.emit('exit', 0, null));
      return taskkill;
    }
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [[
    'taskkill.exe',
    ['/PID', '4123', '/T', '/F'],
    { stdio: 'ignore', windowsHide: true }
  ]]);
  assert.deepEqual(child.killSignals, []);
});

test('terminateProcessTree falls back to the child when taskkill fails', async () => {
  const child = runningChild(4123);

  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl() {
      const taskkill = new EventEmitter();
      queueMicrotask(() => taskkill.emit('error', new Error('taskkill unavailable')));
      return taskkill;
    }
  });

  assert.equal(result, true);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('terminateProcessTree uses the requested signal outside Windows', async () => {
  const child = runningChild(4123);

  const result = await terminateProcessTree(child, {
    platform: 'linux',
    signal: 'SIGINT'
  });

  assert.equal(result, true);
  assert.deepEqual(child.killSignals, ['SIGINT']);
});

test('terminateProcessTree ignores children that already exited', async () => {
  const child = runningChild(4123);
  child.exitCode = 0;

  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl() {
      throw new Error('must not spawn');
    }
  });

  assert.equal(result, false);
  assert.deepEqual(child.killSignals, []);
});

function runningChild(pid) {
  const killSignals = [];
  return {
    pid,
    exitCode: null,
    signalCode: null,
    killSignals,
    kill(signal) {
      killSignals.push(signal);
      return true;
    }
  };
}
