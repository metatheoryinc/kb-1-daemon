import { access, chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireMigrationLock,
  copyModeWithoutSpecialBits,
  createMigrationStagingDirectory,
  MIGRATION_COMPLETION_FILENAME,
  MIGRATION_LOCK_PREFIX,
  MIGRATION_STAGING_DIRECTORY_PREFIX,
  migrateDirectoryCopyVerifyPreserve,
  portableMigrationDigestPath,
  publishMigrationFileByExclusiveCopy,
  publishMigrationPath,
  verifyCopy
} from './migrations.js';

describe('directory migration safety', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb1-directory-migration-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('copies content and empty directories while retaining the legacy source in place', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(join(source, 'empty'), { recursive: true });
    await mkdir(join(source, 'notes'), { recursive: true });
    await writeFile(join(source, 'notes', 'hello.md'), '# Hello\n', 'utf8');

    const result = await migrateDirectoryCopyVerifyPreserve({ source, target });

    expect(result.migrated).toBe(true);
    await expect(readFile(join(source, 'notes', 'hello.md'), 'utf8')).resolves.toBe('# Hello\n');
    await expect(readFile(join(target, MIGRATION_COMPLETION_FILENAME), 'utf8')).resolves.toContain(
      'sha256-tree'
    );
    await expect(access(join(target, 'empty'))).resolves.toBeUndefined();
    await expect(readFile(join(target, 'notes', 'hello.md'), 'utf8')).resolves.toBe('# Hello\n');
  });

  it('populates a pre-created empty target such as a Docker volume mount', async () => {
    const source = join(root, 'kb2');
    const target = join(root, 'kb1');
    await mkdir(join(source, 'notes'), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'notes', 'mounted.md'), 'mounted legacy data\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: false
    });
    await expect(readFile(join(target, 'notes', 'mounted.md'), 'utf8')).resolves.toBe(
      'mounted legacy data\n'
    );
    await expect(readFile(join(target, MIGRATION_COMPLETION_FILENAME), 'utf8')).resolves.toContain(
      'sha256-tree'
    );
    await expect(readFile(join(source, 'notes', 'mounted.md'), 'utf8')).resolves.toBe(
      'mounted legacy data\n'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'preserves restrictive source modes when filling a pre-created target',
    async () => {
      const source = join(root, 'kb2');
      const target = join(root, 'kb1');
      const sourcePrivate = join(source, 'private');
      const targetPrivate = join(target, 'private');
      await mkdir(source, { mode: 0o700 });
      await mkdir(target, { mode: 0o500 });
      await chmod(target, 0o500);
      await mkdir(sourcePrivate, { mode: 0o700 });
      await writeFile(join(sourcePrivate, 'secret.txt'), 'private legacy data\n', 'utf8');
      await chmod(join(sourcePrivate, 'secret.txt'), 0o400);
      await chmod(sourcePrivate, 0o500);
      await chmod(source, 0o500);

      await migrateDirectoryCopyVerifyPreserve({ source, target });

      expect((await stat(target)).mode & 0o7777).toBe(0o500);
      expect((await stat(targetPrivate)).mode & 0o7777).toBe(0o500);
      expect((await stat(join(targetPrivate, 'secret.txt'))).mode & 0o7777).toBe(0o400);
      await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).resolves.toBeUndefined();
      await expect(readFile(join(sourcePrivate, 'secret.txt'), 'utf8')).resolves.toBe(
        'private legacy data\n'
      );
      await chmod(source, 0o700);
      await chmod(target, 0o700);
      await chmod(sourcePrivate, 0o700);
      await chmod(targetPrivate, 0o700);
    }
  );

  it('strips privileged mode bits while preserving ordinary source access bits', () => {
    expect(copyModeWithoutSpecialBits(0o4755)).toBe(0o755);
    expect(copyModeWithoutSpecialBits(0o2750)).toBe(0o750);
    expect(copyModeWithoutSpecialBits(0o1755)).toBe(0o755);
  });

  it('builds portable digest paths from components without platform-native separators', () => {
    expect(portableMigrationDigestPath([])).toBe('.');
    expect(portableMigrationDigestPath(['notes', 'nested', 'entry.md'])).toBe(
      'notes/nested/entry.md'
    );
    expect(portableMigrationDigestPath(['literal\\backslash.md'])).toBe(
      'literal\\backslash.md'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'publishes POSIX files without replacing an existing destination',
    async () => {
      const source = join(root, 'temporary-marker');
      const target = join(root, 'raced-marker');
      await writeFile(source, 'migration marker\n', 'utf8');
      await writeFile(target, 'target-side marker\n', 'utf8');

      await expect(publishMigrationPath(source, target)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(readFile(source, 'utf8')).resolves.toBe('migration marker\n');
      await expect(readFile(target, 'utf8')).resolves.toBe('target-side marker\n');

      const replacementReceipt = await publishMigrationPath(source, target, true);
      const replacementInfo = await stat(target, { bigint: true });
      expect(replacementReceipt.dev).toBe(replacementInfo.dev);
      expect(replacementReceipt.ino).toBe(replacementInfo.ino);
      await expect(access(source)).rejects.toBeTruthy();
      await expect(readFile(target, 'utf8')).resolves.toBe('migration marker\n');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rolls back a visible publication when a commit-point observer rejects',
    async () => {
      const source = join(root, 'post-publication-source');
      const target = join(root, 'post-publication-target');
      await writeFile(source, 'must remain recoverable\n', 'utf8');
      let observedOwnership: import('node:fs').BigIntStats | undefined;

      await expect(
        publishMigrationPath(source, target, false, (ownership) => {
          observedOwnership = ownership;
          throw new Error('simulated post-publication rejection');
        })
      ).rejects.toThrow(/simulated post-publication rejection/);

      expect(observedOwnership?.isFile()).toBe(true);
      await expect(access(target)).rejects.toBeTruthy();
      await expect(readFile(source, 'utf8')).resolves.toBe('must remain recoverable\n');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'retains a committed replacement when a post-publication observer rejects',
    async () => {
      const source = join(root, 'replacement-proof');
      const target = join(root, 'existing-proof');
      await writeFile(source, 'new authenticated proof\n', 'utf8');
      await writeFile(target, 'old authenticated proof\n', 'utf8');

      await expect(
        publishMigrationPath(source, target, true, () => {
          throw new Error('simulated post-replacement rejection');
        })
      ).rejects.toThrow(/simulated post-replacement rejection/);

      await expect(access(source)).rejects.toBeTruthy();
      await expect(readFile(target, 'utf8')).resolves.toBe('new authenticated proof\n');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'falls back to exclusive verified copy without requiring hard-link support',
    async () => {
      const source = join(root, 'hardlink-fallback-source');
      const target = join(root, 'hardlink-fallback-target');
      await writeFile(source, 'verified fallback content\n', 'utf8');
      await chmod(source, 0o660);
      const previousUmask = process.umask(0o077);

      const sourceOwnership = await stat(source, { bigint: true });
      let observedTargetOwnership: import('node:fs').BigIntStats | undefined;
      let publicationReceipt: import('node:fs').BigIntStats;
      try {
        publicationReceipt = await publishMigrationFileByExclusiveCopy(
          source,
          target,
          undefined,
          (ownership) => {
            observedTargetOwnership = ownership;
          }
        );
      } finally {
        process.umask(previousUmask);
      }
      const targetOwnership = await stat(target, { bigint: true });
      expect(publicationReceipt.dev).toBe(targetOwnership.dev);
      expect(publicationReceipt.ino).toBe(targetOwnership.ino);
      expect(observedTargetOwnership?.ino).toBe(targetOwnership.ino);
      expect(publicationReceipt.ino).not.toBe(sourceOwnership.ino);
      await expect(access(source)).rejects.toBeTruthy();
      await expect(readFile(target, 'utf8')).resolves.toBe('verified fallback content\n');
      expect((await stat(target)).mode & 0o777).toBe(0o660);

      const secondSource = join(root, 'hardlink-fallback-second-source');
      await writeFile(secondSource, 'must remain\n', 'utf8');
      await expect(
        publishMigrationFileByExclusiveCopy(secondSource, target)
      ).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(readFile(secondSource, 'utf8')).resolves.toBe('must remain\n');
      await expect(readFile(target, 'utf8')).resolves.toBe('verified fallback content\n');
    }
  );

  it('rejects a symlinked publication parent before creating an out-of-tree file', async () => {
    const source = join(root, 'temporary-file');
    const external = join(root, 'external');
    const alias = join(root, 'target-alias');
    await writeFile(source, 'must remain\n', 'utf8');
    await mkdir(external);
    await symlink(external, alias);

    await expect(publishMigrationPath(source, join(alias, 'escaped.txt'))).rejects.toThrow(
      /publication parent .* is not a regular directory/
    );
    await expect(readFile(source, 'utf8')).resolves.toBe('must remain\n');
    await expect(access(join(external, 'escaped.txt'))).rejects.toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed before copying into an existing directory with broader permissions',
    async () => {
      const source = join(root, 'kb2');
      const target = join(root, 'kb1');
      const sourcePrivate = join(source, 'private');
      const targetPrivate = join(target, 'private');
      await mkdir(source, { mode: 0o700 });
      await chmod(source, 0o700);
      await mkdir(target, { mode: 0o700 });
      await chmod(target, 0o700);
      await mkdir(sourcePrivate, { mode: 0o700 });
      await chmod(sourcePrivate, 0o700);
      await mkdir(targetPrivate, { mode: 0o755 });
      await chmod(targetPrivate, 0o755);
      await writeFile(join(sourcePrivate, 'secret.txt'), 'private legacy data\n', 'utf8');

      await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
        /private directory permissions are broader than the source \(source 0700, copy 0755\)/
      );
      await expect(access(join(targetPrivate, 'secret.txt'))).rejects.toBeTruthy();
      await expect(readFile(join(sourcePrivate, 'secret.txt'), 'utf8')).resolves.toBe(
        'private legacy data\n'
      );
      await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).rejects.toBeTruthy();
    }
  );

  it('finishes an interrupted migration only when existing files match byte-for-byte', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.json'), '{"ok":true}\n', 'utf8');
    await writeFile(join(target, 'state.json'), '{"ok":true}\n', 'utf8');
    await writeFile(join(target, 'new-state.json'), '{"new":true}\n', 'utf8');

    const result = await migrateDirectoryCopyVerifyPreserve({ source, target });

    expect(result.migrated).toBe(false);
    await expect(readFile(join(source, 'state.json'), 'utf8')).resolves.toBe('{"ok":true}\n');
    await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).resolves.toBeUndefined();
    await expect(readFile(join(target, 'new-state.json'), 'utf8')).resolves.toBe('{"new":true}\n');
  });

  it('uses path-bound completion state while retained source and active target evolve', async () => {
    const source = join(root, 'kb2');
    const target = join(root, 'kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: true
    });
    await writeFile(join(source, 'state.txt'), 'retained source changed after migration\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'active target changed after migration\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: false
    });
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe(
      'retained source changed after migration\n'
    );
    await expect(readFile(join(target, 'state.txt'), 'utf8')).resolves.toBe(
      'active target changed after migration\n'
    );
  });

  it('rejects a completion marker replayed beside a different legacy source snapshot', async () => {
    const firstHome = join(root, 'first-home');
    const secondHome = join(root, 'second-home');
    const firstSource = join(firstHome, '.kb2');
    const firstTarget = join(firstHome, '.kb1');
    const secondSource = join(secondHome, '.kb2');
    const secondTarget = join(secondHome, '.kb1');
    await mkdir(firstSource, { recursive: true });
    await mkdir(secondSource, { recursive: true });
    await writeFile(join(firstSource, 'state.txt'), 'first legacy snapshot\n', 'utf8');
    await writeFile(join(secondSource, 'state.txt'), 'second legacy snapshot\n', 'utf8');

    await migrateDirectoryCopyVerifyPreserve({ source: firstSource, target: firstTarget });
    await cp(firstTarget, secondTarget, { recursive: true });

    await expect(
      migrateDirectoryCopyVerifyPreserve({ source: secondSource, target: secondTarget })
    ).rejects.toThrow(/cannot be safely rebound/);
    await expect(readFile(join(secondSource, 'state.txt'), 'utf8')).resolves.toBe(
      'second legacy snapshot\n'
    );
    await expect(readFile(join(secondTarget, 'state.txt'), 'utf8')).resolves.toBe(
      'first legacy snapshot\n'
    );
  });

  it('safely rebinds a complete relocated home without reconciling its active target', async () => {
    const originalHome = join(root, 'original-home');
    const restoredHome = join(root, 'restored-home');
    const originalSource = join(originalHome, '.kb2');
    const originalTarget = join(originalHome, '.kb1');
    await mkdir(originalSource, { recursive: true });
    await writeFile(join(originalSource, 'state.txt'), 'retained migration snapshot\n', 'utf8');
    await migrateDirectoryCopyVerifyPreserve({ source: originalSource, target: originalTarget });
    await writeFile(join(originalTarget, 'state.txt'), 'active target evolved\n', 'utf8');
    const markerBefore = JSON.parse(
      await readFile(join(originalTarget, MIGRATION_COMPLETION_FILENAME), 'utf8')
    ) as { pathPairFingerprint: string; migrationSourceDigest: string };

    await cp(originalHome, restoredHome, { recursive: true });
    const restoredSource = join(restoredHome, '.kb2');
    const restoredTarget = join(restoredHome, '.kb1');
    await expect(
      migrateDirectoryCopyVerifyPreserve({ source: restoredSource, target: restoredTarget })
    ).resolves.toEqual({ migrated: false });

    const markerAfter = JSON.parse(
      await readFile(join(restoredTarget, MIGRATION_COMPLETION_FILENAME), 'utf8')
    ) as { pathPairFingerprint: string; migrationSourceDigest: string };
    expect(markerAfter.pathPairFingerprint).not.toBe(markerBefore.pathPairFingerprint);
    expect(markerAfter.migrationSourceDigest).toBe(markerBefore.migrationSourceDigest);
    await expect(readFile(join(restoredSource, 'state.txt'), 'utf8')).resolves.toBe(
      'retained migration snapshot\n'
    );
    await expect(readFile(join(restoredTarget, 'state.txt'), 'utf8')).resolves.toBe(
      'active target evolved\n'
    );
  });

  it('rebinds a complete restore across the supported default and Docker home names', async () => {
    const originalRoot = join(root, 'default-layout');
    const restoredRoot = join(root, 'docker-layout');
    const originalSource = join(originalRoot, '.kb2');
    const originalTarget = join(originalRoot, '.kb1');
    const restoredSource = join(restoredRoot, 'kb2');
    const restoredTarget = join(restoredRoot, 'kb1');
    await mkdir(originalSource, { recursive: true });
    await writeFile(join(originalSource, 'state.txt'), 'retained migration snapshot\n', 'utf8');
    await migrateDirectoryCopyVerifyPreserve({ source: originalSource, target: originalTarget });
    await writeFile(join(originalTarget, 'state.txt'), 'active target evolved\n', 'utf8');

    await mkdir(restoredRoot, { recursive: true });
    await cp(originalSource, restoredSource, { recursive: true });
    await cp(originalTarget, restoredTarget, { recursive: true });

    await expect(
      migrateDirectoryCopyVerifyPreserve({ source: restoredSource, target: restoredTarget })
    ).resolves.toEqual({ migrated: false });
    const rebound = JSON.parse(
      await readFile(join(restoredTarget, MIGRATION_COMPLETION_FILENAME), 'utf8')
    ) as { sourceName: string; targetName: string };
    expect(rebound.sourceName).toBe('kb2');
    expect(rebound.targetName).toBe('kb1');
    await expect(readFile(join(restoredSource, 'state.txt'), 'utf8')).resolves.toBe(
      'retained migration snapshot\n'
    );
    await expect(readFile(join(restoredTarget, 'state.txt'), 'utf8')).resolves.toBe(
      'active target evolved\n'
    );
  });

  it('does not delete a move-manifest-looking file from the target parent', async () => {
    const source = join(root, 'absent-kb2');
    const target = join(root, 'kb1');
    const unrelated = join(
      root,
      '.kb1-migration-copy-moves-00000000-0000-4000-8000-000000000000.ndjson'
    );
    await writeFile(unrelated, 'ordinary parent file\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: false
    });
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('ordinary parent file\n');
  });

  it('preserves and rejects a move-manifest-looking file inside an existing target', async () => {
    const source = join(root, 'kb2');
    const target = join(root, 'kb1');
    const manifestName = '.kb1-migration-copy-moves-00000000-0000-4000-8000-000000000000.ndjson';
    const unverifiedManifest = join(target, manifestName);
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(unverifiedManifest, 'unowned target data\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /unverified Windows move manifest .*filename shape alone does not prove ownership.*remove it manually/
    );
    await expect(readFile(unverifiedManifest, 'utf8')).resolves.toBe('unowned target data\n');
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
  });

  it.skipIf(process.platform !== 'win32')(
    'publishes files, empty directories, and completion state through the real Windows path',
    async () => {
      const source = join(root, 'kb2');
      const target = join(root, 'kb1');
      await mkdir(join(source, 'empty'), { recursive: true });
      await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');

      await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
        migrated: true
      });
      await expect(readFile(join(target, MIGRATION_COMPLETION_FILENAME), 'utf8')).resolves.toContain(
        'sha256-tree'
      );
      await expect(access(join(target, 'empty'))).resolves.toBeUndefined();
      expect((await readdir(target)).some((name) => name.includes('.tmp-'))).toBe(false);
      await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    }
  );

  it('batches Windows moves through bounded JSON without command-line path interpolation', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const previousSystemRoot = process.env.SystemRoot;
    const previousCapture = process.env.KB1_TEST_MOVE_CAPTURE;
    const previousMutation = process.env.KB1_TEST_MUTATE_ON_MARKER;
    const previousTamperTarget = process.env.KB1_TEST_TAMPER_TARGET;
    try {
      const systemRoot = join(root, 'fake-windows');
      const powershell = join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const capture = join(root, 'move-capture.jsonl');
      await mkdir(join(powershell, '..'), { recursive: true });
      await writeFile(
        powershell,
        [
          '#!/usr/bin/env node',
          "const crypto = require('node:crypto');",
          "const fs = require('node:fs');",
          "const lines = fs.readFileSync(process.env.KB1_MOVE_MANIFEST, 'utf8').trim().split('\\n');",
          'const operations = lines.filter(Boolean).map((line) => JSON.parse(line));',
          'if (operations.length !== Number(process.env.KB1_MOVE_COUNT)) process.exit(41);',
          'if (process.env.KB1_TEST_TAMPER_TARGET && operations[0]) {',
          '  operations[0].target = process.env.KB1_TEST_TAMPER_TARGET;',
          '}',
          "const key = Buffer.from(process.env.KB1_MOVE_HMAC_KEY, 'base64');",
          'const operationMac = (operation) => {',
          "  const source = Buffer.from(operation.source, 'utf8');",
          "  const target = Buffer.from(operation.target, 'utf8');",
          '  const header = Buffer.allocUnsafe(13);',
          '  header.writeUInt32LE(operation.id, 0);',
          '  header.writeUInt32LE(source.length, 4);',
          '  header.writeUInt32LE(target.length, 8);',
          '  header.writeUInt8(operation.replaceExisting ? 1 : 0, 12);',
          "  return crypto.createHmac('sha256', key).update(header).update(source).update(target).digest('hex');",
          '};',
          'operations.forEach((operation, index) => {',
          '  if (operation.id !== index) process.exit(42);',
          '  if (operation.mac !== operationMac(operation)) {',
          "    console.error('Move manifest authentication failed');",
          '    process.exit(43);',
          '  }',
          '  fs.renameSync(operation.source, operation.target);',
          `  if (process.env.KB1_TEST_MUTATE_ON_MARKER && operation.target.endsWith('${MIGRATION_COMPLETION_FILENAME}')) {`,
          "    const path = require('node:path');",
          "    fs.writeFileSync(path.join(path.dirname(operation.target), 'state.txt'), 'target changed during completion\\n');",
          '  }',
          '});',
          "fs.appendFileSync(process.env.KB1_TEST_MOVE_CAPTURE, JSON.stringify(operations) + '\\n');"
        ].join('\n'),
        'utf8'
      );
      await chmod(powershell, 0o755);
      process.env.SystemRoot = systemRoot;
      process.env.KB1_TEST_MOVE_CAPTURE = capture;

      const source = join(root, 'kb2');
      const target = join(root, 'kb1');
      const nested = join(source, 'nested', 'deep');
      const quotedName = `quote-'-$()-\n.md`;
      await mkdir(join(source, 'empty'), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, quotedName), 'quoted path data\n', 'utf8');
      for (let index = 0; index < 20; index += 1) {
        await writeFile(join(nested, `note-${index}.md`), `note ${index}\n`, 'utf8');
      }

      await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
        migrated: true
      });
      await expect(readFile(join(target, 'nested', 'deep', quotedName), 'utf8')).resolves.toBe(
        'quoted path data\n'
      );

      const batches = (await readFile(capture, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Array<{ id: number; source: string; target: string }>);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(1);
      expect(batches[1]).toHaveLength(24);
      expect(batches[2]).toHaveLength(1);
      const directoryTargets = batches[1]!.slice(0, 3).map((operation) => operation.target);
      expect(directoryTargets).toEqual([
        join(target, 'empty'),
        join(target, 'nested'),
        join(target, 'nested', 'deep')
      ]);
      expect(batches[1]!.slice(3).some((operation) => operation.target.endsWith(quotedName))).toBe(true);
      expect(
        (await readdir(root)).some(
          (name) => name.startsWith(MIGRATION_STAGING_DIRECTORY_PREFIX)
            || name.startsWith('.kb1-migration-copy-')
        )
      ).toBe(false);

      const raceSource = join(root, 'race-kb2');
      const raceTarget = join(root, 'race-kb1');
      await mkdir(raceSource, { recursive: true });
      await writeFile(join(raceSource, 'state.txt'), 'legacy stable data\n', 'utf8');
      process.env.KB1_TEST_MUTATE_ON_MARKER = '1';

      await expect(
        migrateDirectoryCopyVerifyPreserve({ source: raceSource, target: raceTarget })
      ).rejects.toThrow(/target changed while completion was published/);
      await expect(readFile(join(raceSource, 'state.txt'), 'utf8')).resolves.toBe(
        'legacy stable data\n'
      );
      await expect(readFile(join(raceTarget, 'state.txt'), 'utf8')).resolves.toBe(
        'target changed during completion\n'
      );
      await expect(access(join(raceTarget, MIGRATION_COMPLETION_FILENAME))).rejects.toBeTruthy();

      delete process.env.KB1_TEST_MUTATE_ON_MARKER;
      const tamperSource = join(root, 'tamper-kb2');
      const tamperTarget = join(root, 'tamper-kb1');
      const redirectedTarget = join(root, 'redirected-by-tampered-manifest');
      await mkdir(tamperSource, { recursive: true });
      await writeFile(join(tamperSource, 'state.txt'), 'authenticated move data\n', 'utf8');
      process.env.KB1_TEST_TAMPER_TARGET = redirectedTarget;

      await expect(
        migrateDirectoryCopyVerifyPreserve({ source: tamperSource, target: tamperTarget })
      ).rejects.toThrow();
      await expect(access(redirectedTarget)).rejects.toBeTruthy();
      await expect(access(tamperTarget)).rejects.toBeTruthy();
      await expect(readFile(join(tamperSource, 'state.txt'), 'utf8')).resolves.toBe(
        'authenticated move data\n'
      );
    } finally {
      platform.mockRestore();
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousCapture === undefined) delete process.env.KB1_TEST_MOVE_CAPTURE;
      else process.env.KB1_TEST_MOVE_CAPTURE = previousCapture;
      if (previousMutation === undefined) delete process.env.KB1_TEST_MUTATE_ON_MARKER;
      else process.env.KB1_TEST_MUTATE_ON_MARKER = previousMutation;
      if (previousTamperTarget === undefined) delete process.env.KB1_TEST_TAMPER_TARGET;
      else process.env.KB1_TEST_TAMPER_TARGET = previousTamperTarget;
    }
  });

  it('fails closed on invalid completion state', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, MIGRATION_COMPLETION_FILENAME), '{"schemaVersion":1}\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /completion marker .* is invalid/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a completion marker writable by group or other principals',
    async () => {
      const source = join(root, '.kb2');
      const target = join(root, '.kb1');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
      await migrateDirectoryCopyVerifyPreserve({ source, target });
      const marker = join(target, MIGRATION_COMPLETION_FILENAME);
      await chmod(marker, 0o666);

      await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
        /completion marker .* untrusted owner or writable group\/other permissions/
      );
      await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    }
  );

  it('preserves an unverified temporary-marker lookalike and requires manual cleanup', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    const temporaryMarker = join(
      target,
      `${MIGRATION_COMPLETION_FILENAME}.tmp-00000000-0000-4000-8000-000000000000`
    );
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(temporaryMarker, '{"partial":', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /unverified temporary completion marker .*filename shape alone does not prove ownership.*remove it manually/
    );
    await expect(readFile(temporaryMarker, 'utf8')).resolves.toBe('{"partial":');
    await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).rejects.toBeTruthy();

    await rm(temporaryMarker);
    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: false
    });
    await expect(readFile(join(target, MIGRATION_COMPLETION_FILENAME), 'utf8')).resolves.toContain(
      'sha256-tree'
    );
  });

  it('rejects case-aliased completion state copied from the legacy source', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(
      join(source, '.KB1-MIGRATION-COMPLETE-V1.JSON'),
      '{"schemaVersion":1}\n',
      'utf8'
    );

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /reserved for migration control state/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(target)).rejects.toBeTruthy();
  });

  it('rejects the nested temporary-marker namespace before publishing any source entry', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'ordinary-first.txt'), 'legacy\n', 'utf8');
    await writeFile(
      join(source, 'nested', `${MIGRATION_COMPLETION_FILENAME}.tmp-backup`),
      'user-like collision\n',
      'utf8'
    );

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /nested.*\.tmp-backup is reserved for migration control state/
    );
    await expect(readFile(join(source, 'ordinary-first.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(target)).rejects.toBeTruthy();
  });

  it('removes only an empty pair-owned staging directory interrupted before its manifest exists', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    const abandonedStage = await createMigrationStagingDirectory(source, target);
    expect(abandonedStage).toContain(MIGRATION_STAGING_DIRECTORY_PREFIX);
    await rm(join(abandonedStage, '.kb1-migration-stage-v1.json'), { force: true });

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: true
    });
    await expect(access(abandonedStage)).rejects.toBeTruthy();
    await expect(readFile(join(target, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
  });

  it('preserves a non-empty interrupted stage and fails closed with manual guidance', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    const abandonedStage = await createMigrationStagingDirectory(source, target);
    await rm(join(abandonedStage, '.kb1-migration-stage-v1.json'), { force: true });
    await mkdir(join(abandonedStage, 'copy'), { recursive: true });
    await writeFile(join(abandonedStage, 'copy', 'leaked.txt'), 'partial copy\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /non-empty.*remove it manually/
    );
    await expect(readFile(join(abandonedStage, 'copy', 'leaked.txt'), 'utf8')).resolves.toBe(
      'partial copy\n'
    );
    await expect(access(target)).rejects.toBeTruthy();
  });

  it('fails closed on an existing exclusive pair lock and succeeds after its owner releases it', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    const lock = await acquireMigrationLock(source, target);
    expect(lock.path).toContain(MIGRATION_LOCK_PREFIX);

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /exclusive migration lock .* already exists.*remove the lock manually/
    );
    await expect(access(lock.path)).resolves.toBeUndefined();
    await lock.release();

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).resolves.toEqual({
      migrated: true
    });
  });

  it('never deletes a lock whose owner token or inode no longer matches', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    const lock = await acquireMigrationLock(source, target);
    await writeFile(lock.path, '{"forged":true}\n', 'utf8');

    await expect(lock.release()).rejects.toThrow(/no longer matches its owner token and inode/);
    await expect(readFile(lock.path, 'utf8')).resolves.toBe('{"forged":true}\n');
  });

  it('fails closed when completion state is a symlink', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'legacy\n', 'utf8');
    await symlink(join(root, 'external-marker.json'), join(target, MIGRATION_COMPLETION_FILENAME));

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /completion marker .* is not a regular file/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
  });

  it('preserves the source when same-length files have different content', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'old-data\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'new-data\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /state\.txt content mismatch/
    );

    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('old-data\n');
    await expect(readFile(join(target, 'state.txt'), 'utf8')).resolves.toBe('new-data\n');
  });

  it('preserves the source when a target entry has the wrong filesystem type', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(join(target, 'state.txt'), { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');

    await expect(verifyCopy(source, target)).rejects.toThrow(/not a regular file/);
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
  });

  it('rejects a target file hard-linked to the retained source', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await link(join(source, 'state.txt'), join(target, 'state.txt'));

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /hard-linked source file/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).rejects.toBeTruthy();
  });

  it('rejects hard links within the legacy source tree', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await link(join(source, 'state.txt'), join(source, 'state-alias.txt'));

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /hard-linked source file/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(target)).rejects.toBeTruthy();
  });

  it('rejects source names that collapse on case-insensitive or Windows filesystems', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'note.md'), 'same content\n', 'utf8');
    await writeFile(join(source, 'note.md.'), 'same content\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /portable-name collision "note\.md" \/ "note\.md\."/
    );
    await expect(readFile(join(source, 'note.md'), 'utf8')).resolves.toBe('same content\n');
    await expect(access(target)).rejects.toBeTruthy();
  });

  it('rejects cross-tree portable aliases before publishing any missing entry', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'first-missing.txt'), 'must not publish\n', 'utf8');
    await writeFile(join(source, 'note.md'), 'legacy note\n', 'utf8');
    await writeFile(join(target, 'NOTE.md'), 'target-only alias\n', 'utf8');

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /cross-tree portable-name alias "note\.md" \/ "NOTE\.md"/
    );
    await expect(access(join(target, 'first-missing.txt'))).rejects.toBeTruthy();
    await expect(readFile(join(target, 'NOTE.md'), 'utf8')).resolves.toBe('target-only alias\n');
    await expect(readFile(join(source, 'note.md'), 'utf8')).resolves.toBe('legacy note\n');
    await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).rejects.toBeTruthy();
  });

  it('rejects a target-only hard link to any external inode', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    const externalFile = join(root, 'external-state.txt');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(externalFile, 'external\n', 'utf8');
    await link(externalFile, join(target, 'extra-state.txt'));

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /extra-state\.txt is not an independent copy \(multiple hard links\)/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(join(target, MIGRATION_COMPLETION_FILENAME))).rejects.toBeTruthy();
  });

  it('fails explicitly instead of skipping a symlinked legacy root', async () => {
    const actualSource = join(root, 'legacy-storage');
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(actualSource, { recursive: true });
    await writeFile(join(actualSource, 'state.txt'), 'legacy\n', 'utf8');
    await symlink(actualSource, source);

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /legacy source .*unsupported filesystem type/
    );
    await expect(readFile(join(actualSource, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(target)).rejects.toBeTruthy();
  });

  it('never publishes a rejected copied entry and succeeds cleanly after correction', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    const externalFile = join(root, 'external.md');
    const linkedFile = join(source, 'linked.md');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await symlink(externalFile, linkedFile);

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /unsupported filesystem type/
    );
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(target)).rejects.toBeTruthy();

    await rm(linkedFile);
    const result = await migrateDirectoryCopyVerifyPreserve({ source, target });
    expect(result.migrated).toBe(true);
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(readFile(join(target, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
    await expect(access(join(target, 'linked.md'))).rejects.toBeTruthy();
  });

  it('rejects unsupported entries that exist only in an interrupted target', async () => {
    const source = join(root, '.kb2');
    const target = join(root, '.kb1');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'state.txt'), 'legacy\n', 'utf8');
    await writeFile(join(target, 'state.txt'), 'legacy\n', 'utf8');
    await symlink(join(root, 'external.md'), join(target, 'extra-link.md'));

    await expect(migrateDirectoryCopyVerifyPreserve({ source, target })).rejects.toThrow(
      /extra-link\.md is not a regular file in the copy/
    );
    await expect(readFile(join(source, 'state.txt'), 'utf8')).resolves.toBe('legacy\n');
  });
});
