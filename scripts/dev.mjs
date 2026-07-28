#!/usr/bin/env node

import { spawnPnpm, terminateProcessTree } from './process-runner.mjs';

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

    void shutdownChildren({
      skip: child,
      signal: signal ?? 'SIGTERM',
      exitCode: signal ? exitCodeForSignal(signal) : code ?? 1
    });
  });
  child.once('error', (error) => {
    console.error(error);
    if (!shuttingDown) {
      void shutdownChildren({ skip: child, exitCode: 1 });
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    void shutdownChildren({
      signal,
      exitCode: exitCodeForSignal(signal)
    });
  });
}

function spawnProcess(name, args, env) {
  const child = spawnPnpm(args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: ['inherit', 'pipe', 'pipe']
  });

  streamLines(name, child.stdout);
  streamLines(name, child.stderr);

  return child;
}

async function shutdownChildren({ skip, signal = 'SIGTERM', exitCode = 1 }) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  try {
    await Promise.all(
      children
        .filter((child) => child !== skip)
        .map((child) => terminateProcessTree(child, { signal }))
    );
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

function exitCodeForSignal(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
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
