import { getContext, setContext } from 'svelte';
import type { AppStateStore } from './store';

/**
 * The app-state store is instantiated once in the root layout and
 * shared down the tree via Svelte context, so the layout's color-mode
 * resolver and the page's toggle act on the same instance — no
 * module-scope singleton, which keeps per-test identity honest.
 */
const APP_STATE_KEY = Symbol('app-state');

export function setAppStateContext(store: AppStateStore): void {
  setContext(APP_STATE_KEY, store);
}

export function useAppState(): AppStateStore {
  const store = getContext<AppStateStore | undefined>(APP_STATE_KEY);
  if (!store) {
    throw new Error('useAppState() called outside of an app-state provider');
  }
  return store;
}
