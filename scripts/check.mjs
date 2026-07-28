#!/usr/bin/env node
import { spawnPnpm } from './process-runner.mjs';

const skipNxCache = process.argv.includes('--skip-nx-cache');
const env = {
  ...process.env,
  ...(skipNxCache ? { NX_SKIP_NX_CACHE: 'true' } : {})
};

for (const script of ['typecheck', 'test', 'build', 'licenses:check']) {
  const code = await run([script], env);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawnPnpm(args, {
      env,
      stdio: 'inherit'
    });
    child.once('error', () => resolve(1));
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(signal === 'SIGINT' ? 130 : 1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
