#!/usr/bin/env node
import { spawn } from 'node:child_process';

// Windows resolves `pnpm` to pnpm.cmd only through a shell; a bare spawn
// misses PATHEXT and fails with ENOENT. Every argument below is a hardcoded
// literal, so the DEP0190 arg-escaping hazard does not apply here.
const useShell = process.platform === 'win32';
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
      shell: useShell,
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
