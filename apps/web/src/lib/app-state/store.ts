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

/**
 * Shape of the persisted blob. Versioned by structure, not by a flag.
 *
 * The two expansion sets persist as plain string arrays (JSON has no
 * `Set`); they rehydrate back into `Set<string>` on load.
 */
interface PersistedState {
  colorMode: ColorMode;
  expandedFolderIds: string[];
  collapsedVaultIds: string[];
}

/** The live, in-memory app state. Mirrors the persisted slice plus actions. */
export interface AppState {
  colorMode: ColorMode;
  /**
   * Allow-list of expanded folder keys (`folder:<vaultId>:<path>`).
   * Folders default closed; a key present here means "show me unfurled."
   */
  expandedFolderIds: Set<string>;
  /**
   * Deny-list of collapsed vault ids. Vaults default open, so the
   * persisted shape is the inverse of the folder set — a vault id here
   * means "the user explicitly collapsed this vault group."
   */
  collapsedVaultIds: Set<string>;
}

export interface AppStateStore {
  getState: () => AppState;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe: (listener: (state: AppState) => void) => () => void;
  setColorMode: (mode: ColorMode) => void;
  /** Cycle light → dark → system → light. */
  cycleColorMode: () => void;
  /** Toggle a folder key's expansion in the allow-list. */
  toggleFolderExpanded: (key: string) => void;
  /**
   * Bulk-add folder keys to the allow-list with a single write. Used by
   * the active-file ancestor auto-expand so a deep chain doesn't issue
   * one mutation per ancestor (and a fully-expanded chain is a no-op).
   */
  expandFolders: (keys: Iterable<string>) => void;
  /** Set a vault id's collapsed state in the deny-list. */
  setVaultCollapsed: (vaultId: string, collapsed: boolean) => void;
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

const DEFAULT_STATE: AppState = {
  colorMode: 'system',
  expandedFolderIds: new Set<string>(),
  collapsedVaultIds: new Set<string>(),
};

function nextColorMode(mode: ColorMode): ColorMode {
  return mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light';
}

function isColorMode(value: unknown): value is ColorMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readPersisted(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  key: string,
): Partial<{ colorMode: ColorMode; expandedFolderIds: string[]; collapsedVaultIds: string[] }> {
  if (!storage) return {};
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const blob = parsed as Record<string, unknown>;
    const out: Partial<{
      colorMode: ColorMode;
      expandedFolderIds: string[];
      collapsedVaultIds: string[];
    }> = {};
    if (isColorMode(blob.colorMode)) out.colorMode = blob.colorMode;
    if ('expandedFolderIds' in blob) out.expandedFolderIds = stringArray(blob.expandedFolderIds);
    if ('collapsedVaultIds' in blob) out.collapsedVaultIds = stringArray(blob.collapsedVaultIds);
    return out;
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
    expandedFolderIds: new Set(persisted.expandedFolderIds ?? []),
    collapsedVaultIds: new Set(persisted.collapsedVaultIds ?? []),
  };

  const listeners = new Set<(state: AppState) => void>();

  function persist(): void {
    if (!storage) return;
    const blob: PersistedState = {
      colorMode: state.colorMode,
      expandedFolderIds: [...state.expandedFolderIds],
      collapsedVaultIds: [...state.collapsedVaultIds],
    };
    try {
      storage.setItem(persistKey, JSON.stringify(blob));
    } catch {
      // Storage may be unavailable (private mode, quota). State stays
      // correct in memory; persistence is best-effort.
    }
  }

  /** Commit `next` as the new state, persist, and notify subscribers. */
  function commit(next: AppState): void {
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
    setColorMode: (mode) => {
      if (mode === state.colorMode) return;
      commit({ ...state, colorMode: mode });
    },
    cycleColorMode: () => commit({ ...state, colorMode: nextColorMode(state.colorMode) }),
    toggleFolderExpanded: (key) => {
      const next = new Set(state.expandedFolderIds);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      commit({ ...state, expandedFolderIds: next });
    },
    expandFolders: (keys) => {
      let next: Set<string> | null = null;
      for (const key of keys) {
        if (state.expandedFolderIds.has(key)) continue;
        if (next === null) next = new Set(state.expandedFolderIds);
        next.add(key);
      }
      if (next === null) return;
      commit({ ...state, expandedFolderIds: next });
    },
    setVaultCollapsed: (vaultId, collapsed) => {
      const present = state.collapsedVaultIds.has(vaultId);
      if (collapsed === present) return;
      const next = new Set(state.collapsedVaultIds);
      if (collapsed) next.add(vaultId);
      else next.delete(vaultId);
      commit({ ...state, collapsedVaultIds: next });
    },
  };
}
