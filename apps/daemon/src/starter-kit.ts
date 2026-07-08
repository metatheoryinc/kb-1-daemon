import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeVaultFile } from '@kb-1/vault-core';

/** Vault-internal directory that holds identity/state, never user content. */
const VAULT_IDENTITY_DIR = '.kb1';

/**
 * Absolute path to the bundled starter-kit template tree. Resolved relative to
 * this module so it works both under `tsx`/dev (src tree) and after a build,
 * where the build step copies the template directory alongside the compiled
 * module (dist tree).
 */
export const STARTER_KIT_DIR = fileURLToPath(new URL('./starter-kit-template/', import.meta.url));

/**
 * Recursively copy the bundled starter-kit template tree into a vault root.
 *
 * Safe to call on any vault: it seeds only when the vault has no user content
 * yet (the vault-identity `.kb1` directory does not count), so an existing or
 * already-seeded vault is never overwritten or duplicated. Files are written
 * through the shared vault-core write path so seeding follows the same fs and
 * audit conventions as every other vault write.
 *
 * Expanding the kit needs no code change here: whatever files and folders live
 * under {@link STARTER_KIT_DIR} are copied as-is, recursively.
 *
 * @returns `true` when the kit was seeded, `false` when the vault already had
 *   content and was left untouched.
 */
export async function seedVaultFromStarterKit(vaultRoot: string): Promise<boolean> {
  if (await hasUserContent(vaultRoot)) {
    return false;
  }

  const files = await collectTemplateFiles(STARTER_KIT_DIR);
  for (const file of files) {
    const seeded = await writeVaultFile(
      { root: vaultRoot, actor: { kind: 'system' } },
      { path: file.vaultPath, content: file.content }
    );
    if (!seeded.ok) {
      throw new Error(`Failed to seed starter-kit file "${file.vaultPath}": ${seeded.message}`);
    }
  }

  return true;
}

/** A vault holds user content when it has any entry other than the `.kb1` dir. */
async function hasUserContent(vaultRoot: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(vaultRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }

  return entries.some((entry) => entry.name !== VAULT_IDENTITY_DIR);
}

interface TemplateFile {
  /** Vault-relative POSIX path the file should be written to. */
  vaultPath: string;
  content: string;
}

/**
 * Walk the template tree and return every file with its vault-relative path.
 * Directories are implied by their files: empty directories carry no content
 * and so are not represented, which keeps the seeder driven purely by the files
 * present in the kit.
 */
export async function collectTemplateFiles(templateDir: string): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      // A missing template at the root means the build did not bundle
      // starter-kit-template/ into dist — fail loudly with an actionable
      // message rather than a bare ENOENT.
      if (relativeDir.length === 0 && isNodeErrorCode(error, 'ENOENT')) {
        throw new Error(
          `Starter-kit template not found at ${absoluteDir}. The build must copy ` +
            `starter-kit-template/ into dist alongside the compiled module.`
        );
      }
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(absoluteDir, entry.name);
      const relative = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push({ vaultPath: relative, content: await readFile(absolute, 'utf8') });
      }
    }
  }

  await walk(templateDir, '');
  return files;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
