import { describe, expect, it } from 'vitest';
import { createAppState } from './store';

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

describe('railCollapsed slice', () => {
  it('defaults to collapsed (true)', () => {
    expect(createAppState().getState().railCollapsed).toBe(true);
  });

  it('toggleRailCollapsed flips the flag', () => {
    const store = createAppState();
    store.toggleRailCollapsed();
    expect(store.getState().railCollapsed).toBe(false);
    store.toggleRailCollapsed();
    expect(store.getState().railCollapsed).toBe(true);
  });

  it('setRailCollapsed sets directly and is a no-op when unchanged', () => {
    const store = createAppState();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.setRailCollapsed(true);
    expect(notified).toBe(0);
    store.setRailCollapsed(false);
    expect(store.getState().railCollapsed).toBe(false);
    expect(notified).toBe(1);
  });

  it('persists and rehydrates the flag', () => {
    const storage = memoryStorage();
    const a = createAppState({ storage });
    a.setRailCollapsed(false);
    const b = createAppState({ storage });
    expect(b.getState().railCollapsed).toBe(false);
  });

  it('ignores a non-boolean persisted value', () => {
    const storage = memoryStorage();
    storage.setItem('kb2:app-state', JSON.stringify({ railCollapsed: 'yes' }));
    expect(createAppState({ storage }).getState().railCollapsed).toBe(true);
  });
});
