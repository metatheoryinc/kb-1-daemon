import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function directoryHasEntries(path) {
  try {
    return existsSync(path) && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

const env = { ...process.env };
const newHostHome = resolve(repoRoot, '.kb1-docker');
const legacyHostHome = resolve(repoRoot, '.kb2-docker');

if (!env.KB1_DOCKER_HOST_HOME && !directoryHasEntries(newHostHome) && directoryHasEntries(legacyHostHome)) {
  env.KB1_DOCKER_HOST_HOME = './.kb2-docker';
  env.KB1_DOCKER_CONTAINER_HOME = env.KB1_DOCKER_CONTAINER_HOME ?? '/data/kb2';
  console.warn('Using existing legacy .kb2-docker data directory. Set KB1_DOCKER_HOST_HOME to override.');
}

env.KB1_DOCKER_HOST_HOME = env.KB1_DOCKER_HOST_HOME ?? './.kb1-docker';
env.KB1_DOCKER_CONTAINER_HOME = env.KB1_DOCKER_CONTAINER_HOME ?? '/data/kb1';

if (process.argv.includes('--print-config')) {
  console.log(`KB1_DOCKER_HOST_HOME=${env.KB1_DOCKER_HOST_HOME}`);
  console.log(`KB1_DOCKER_CONTAINER_HOME=${env.KB1_DOCKER_CONTAINER_HOME}`);
  console.log('command=docker compose up --build -d daemon');
  process.exit(0);
}

const result = spawnSync('docker', ['compose', 'up', '--build', '-d', 'daemon'], {
  cwd: repoRoot,
  env,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
