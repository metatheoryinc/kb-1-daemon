#!/usr/bin/env node
import { spawn } from 'node:child_process';

const skipNxCache = process.argv.includes('--skip-nx-cache');
const env = {
  ...process.env,
  ...(skipNxCache ? { NX_SKIP_NX_CACHE: 'true' } : {})
};

for (const script of ['typecheck', 'test', 'build', 'licenses:check']) {
  const code = await run('pnpm', [script], env);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit'
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(signal === 'SIGINT' ? 130 : 1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
