#!/usr/bin/env node

import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
// Node >=20.12 (CVE-2024-27980) refuses to spawn a .cmd/.bat without a shell,
// so the Windows launcher needs one. Every argument below is a hardcoded
// literal, so the DEP0190 arg-escaping hazard does not apply here.
const useShell = process.platform === 'win32';
const daemonHost = process.env.KB1_HOST || '127.0.0.1';
const daemonPort = process.env.KB1_PORT || '7382';
const webPort = process.env.KB1_WEB_PORT || '5173';
const webProxyTarget = process.env.KB1_WEB_PROXY_TARGET || `http://127.0.0.1:${webPort}`;

const children = [
  spawnProcess('web', ['--filter', '@kb-1/web', 'dev'], {
    KB1_WEB_PORT: webPort
  }),
  spawnProcess('daemon', ['--filter', '@kb-1/daemon', 'dev'], {
    KB1_HOST: daemonHost,
    KB1_PORT: daemonPort,
    KB1_WEB_PROXY_TARGET: webProxyTarget
  })
];

console.log(`KB-1 dev front door: http://${daemonHost}:${daemonPort}`);
console.log(`Vite dev server: ${webProxyTarget}`);

let shuttingDown = false;

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const other of children) {
      if (other !== child) {
        other.kill('SIGTERM');
      }
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const child of children) {
      child.kill(signal);
    }
  });
}

function spawnProcess(name, args, env) {
  const child = spawn(pnpm, args, {
    env: {
      ...process.env,
      ...env
    },
    shell: useShell,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  streamLines(name, child.stdout);
  streamLines(name, child.stderr);

  return child;
}

function streamLines(name, stream) {
  let buffered = '';

  stream.setEncoding('utf8');
  stream.on('data', (value) => {
    buffered += String(value);
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      console.log(`[${name}] ${line}`);
    }
  });

  stream.on('end', () => {
    if (buffered) {
      console.log(`[${name}] ${buffered}`);
    }
  });
}
