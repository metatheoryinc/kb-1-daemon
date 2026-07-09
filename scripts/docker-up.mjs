import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

const env = { ...process.env };
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
