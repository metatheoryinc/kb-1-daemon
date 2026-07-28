import { spawn } from 'node:child_process';

const SAFE_WINDOWS_ARGUMENT = /^[A-Za-z0-9@._/:=-]+$/;

/**
 * Spawn the repository's pinned pnpm command.
 *
 * Windows needs a shell to resolve pnpm.cmd, but Node deprecates combining
 * `shell: true` with a separate argument array because the shell receives an
 * unescaped, concatenated command. Build one strictly validated command string
 * instead. Repository callers intentionally pass only hardcoded tokens.
 */
export function spawnPnpm(
  args,
  options = {},
  { platform = process.platform, spawnImpl = spawn } = {}
) {
  if (platform !== 'win32') {
    return spawnImpl('pnpm', args, options);
  }

  for (const arg of args) {
    if (typeof arg !== 'string' || !SAFE_WINDOWS_ARGUMENT.test(arg)) {
      throw new Error(`Unsafe Windows pnpm argument: ${JSON.stringify(arg)}`);
    }
  }

  const { shell: _ignoredShell, ...spawnOptions } = options;
  return spawnImpl(['pnpm', ...args].join(' '), {
    ...spawnOptions,
    shell: true
  });
}

/**
 * Stop a spawned command and its descendants.
 *
 * On Windows, killing the shell process alone leaves pnpm/Nx/Vite descendants
 * running. taskkill's `/T` flag terminates the complete process tree.
 */
export async function terminateProcessTree(
  child,
  {
    signal = 'SIGTERM',
    platform = process.platform,
    spawnImpl = spawn
  } = {}
) {
  if (!isRunning(child)) {
    return false;
  }

  if (platform !== 'win32') {
    return child.kill(signal);
  }

  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const treeKilled = await runTaskkill(pid, spawnImpl);
  if (treeKilled || !isRunning(child)) {
    return treeKilled;
  }

  return child.kill('SIGTERM');
}

function isRunning(child) {
  return child
    && child.exitCode == null
    && child.signalCode == null;
}

function runTaskkill(pid, spawnImpl) {
  return new Promise((resolve) => {
    let taskkill;
    try {
      taskkill = spawnImpl(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true }
      );
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      resolve(succeeded);
    };

    taskkill.once('error', () => finish(false));
    taskkill.once('exit', (code) => finish(code === 0));
  });
}
