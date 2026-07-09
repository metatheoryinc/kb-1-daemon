import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectTemplateFiles, seedVaultFromStarterKit } from './starter-kit.js';

describe('seedVaultFromStarterKit', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'kb1-starter-kit-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('copies the whole bundled kit into an empty vault, recursively', async () => {
    const seeded = await seedVaultFromStarterKit(vaultRoot);

    // Dual assertion: the return value AND the bytes on disk.
    expect(seeded).toBe(true);
    await expect(readFile(join(vaultRoot, 'README.md'), 'utf8')).resolves.toContain('Welcome to your vault');
    await expect(readFile(join(vaultRoot, 'notes', 'getting-started.md'), 'utf8')).resolves.toContain('Getting started');
  });

  it('is a no-op on a vault that already holds user content', async () => {
    await writeFile(join(vaultRoot, 'mine.md'), 'my note\n', 'utf8');

    const seeded = await seedVaultFromStarterKit(vaultRoot);

    expect(seeded).toBe(false);
    // The user's file is untouched and the kit was not copied over it.
    await expect(readFile(join(vaultRoot, 'mine.md'), 'utf8')).resolves.toBe('my note\n');
    await expect(access(join(vaultRoot, 'README.md'))).rejects.toBeTruthy();
  });

  it('still seeds when only the .kb1 identity dir is present (it is not user content)', async () => {
    await mkdir(join(vaultRoot, '.kb1'), { recursive: true });
    await writeFile(join(vaultRoot, '.kb1', 'vault.json'), '{}\n', 'utf8');

    const seeded = await seedVaultFromStarterKit(vaultRoot);

    expect(seeded).toBe(true);
    await expect(readFile(join(vaultRoot, 'README.md'), 'utf8')).resolves.toContain('Welcome to your vault');
  });

  it('seeds a vault whose root does not exist yet', async () => {
    const fresh = join(vaultRoot, 'nested', 'new-vault');

    const seeded = await seedVaultFromStarterKit(fresh);

    expect(seeded).toBe(true);
    await expect(readFile(join(fresh, 'README.md'), 'utf8')).resolves.toContain('Welcome to your vault');
  });

  it('fails loudly with an actionable message when the bundled template is missing', async () => {
    // This is the safety net for a build that forgot to bundle the template
    // into dist: a clear error, not a bare ENOENT.
    await expect(collectTemplateFiles(join(vaultRoot, 'no-such-template'))).rejects.toThrow(
      /Starter-kit template not found/
    );
  });

  it('surfaces a seeding write failure rather than swallowing it', async () => {
    // A read-only vault root makes the first template write fail.
    await chmod(vaultRoot, 0o500);
    try {
      // Whether the write path returns a failure result or throws raw, seeding
      // must surface it, never silently leave a half-seeded vault.
      await expect(seedVaultFromStarterKit(vaultRoot)).rejects.toThrow();
    } finally {
      await chmod(vaultRoot, 0o700);
    }
  });

  it('rethrows an unexpected error while checking for existing content', async () => {
    // A path that is a file, not a directory, makes the content check fail with
    // ENOTDIR (not ENOENT), which must propagate rather than read as "empty".
    const notADir = join(vaultRoot, 'a-file');
    await writeFile(notADir, 'x', 'utf8');

    await expect(seedVaultFromStarterKit(notADir)).rejects.toBeTruthy();
  });
});
