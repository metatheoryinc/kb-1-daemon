import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverVaults,
  migrateLegacyVaultLayout,
  readOrMintVaultIdentity,
  slugFromFolderName
} from './vault-registry.js';

describe('vault registry', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kb2-registry-'));
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  describe('slugFromFolderName', () => {
    it('lowercases and hyphenates', () => {
      expect(slugFromFolderName('My Vault')).toBe('my-vault');
      expect(slugFromFolderName('demo-vault')).toBe('demo-vault');
      expect(slugFromFolderName('Notes & Stuff!!')).toBe('notes-stuff');
    });

    it('falls back to "vault" when nothing usable remains', () => {
      expect(slugFromFolderName('***')).toBe('vault');
    });
  });

  describe('readOrMintVaultIdentity', () => {
    it('mints identity from the folder name on first sight', async () => {
      const root = join(home, 'My Vault');
      await mkdir(root, { recursive: true });

      const identity = await readOrMintVaultIdentity(root, 'My Vault');
      expect(identity).toEqual({ id: 'my-vault', displayName: 'My Vault' });

      const persisted = JSON.parse(await readFile(join(root, '.kb2', 'vault.json'), 'utf8'));
      expect(persisted).toEqual({ id: 'my-vault', displayName: 'My Vault' });
    });

    it('reads an existing identity without overwriting it', async () => {
      const root = join(home, 'demo-vault');
      await mkdir(join(root, '.kb2'), { recursive: true });
      await writeFile(
        join(root, '.kb2', 'vault.json'),
        JSON.stringify({ id: 'custom-slug', displayName: 'Custom Name' }),
        'utf8'
      );

      const identity = await readOrMintVaultIdentity(root, 'demo-vault');
      expect(identity).toEqual({ id: 'custom-slug', displayName: 'Custom Name' });
    });

    it('fails loudly on malformed identity', async () => {
      const root = join(home, 'broken');
      await mkdir(join(root, '.kb2'), { recursive: true });
      await writeFile(join(root, '.kb2', 'vault.json'), '{ not json', 'utf8');

      await expect(readOrMintVaultIdentity(root, 'broken')).rejects.toThrow(/Malformed vault identity/);
    });
  });

  describe('discoverVaults', () => {
    it('returns [] when the vaults home does not exist', async () => {
      await expect(discoverVaults(join(home, 'vaults'))).resolves.toEqual([]);
    });

    it('discovers and mints identities for each vault directory', async () => {
      const vaultsHome = join(home, 'vaults');
      await mkdir(join(vaultsHome, 'alpha'), { recursive: true });
      await mkdir(join(vaultsHome, 'beta'), { recursive: true });

      const entries = await discoverVaults(vaultsHome);
      expect(entries.map((e) => e.slug).sort()).toEqual(['alpha', 'beta']);
      expect(entries.every((e) => e.root.startsWith(vaultsHome))).toBe(true);
    });

    it('throws a hard error on slug collision', async () => {
      const vaultsHome = join(home, 'vaults');
      const first = join(vaultsHome, 'one');
      const second = join(vaultsHome, 'two');
      await mkdir(join(first, '.kb2'), { recursive: true });
      await mkdir(join(second, '.kb2'), { recursive: true });
      const dup = JSON.stringify({ id: 'same', displayName: 'Same' });
      await writeFile(join(first, '.kb2', 'vault.json'), dup, 'utf8');
      await writeFile(join(second, '.kb2', 'vault.json'), dup, 'utf8');

      await expect(discoverVaults(vaultsHome)).rejects.toThrow(/Duplicate vault slug "same"/);
    });
  });

  describe('migrateLegacyVaultLayout', () => {
    async function seedLegacyVault(): Promise<string> {
      const legacy = join(home, 'demo-vault');
      await mkdir(join(legacy, 'notes'), { recursive: true });
      await writeFile(join(legacy, 'hello-world.md'), '# Hello\n', 'utf8');
      await writeFile(join(legacy, 'notes', 'deep.md'), 'deep content\n', 'utf8');
      return legacy;
    }

    it('copies, verifies, then removes the legacy vault', async () => {
      const legacy = await seedLegacyVault();
      const vaultsHome = join(home, 'vaults');

      const result = await migrateLegacyVaultLayout({
        legacyVaultDir: legacy,
        vaultsHome,
        targetSlug: 'demo-vault'
      });

      expect(result.migrated).toBe(true);
      const target = join(vaultsHome, 'demo-vault');
      await expect(readFile(join(target, 'hello-world.md'), 'utf8')).resolves.toBe('# Hello\n');
      await expect(readFile(join(target, 'notes', 'deep.md'), 'utf8')).resolves.toBe('deep content\n');
      // Cleanup: legacy directory gone only after a verified copy.
      await expect(access(legacy)).rejects.toBeTruthy();
    });

    it('is idempotent once the vaults home exists', async () => {
      const legacy = await seedLegacyVault();
      const vaultsHome = join(home, 'vaults');
      await migrateLegacyVaultLayout({ legacyVaultDir: legacy, vaultsHome, targetSlug: 'demo-vault' });

      // Recreate a stray legacy dir; migration should now be a no-op because
      // vaults/ already exists.
      await mkdir(legacy, { recursive: true });
      const second = await migrateLegacyVaultLayout({
        legacyVaultDir: legacy,
        vaultsHome,
        targetSlug: 'demo-vault'
      });
      expect(second.migrated).toBe(false);
      await expect(stat(legacy)).resolves.toBeTruthy();
    });

    it('leaves the original intact when the copy step fails (copy-not-move)', async () => {
      const legacy = await seedLegacyVault();
      // Point vaultsHome under a path whose parent is a regular file so the
      // mkdir/cp step throws partway through, simulating an interrupted run.
      const fileParent = join(home, 'not-a-dir');
      await writeFile(fileParent, 'x', 'utf8');
      const vaultsHome = join(fileParent, 'vaults');

      await expect(
        migrateLegacyVaultLayout({ legacyVaultDir: legacy, vaultsHome, targetSlug: 'demo-vault' })
      ).rejects.toBeTruthy();

      // The legacy original must still be fully intact (copy-not-move).
      await expect(readFile(join(legacy, 'hello-world.md'), 'utf8')).resolves.toBe('# Hello\n');
      await expect(readFile(join(legacy, 'notes', 'deep.md'), 'utf8')).resolves.toBe('deep content\n');
    });
  });
});
