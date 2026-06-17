import { describe, expect, it } from 'vitest';
import { createAppState, type FavoriteEntry } from './store';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { dump: () => string | null } {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    dump: () => value,
  };
}

const VAULT = 'demo-vault';

describe('favorites slice', () => {
  it('toggleFavorite adds then removes by identity', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'a.md' });
    expect(store.getState().favorites.map((f) => f.path)).toEqual(['a.md']);
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'a.md' });
    expect(store.getState().favorites).toEqual([]);
  });

  it('distinguishes a note and a folder at the same path', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'x' });
    store.toggleFavorite({ kind: 'folder', vaultId: VAULT, path: 'x' });
    expect(store.getState().favorites).toHaveLength(2);
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'x' });
    expect(store.getState().favorites.map((f) => f.kind)).toEqual(['folder']);
  });

  it('removeFavorite is a no-op when absent', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'a.md' });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.removeFavorite({ kind: 'note', vaultId: VAULT, path: 'missing.md' });
    expect(notified).toBe(0);
    expect(store.getState().favorites).toHaveLength(1);
  });

  it('persists favorites and rehydrates them', () => {
    const storage = memoryStorage();
    const a = createAppState({ storage });
    a.toggleFavorite({ kind: 'folder', vaultId: VAULT, path: 'research' });
    const b = createAppState({ storage });
    expect(b.getState().favorites.map((f) => ({ kind: f.kind, path: f.path }))).toEqual([
      { kind: 'folder', path: 'research' },
    ]);
  });

  it('drops malformed persisted entries', () => {
    const storage = memoryStorage();
    storage.setItem(
      'kb2:app-state',
      JSON.stringify({ favorites: [{ kind: 'note', path: 'ok.md', vaultId: VAULT }, { kind: 'bogus' }, 7] }),
    );
    const store = createAppState({ storage });
    expect(store.getState().favorites).toHaveLength(1);
    expect(store.getState().favorites[0].path).toBe('ok.md');
  });

  it('favoritesOnNoteDeleted removes the exact note', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'a.md' });
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'b.md' });
    store.favoritesOnNoteDeleted(VAULT, 'a.md');
    expect(store.getState().favorites.map((f) => f.path)).toEqual(['b.md']);
  });

  it('favoritesOnNoteRenamed rewrites the path', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'old.md' });
    store.favoritesOnNoteRenamed(VAULT, 'old.md', 'sub/new.md');
    expect(store.getState().favorites[0].path).toBe('sub/new.md');
  });

  it('favoritesOnFolderDeleted drops the folder and its descendants', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'folder', vaultId: VAULT, path: 'proj' });
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'proj/a.md' });
    store.toggleFavorite({ kind: 'folder', vaultId: VAULT, path: 'proj/sub' });
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'other.md' });
    store.favoritesOnFolderDeleted(VAULT, 'proj');
    expect(store.getState().favorites.map((f) => f.path)).toEqual(['other.md']);
  });

  it('favoritesOnFolderRenamed rewrites the folder and descendant paths', () => {
    const store = createAppState();
    store.toggleFavorite({ kind: 'folder', vaultId: VAULT, path: 'proj' });
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'proj/a.md' });
    store.toggleFavorite({ kind: 'folder', vaultId: VAULT, path: 'proj/sub' });
    store.toggleFavorite({ kind: 'note', vaultId: VAULT, path: 'keep.md' });
    store.favoritesOnFolderRenamed(VAULT, 'proj', 'archive/proj');
    const paths = store.getState().favorites.map((f) => f.path).sort();
    expect(paths).toEqual(['archive/proj', 'archive/proj/a.md', 'archive/proj/sub', 'keep.md']);
  });

  it('hygiene actions are scoped to the matching vault', () => {
    const store = createAppState();
    const entries: FavoriteEntry['vaultId'][] = ['v1', 'v2'];
    for (const v of entries) store.toggleFavorite({ kind: 'note', vaultId: v, path: 'a.md' });
    store.favoritesOnNoteDeleted('v1', 'a.md');
    expect(store.getState().favorites.map((f) => f.vaultId)).toEqual(['v2']);
  });
});
