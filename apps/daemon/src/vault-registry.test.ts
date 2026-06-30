import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverVaults,
  isWellFormedSlug,
  migrateLegacyVaultLayout,
  readOrMintVaultIdentity,
  slugify,
  VAULT_TRASH_DIRNAME,
  VaultRegistry,
  type VaultRegistryChangeEvent
} from './vault-registry.js';

describe('vault registry', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kb2-registry-'));
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  describe('slugify', () => {
    it('normalizes a display name into a slug via github-slugger', () => {
      expect(slugify('My Vault')).toBe('my-vault');
      expect(slugify('demo-vault')).toBe('demo-vault');
    });

    it('yields an empty slug when nothing usable remains (no silent fallback)', () => {
      expect(slugify('***')).toBe('');
    });

    it('is idempotent on an already-normalized slug', () => {
      expect(slugify('my-vault')).toBe('my-vault');
      expect(slugify(slugify('Notes & Stuff!!'))).toBe(slugify('Notes & Stuff!!'));
    });
  });

  describe('isWellFormedSlug', () => {
    it('accepts non-empty, already-normalized slugs', () => {
      expect(isWellFormedSlug('my-vault')).toBe(true);
      expect(isWellFormedSlug('demo-vault')).toBe(true);
      expect(isWellFormedSlug('field-notes-2')).toBe(true);
    });

    it('rejects empty or non-normalized slugs', () => {
      expect(isWellFormedSlug('')).toBe(false);
      expect(isWellFormedSlug('My Vault')).toBe(false);
      expect(isWellFormedSlug('Notes!')).toBe(false);
      expect(isWellFormedSlug('trailing ')).toBe(false);
    });

    it('agrees with slugify: a slugified value is always well-formed', () => {
      for (const input of ['My Vault', 'demo-vault', 'Notes & Stuff!!', 'a_b_c']) {
        const slug = slugify(input);
        if (slug.length > 0) {
          expect(isWellFormedSlug(slug)).toBe(true);
        }
      }
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

    it('reads valid metadata and rejects malformed metadata', async () => {
      const root = join(home, 'demo-vault');
      await mkdir(join(root, '.kb2'), { recursive: true });
      await writeFile(
        join(root, '.kb2', 'vault.json'),
        JSON.stringify({ id: 'demo-vault', displayName: 'Demo Vault', metadata: { color: '#f97316' } }),
        'utf8'
      );

      await expect(readOrMintVaultIdentity(root, 'demo-vault')).resolves.toEqual({
        id: 'demo-vault',
        displayName: 'Demo Vault',
        metadata: { color: '#f97316' }
      });

      await writeFile(
        join(root, '.kb2', 'vault.json'),
        JSON.stringify({ id: 'demo-vault', displayName: 'Demo Vault', metadata: 'coral' }),
        'utf8'
      );
      await expect(readOrMintVaultIdentity(root, 'demo-vault')).rejects.toThrow(/"metadata" must be a JSON object/);

      await writeFile(
        join(root, '.kb2', 'vault.json'),
        JSON.stringify({ id: 'demo-vault', displayName: 'Demo Vault', metadata: { color: 42 } }),
        'utf8'
      );
      await expect(readOrMintVaultIdentity(root, 'demo-vault')).rejects.toThrow(/"metadata.color" must be a string/);

      await writeFile(
        join(root, '.kb2', 'vault.json'),
        JSON.stringify({ id: 'demo-vault', displayName: 'Demo Vault', metadata: { color: 'neon' } }),
        'utf8'
      );
      await expect(readOrMintVaultIdentity(root, 'demo-vault')).rejects.toThrow(
        /"metadata.color" must be "inherit" or a hex color/
      );
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

  describe('VaultRegistry runtime CRUD', () => {
    let vaultsHome: string;
    let trashHome: string;

    beforeEach(() => {
      vaultsHome = join(home, 'vaults');
      trashHome = join(home, VAULT_TRASH_DIRNAME);
    });

    async function loadRegistry(): Promise<VaultRegistry> {
      return VaultRegistry.load(vaultsHome, trashHome);
    }

    it('creates a valid empty vault, minting identity, and registers it live', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      const created = await registry.create({ displayName: 'My Notes', slug: 'my-notes' });
      expect(created).toEqual({ ok: true, vault: { id: 'my-notes', displayName: 'My Notes' } });

      // Filesystem is the source of truth: the folder and minted identity exist.
      const identity = JSON.parse(await readFile(join(vaultsHome, 'my-notes', '.kb2', 'vault.json'), 'utf8'));
      expect(identity).toEqual({ id: 'my-notes', displayName: 'My Notes' });

      // It is immediately listable and servable from the in-memory registry.
      expect(registry.list()).toContainEqual({ id: 'my-notes', displayName: 'My Notes' });
      expect(registry.get('my-notes')).toBeDefined();

      // A second, independent load sees the same vault on disk (no restart needed
      // to persist, but it survives one too).
      const reloaded = await loadRegistry();
      expect(reloaded.get('my-notes')).toBeDefined();

      await registry.close();
      await reloaded.close();
    });

    it('forwards service change events for vaults created after subscription', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();
      const events: VaultRegistryChangeEvent[] = [];
      const unsubscribe = registry.onVaultEvent((event) => events.push(event));

      await registry.create({ displayName: 'Project X', slug: 'project-x' });
      const instance = registry.get('project-x');
      if (!instance) throw new Error('expected live vault instance');

      await expect(instance.service.createFolder({
        path: 'event-test-folder',
        actor: { kind: 'user' }
      })).resolves.toMatchObject({ ok: true, path: 'event-test-folder' });

      expect(events).toContainEqual(expect.objectContaining({
        vaultSlug: 'project-x',
        event: expect.objectContaining({
          kind: 'folder_created',
          path: 'event-test-folder'
        })
      }));

      unsubscribe();
      const countAfterUnsubscribe = events.length;
      await expect(instance.service.createFolder({
        path: 'later',
        actor: { kind: 'user' }
      })).resolves.toMatchObject({ ok: true, path: 'later' });
      expect(events).toHaveLength(countAfterUnsubscribe);

      await registry.close();
    });

    it('rejects creating a vault whose slug collides with an existing one', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      const first = await registry.create({ displayName: 'Project X', slug: 'project-x' });
      expect(first.ok).toBe(true);

      // A second create with the same explicit slug is a clean collision, not a
      // crash, and does not disturb the first vault.
      const collision = await registry.create({ displayName: 'Another Project', slug: 'project-x' });
      expect(collision).toEqual({
        ok: false,
        error: 'already_exists',
        message: expect.stringContaining('project-x')
      });
      expect(registry.list().filter((v) => v.id === 'project-x')).toHaveLength(1);

      await registry.close();
    });

    it('rejects an empty display name on create', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      const created = await registry.create({ displayName: '   ', slug: 'whatever' });
      expect(created).toEqual({
        ok: false,
        error: 'invalid_request',
        message: expect.any(String)
      });

      await registry.close();
    });

    it('rejects a malformed slug on create (never infers it from the display name)', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      // A non-normalized slug is a clean invalid_request; nothing lands on disk.
      const created = await registry.create({ displayName: 'Field Notes', slug: 'Field Notes' });
      expect(created).toEqual({
        ok: false,
        error: 'invalid_request',
        message: expect.any(String)
      });
      expect(registry.list()).toHaveLength(0);
      await expect(access(join(vaultsHome, 'Field Notes'))).rejects.toBeTruthy();

      // An empty slug is rejected too.
      const empty = await registry.create({ displayName: 'Field Notes', slug: '' });
      expect(empty.ok).toBe(false);

      await registry.close();
    });

    it('renames a vault by display name only, leaving slug and folder unchanged', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();
      await registry.create({ displayName: 'Original', slug: 'original' });

      const renamed = await registry.rename('original', { displayName: 'Renamed' });
      expect(renamed).toEqual({ ok: true, vault: { id: 'original', displayName: 'Renamed' } });

      // The slug is stable, the folder did not move, and identity on disk reflects
      // the new display name.
      expect(registry.get('original')).toBeDefined();
      expect(registry.list()).toContainEqual({ id: 'original', displayName: 'Renamed' });
      const identity = JSON.parse(await readFile(join(vaultsHome, 'original', '.kb2', 'vault.json'), 'utf8'));
      expect(identity).toEqual({ id: 'original', displayName: 'Renamed' });

      await registry.close();
    });

    it('preserves vault metadata when renaming a vault', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();
      await registry.create({ displayName: 'Original', slug: 'original' });
      await registry.setMetadata('original', { color: '#0ea5e9' }, { kind: 'user' });

      const renamed = await registry.rename('original', { displayName: 'Renamed' });
      expect(renamed).toEqual({
        ok: true,
        vault: { id: 'original', displayName: 'Renamed', metadata: { color: '#0ea5e9' } }
      });

      const identity = JSON.parse(await readFile(join(vaultsHome, 'original', '.kb2', 'vault.json'), 'utf8'));
      expect(identity).toEqual({ id: 'original', displayName: 'Renamed', metadata: { color: '#0ea5e9' } });

      await registry.close();
    });

    it('returns a clean not_found when renaming an unknown vault', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      const renamed = await registry.rename('ghost', { displayName: 'Nope' });
      expect(renamed).toEqual({ ok: false, error: 'not_found', message: expect.stringContaining('ghost') });

      await registry.close();
    });

    it('soft-deletes a vault: folder moves to trash with data intact, gone from the registry', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();
      await registry.create({ displayName: 'Disposable', slug: 'disposable' });

      // Drop a note in so we can prove the data survives the soft delete.
      await writeFile(join(vaultsHome, 'disposable', 'kept.md'), 'precious\n', 'utf8');

      const deleted = await registry.softDelete('disposable');
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) throw new Error('expected soft delete to succeed');

      // Removed from the live registry...
      expect(registry.get('disposable')).toBeUndefined();
      expect(registry.list().some((v) => v.id === 'disposable')).toBe(false);

      // ...and gone from the active vaults directory...
      await expect(access(join(vaultsHome, 'disposable'))).rejects.toBeTruthy();

      // ...but reversibly preserved under trash, byte-for-byte.
      expect(deleted.trashedTo.startsWith(trashHome)).toBe(true);
      await expect(readFile(join(deleted.trashedTo, 'kept.md'), 'utf8')).resolves.toBe('precious\n');

      await registry.close();
    });

    it('returns a clean not_found when soft-deleting an unknown vault', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      const deleted = await registry.softDelete('ghost');
      expect(deleted).toEqual({ ok: false, error: 'not_found', message: expect.stringContaining('ghost') });

      await registry.close();
    });

    it('does not overwrite an earlier trashed copy when a recreated slug is deleted again', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();

      await registry.create({ displayName: 'Recycle', slug: 'recycle' });
      await writeFile(join(vaultsHome, 'recycle', 'v1.md'), 'first\n', 'utf8');
      const firstDelete = await registry.softDelete('recycle');
      if (!firstDelete.ok) throw new Error('expected first soft delete to succeed');

      await registry.create({ displayName: 'Recycle', slug: 'recycle' });
      await writeFile(join(vaultsHome, 'recycle', 'v2.md'), 'second\n', 'utf8');
      const secondDelete = await registry.softDelete('recycle');
      if (!secondDelete.ok) throw new Error('expected second soft delete to succeed');

      // Two distinct trash destinations: neither copy clobbers the other.
      expect(secondDelete.trashedTo).not.toBe(firstDelete.trashedTo);
      await expect(readFile(join(firstDelete.trashedTo, 'v1.md'), 'utf8')).resolves.toBe('first\n');
      await expect(readFile(join(secondDelete.trashedTo, 'v2.md'), 'utf8')).resolves.toBe('second\n');

      await registry.close();
    });

    it('sets, clears, validates, and emits vault metadata changes', async () => {
      await mkdir(vaultsHome, { recursive: true });
      const registry = await loadRegistry();
      await registry.create({ displayName: 'Design Notes', slug: 'design-notes' });

      const events: VaultRegistryChangeEvent[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unsubscribeThrowingHandler = registry.onVaultEvent(() => {
        throw new Error('boom');
      });
      const unsubscribe = registry.onVaultEvent((event) => events.push(event));

      const set = await registry.setMetadata('design-notes', { color: '#a855f7' }, { kind: 'user' });
      expect(set).toEqual({
        ok: true,
        vault: { id: 'design-notes', displayName: 'Design Notes', metadata: { color: '#a855f7' } }
      });
      expect(registry.list()).toContainEqual({
        id: 'design-notes',
        displayName: 'Design Notes',
        metadata: { color: '#a855f7' }
      });
      await expect(readFile(join(vaultsHome, 'design-notes', '.kb2', 'vault.json'), 'utf8')).resolves.toContain(
        '"metadata"'
      );
      expect(events).toContainEqual(expect.objectContaining({
        vaultSlug: 'design-notes',
        event: expect.objectContaining({
          kind: 'vault_metadata_changed',
          path: '',
          actor: { kind: 'user' }
        })
      }));
      expect(warn).toHaveBeenCalledWith('KB-2 vault registry event handler failed.', expect.any(Error));

      expect(await registry.setMetadata('missing', { color: '#a855f7' }, { kind: 'user' })).toEqual({
        ok: false,
        error: 'not_found',
        message: expect.stringContaining('missing')
      });
      expect(await registry.setMetadata('design-notes', { color: 'hotpink' }, { kind: 'user' })).toEqual({
        ok: false,
        error: 'invalid_request',
        message: 'metadata.color must be "inherit" or a hex color'
      });
      expect(
        await registry.setMetadata('design-notes', { color: 42 as unknown as string }, { kind: 'user' })
      ).toEqual({
        ok: false,
        error: 'invalid_request',
        message: 'metadata.color must be a string or null'
      });

      const inherited = await registry.setMetadata('design-notes', { color: 'inherit' }, { kind: 'user' });
      expect(inherited).toEqual({
        ok: true,
        vault: { id: 'design-notes', displayName: 'Design Notes', metadata: { color: 'inherit' } }
      });

      const cleared = await registry.setMetadata('design-notes', { color: null }, { kind: 'user' });
      expect(cleared).toEqual({ ok: true, vault: { id: 'design-notes', displayName: 'Design Notes' } });
      const identity = JSON.parse(await readFile(join(vaultsHome, 'design-notes', '.kb2', 'vault.json'), 'utf8'));
      expect(identity).toEqual({ id: 'design-notes', displayName: 'Design Notes' });

      unsubscribe();
      unsubscribeThrowingHandler();
      warn.mockRestore();
      await registry.close();
    });
  });
});
