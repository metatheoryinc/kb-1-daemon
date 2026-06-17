/**
 * Client-side app-state store for the editor shell.
 *
 * Holds shell chrome preferences that follow the user across sessions
 * but are NOT document data. State is persisted to `localStorage` under
 * a single namespace so the whole "how the app is set up" blob lives in
 * one slot. The store is a small subscribe/getState scaffold so further
 * slices (favorites, filter, tree expansion, rail width) can be folded
 * into `AppState` later without reworking consumers.
 *
 * Persistence is intentionally owned here, in the app, rather than in
 * any shared UI package: UI components stay prop-driven and never reach
 * for transport or browser storage themselves.
 */

/**
 * Color-mode choice. `'system'` defers to the OS via
 * `prefers-color-scheme`; the root layout resolves it against
 * `window.matchMedia` and writes the DOM flags. `'light'` / `'dark'`
 * pin the resolved mode regardless of the OS preference.
 */
export type ColorMode = 'light' | 'dark' | 'system';

export const colorModes: readonly ColorMode[] = ['light', 'dark', 'system'];

/** Default persistence slot. Stable across releases — renaming wipes state. */
export const DEFAULT_PERSIST_KEY = 'kb2:app-state';

/** Shape of the persisted blob. Versioned by structure, not by a flag. */
interface PersistedState {
  colorMode: ColorMode;
}

/** The live, in-memory app state. Mirrors the persisted slice plus actions. */
export interface AppState {
  colorMode: ColorMode;
}

export interface AppStateStore {
  getState: () => AppState;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe: (listener: (state: AppState) => void) => () => void;
  setColorMode: (mode: ColorMode) => void;
  /** Cycle light → dark → system → light. */
  cycleColorMode: () => void;
}

export interface CreateAppStateOptions {
  /**
   * String key/value storage used for persistence (e.g. the browser's
   * `localStorage`). Omit for an in-memory store that writes nothing
   * durable — handy for tests and non-browser contexts.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Persistence slot name. Defaults to {@link DEFAULT_PERSIST_KEY}. */
  persistKey?: string;
}

const DEFAULT_STATE: AppState = { colorMode: 'system' };

function nextColorMode(mode: ColorMode): ColorMode {
  return mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light';
}

function isColorMode(value: unknown): value is ColorMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readPersisted(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  key: string,
): Partial<PersistedState> {
  if (!storage) return {};
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'colorMode' in parsed) {
      const { colorMode } = parsed as { colorMode: unknown };
      if (isColorMode(colorMode)) return { colorMode };
    }
  } catch {
    // Corrupt blob — fall back to defaults rather than throwing.
  }
  return {};
}

/**
 * Build the app-state store. Hydrates from `storage` (when supplied),
 * then writes the persisted slice back on every mutation.
 */
export function createAppState(
  options: CreateAppStateOptions = {},
): AppStateStore {
  const { storage, persistKey = DEFAULT_PERSIST_KEY } = options;
  const persisted = readPersisted(storage, persistKey);

  let state: AppState = {
    ...DEFAULT_STATE,
    colorMode: persisted.colorMode ?? DEFAULT_STATE.colorMode,
  };

  const listeners = new Set<(state: AppState) => void>();

  function persist(): void {
    if (!storage) return;
    const blob: PersistedState = { colorMode: state.colorMode };
    try {
      storage.setItem(persistKey, JSON.stringify(blob));
    } catch {
      // Storage may be unavailable (private mode, quota). State stays
      // correct in memory; persistence is best-effort.
    }
  }

  function set(partial: Partial<AppState>): void {
    const next = { ...state, ...partial };
    if (next.colorMode === state.colorMode) return;
    state = next;
    persist();
    for (const listener of listeners) listener(state);
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setColorMode: (mode) => set({ colorMode: mode }),
    cycleColorMode: () => set({ colorMode: nextColorMode(state.colorMode) }),
  };
}
