import { cp, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface DirectoryMigrationInput {
  source: string;
  target: string;
}

export interface DirectoryMigrationResult {
  migrated: boolean;
}

export async function migrateDirectoryCopyVerifyCleanup(
  input: DirectoryMigrationInput
): Promise<DirectoryMigrationResult> {
  const { source, target } = input;
  if (!(await isDirectory(source))) {
    return { migrated: false };
  }

  if (await pathExists(target)) {
    await verifyCopy(source, target);
    await rm(source, { recursive: true, force: true });
    return { migrated: false };
  }

  await cp(source, target, { recursive: true });
  await verifyCopy(source, target);
  await rm(source, { recursive: true, force: true });

  return { migrated: true };
}

export async function verifyCopy(source: string, target: string): Promise<void> {
  const sourceFiles = await listFilesWithSizes(source);
  const targetFiles = await listFilesWithSizes(target);

  for (const [relPath, size] of sourceFiles) {
    const copiedSize = targetFiles.get(relPath);
    if (copiedSize === undefined) {
      throw new Error(`Migration verification failed: ${relPath} missing from copy.`);
    }
    if (copiedSize !== size) {
      throw new Error(
        `Migration verification failed: ${relPath} size mismatch (source ${size}, copy ${copiedSize}).`
      );
    }
  }
}

async function listFilesWithSizes(root: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const info = await stat(abs);
        sizes.set(relative(root, abs), info.size);
      }
    }
  }

  await walk(root);
  return sizes;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
