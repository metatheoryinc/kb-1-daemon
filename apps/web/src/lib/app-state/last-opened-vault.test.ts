import { describe, expect, it } from 'vitest';
import { createAppState, DEFAULT_PERSIST_KEY } from './store';

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

describe('lastOpenedVaultId slice', () => {
  it('defaults to null', () => {
    expect(createAppState().getState().lastOpenedVaultId).toBe(null);
  });

  it('setLastOpenedVaultId records the slug', () => {
    const store = createAppState();
    store.setLastOpenedVaultId('field-notes');
    expect(store.getState().lastOpenedVaultId).toBe('field-notes');
  });

  it('is a no-op when unchanged', () => {
    const store = createAppState();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.setLastOpenedVaultId(null);
    expect(notified).toBe(0);
    store.setLastOpenedVaultId('demo-vault');
    expect(notified).toBe(1);
    store.setLastOpenedVaultId('demo-vault');
    expect(notified).toBe(1);
  });

  it('null forgets the last-opened (e.g. the last vault was deleted)', () => {
    const store = createAppState();
    store.setLastOpenedVaultId('demo-vault');
    store.setLastOpenedVaultId(null);
    expect(store.getState().lastOpenedVaultId).toBe(null);
  });

  it('persists and rehydrates the slug', () => {
    const storage = memoryStorage();
    const a = createAppState({ storage });
    a.setLastOpenedVaultId('field-notes');
    const b = createAppState({ storage });
    expect(b.getState().lastOpenedVaultId).toBe('field-notes');
  });

  it('ignores a non-string persisted value', () => {
    const storage = memoryStorage();
    storage.setItem(DEFAULT_PERSIST_KEY, JSON.stringify({ lastOpenedVaultId: 42 }));
    expect(createAppState({ storage }).getState().lastOpenedVaultId).toBe(null);
  });
});
