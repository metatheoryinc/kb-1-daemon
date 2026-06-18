import { describe, expect, it } from 'vitest';
import type { LocalTreeNode } from '@kb-2/ui';
import { buildStarredViewData } from './favorites-data';
import type { FavoriteEntry } from '$lib/app-state';

const VAULT = 'demo-vault';
const VAULT_NAME = 'Demo Vault';

const tree: LocalTreeNode[] = [
  {
    kind: 'folder',
    path: 'projects',
    name: 'projects',
    metadata: { color: 'sage' },
    children: [
      { kind: 'file', path: 'projects/a.md', name: 'a.md' },
    ],
  },
  { kind: 'file', path: 'root.md', name: 'root.md' },
];

function fav(kind: 'note' | 'folder', path: string, addedAt: number): FavoriteEntry {
  return { kind, vaultId: VAULT, path, addedAt };
}

describe('buildStarredViewData', () => {
  it('groups folders and notes and sorts most-recently-starred first', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree,
      favorites: [
        fav('note', 'root.md', 1),
        fav('note', 'projects/a.md', 3),
        fav('folder', 'projects', 2),
      ],
    });
    expect(view.folders.map((r) => r.path)).toEqual(['projects']);
    expect(view.notes.map((r) => r.path)).toEqual(['projects/a.md', 'root.md']);
    expect(view.total).toBe(3);
  });

  it('resolves a note row accent from its parent folder', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree,
      favorites: [fav('note', 'projects/a.md', 1)],
    });
    expect(view.notes[0].accent).toBe('sage');
  });

  it('resolves the leading colorHex from the accent and carries the vault label', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree,
      favorites: [fav('folder', 'projects', 1)],
    });
    // 'sage' accent → its palette hex.
    expect(view.folders[0].colorHex).toBe('#7dcb8e');
    expect(view.folders[0].vaultLabel).toBe(VAULT_NAME);
  });

  it('builds a navigable href for an available target and none for a missing one', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree,
      favorites: [fav('note', 'projects/a.md', 2), fav('note', 'gone.md', 1)],
    });
    const available = view.notes.find((r) => r.path === 'projects/a.md');
    const missing = view.notes.find((r) => r.path === 'gone.md');
    expect(available?.href).toBe('/demo-vault/projects/a.md');
    expect(missing?.href).toBeUndefined();
  });

  it('marks a missing target unavailable once the tree has loaded', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree,
      favorites: [fav('note', 'gone.md', 1)],
    });
    expect(view.notes[0].available).toBe(false);
  });

  it('treats everything as available while the tree is empty', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree: [],
      favorites: [fav('note', 'gone.md', 1)],
    });
    expect(view.notes[0].available).toBe(true);
  });

  it('ignores favorites from other vaults', () => {
    const view = buildStarredViewData({
      vaultId: VAULT,
      vaultName: VAULT_NAME,
      tree,
      favorites: [{ kind: 'note', vaultId: 'other', path: 'root.md', addedAt: 1 }],
    });
    expect(view.total).toBe(0);
  });
});
