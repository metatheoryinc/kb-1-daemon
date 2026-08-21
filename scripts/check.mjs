#!/usr/bin/env node
import { spawnPnpm } from './process-runner.mjs';

const skipNxCache = process.argv.includes('--skip-nx-cache');
const env = {
  ...process.env,
  ...(skipNxCache ? { NX_SKIP_NX_CACHE: 'true' } : {})
};

// Nx owns dependency ordering for the non-web workspace. Web targets stay
// serial because SvelteKit's sync, test, and build paths share `.svelte-kit`.
// Repository-level checks remain independent of that workspace lane.
const results = await Promise.all([
  runWorkspaceChecks(),
  run(['test:scripts'], env),
  run(['licenses:check'], env)
]);
const failure = results.find((code) => code !== 0);
if (failure !== undefined) process.exitCode = failure;

async function runWorkspaceChecks() {
  const nonWebCode = await run(
    ['exec', 'nx', 'run-many', '-t', 'typecheck', 'test', 'build', '--parallel=3', '--exclude=web'],
    env
  );
  if (nonWebCode !== 0) return nonWebCode;

  for (const target of ['typecheck', 'test', 'build']) {
    const webCode = await run(['exec', 'nx', 'run', `web:${target}`], env);
    if (webCode !== 0) return webCode;
  }
  return 0;
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
