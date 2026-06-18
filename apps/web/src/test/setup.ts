import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/svelte';

// happy-dom does not always expose a working `window.localStorage` (the
// runner reports `--localstorage-file was provided without a valid path`),
// so the app-state store's `getItem`/`setItem`/`clear` calls would throw.
// Install a minimal in-memory Storage so the store persists within a test
// run; each test clears it for a clean first-load baseline.
function installMemoryStorage(): void {
  const store = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memory,
  });
}

installMemoryStorage();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
