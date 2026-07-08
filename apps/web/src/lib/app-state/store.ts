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

/**
 * A pinned note or folder. `path` is the vault-relative path; `addedAt`
 * captures the toggle moment so the starred panel can sort
 * most-recently-starred first. `vaultId` is carried for shape fidelity
 * and future multi-vault work even though the local shell has one vault.
 */
export interface FavoriteEntry {
  kind: 'note' | 'folder';
  vaultId: string;
  path: string;
  addedAt: number;
}

/** Identity of a favorite, independent of `addedAt`. */
function favoriteKey(e: Pick<FavoriteEntry, 'kind' | 'vaultId' | 'path'>): string {
  return `${e.kind}:${e.vaultId}:${e.path}`;
}

/** Default persistence slot for KB-1 app chrome preferences. */
export const DEFAULT_PERSIST_KEY = 'kb1:app-state';

/**
 * Secondary (files) rail width bounds, in px. The setter clamps every
 * incoming value to this range and the rehydrate path defensively
 * re-clamps any out-of-range persisted blob, so consumers never have to
 * clamp themselves.
 */
const SECONDARY_RAIL_WIDTH_MIN = 240;
const SECONDARY_RAIL_WIDTH_MAX = 564;
const SECONDARY_RAIL_WIDTH_DEFAULT = 282;

function clampSecondaryRailWidth(width: number): number {
  if (!Number.isFinite(width)) return SECONDARY_RAIL_WIDTH_DEFAULT;
  if (width < SECONDARY_RAIL_WIDTH_MIN) return SECONDARY_RAIL_WIDTH_MIN;
  if (width > SECONDARY_RAIL_WIDTH_MAX) return SECONDARY_RAIL_WIDTH_MAX;
  return Math.round(width);
}

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
  /** Deny-list of hidden vault ids. Empty means "nothing hidden". */
  hiddenVaultIds: string[];
  /** Secondary (files) rail width in px. */
  secondaryRailWidth: number;
  /** Whether the primary icon rail is collapsed to icon-only width. */
  railCollapsed: boolean;
  /** Pinned notes/folders. Persisted verbatim — see {@link FavoriteEntry}. */
  favorites: FavoriteEntry[];
  /**
   * The vault the user last had open (its slug), or `null` if none yet.
   * First load reopens this vault; switching vaults updates it. There is
   * no "default vault" — this is purely the remembered last-opened.
   */
  lastOpenedVaultId: string | null;
}

/** The live, in-memory app state. Mirrors the persisted slice plus actions. */
interface AppState {
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
  /**
   * Per-vault visibility filter — deny-list semantics. A vault id here
   * is hidden from the files tree; the default `[]` means "everything
   * visible." Stored sorted so the persisted JSON is stable across
   * toggles that end at the same logical set.
   */
  hiddenVaultIds: string[];
  /**
   * Secondary (files) rail width in px. Always clamped to
   * [{@link SECONDARY_RAIL_WIDTH_MIN}, {@link SECONDARY_RAIL_WIDTH_MAX}].
   */
  secondaryRailWidth: number;
  /**
   * Whether the primary icon rail is collapsed to icon-only width.
   * Persisted so the rail's width survives reload. The brand mark at
   * the top of the rail toggles it.
   */
  railCollapsed: boolean;
  /**
   * Pinned notes/folders, persisted to localStorage. Ordered as
   * inserted; the starred panel sorts by `addedAt` for display.
   */
  favorites: FavoriteEntry[];
  /**
   * The slug of the vault the user last opened, or `null` if none. First
   * load reopens it (else the first vault in the list). NOT a default
   * vault — just the remembered last-opened.
   */
  lastOpenedVaultId: string | null;
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
  /** Toggle a vault id's presence in the visibility hide-list. */
  toggleVaultHidden: (vaultId: string) => void;
  /** Set the secondary rail width. Clamps to the sane range. */
  setSecondaryRailWidth: (width: number) => void;
  /** Toggle the primary rail between collapsed (icon-only) and expanded. */
  toggleRailCollapsed: () => void;
  /** Set the primary rail's collapsed state directly. */
  setRailCollapsed: (collapsed: boolean) => void;
  /**
   * Remember the vault the user is now in (its slug). `null` forgets the
   * last-opened (e.g. the last vault was deleted). First load reopens
   * this; switching vaults updates it.
   */
  setLastOpenedVaultId: (vaultId: string | null) => void;
  /**
   * Star/unstar a note or folder. Adds the entry (stamped with
   * `addedAt`) when absent, removes it when present.
   */
  toggleFavorite: (entry: Pick<FavoriteEntry, 'kind' | 'vaultId' | 'path'>) => void;
  /** Remove a favorite by identity. No-op when absent. */
  removeFavorite: (entry: Pick<FavoriteEntry, 'kind' | 'vaultId' | 'path'>) => void;
  /** Note deleted — exact-match removal of that note's favorite. */
  favoritesOnNoteDeleted: (vaultId: string, path: string) => void;
  /** Note renamed/moved — exact-match rewrite of that note's path. */
  favoritesOnNoteRenamed: (vaultId: string, oldPath: string, newPath: string) => void;
  /** Folder deleted — drop the folder favorite and every descendant. */
  favoritesOnFolderDeleted: (vaultId: string, path: string) => void;
  /**
   * Folder renamed/moved — rewrite the folder favorite itself plus any
   * descendant note/folder entries so pinned paths survive the move.
   */
  favoritesOnFolderRenamed: (vaultId: string, oldPath: string, newPath: string) => void;
}

interface CreateAppStateOptions {
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
  hiddenVaultIds: [],
  secondaryRailWidth: SECONDARY_RAIL_WIDTH_DEFAULT,
  railCollapsed: true,
  favorites: [],
  lastOpenedVaultId: null,
};

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function nextColorMode(mode: ColorMode): ColorMode {
  return mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light';
}

function isColorMode(value: unknown): value is ColorMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Parse a persisted favorites array, dropping any malformed entries. */
function favoriteArray(value: unknown): FavoriteEntry[] {
  if (!Array.isArray(value)) return [];
  const out: FavoriteEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (e.kind !== 'note' && e.kind !== 'folder') continue;
    if (typeof e.vaultId !== 'string' || typeof e.path !== 'string') continue;
    out.push({
      kind: e.kind,
      vaultId: e.vaultId,
      path: e.path,
      addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
    });
  }
  return out;
}

interface PersistedSlice {
  colorMode: ColorMode;
  expandedFolderIds: string[];
  collapsedVaultIds: string[];
  hiddenVaultIds: string[];
  secondaryRailWidth: number;
  railCollapsed: boolean;
  favorites: FavoriteEntry[];
  lastOpenedVaultId: string | null;
}

function readPersisted(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  key: string,
): Partial<PersistedSlice> {
  if (!storage) return {};
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const blob = parsed as Record<string, unknown>;
    const out: Partial<PersistedSlice> = {};
    if (isColorMode(blob.colorMode)) out.colorMode = blob.colorMode;
    if ('expandedFolderIds' in blob) out.expandedFolderIds = stringArray(blob.expandedFolderIds);
    if ('collapsedVaultIds' in blob) out.collapsedVaultIds = stringArray(blob.collapsedVaultIds);
    if ('hiddenVaultIds' in blob) out.hiddenVaultIds = stringArray(blob.hiddenVaultIds);
    if (typeof blob.secondaryRailWidth === 'number') {
      // Defensively re-clamp any out-of-range persisted width.
      out.secondaryRailWidth = clampSecondaryRailWidth(blob.secondaryRailWidth);
    }
    if (typeof blob.railCollapsed === 'boolean') out.railCollapsed = blob.railCollapsed;
    if ('favorites' in blob) out.favorites = favoriteArray(blob.favorites);
    if (typeof blob.lastOpenedVaultId === 'string') out.lastOpenedVaultId = blob.lastOpenedVaultId;
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
    hiddenVaultIds: sortedIds(persisted.hiddenVaultIds ?? []),
    secondaryRailWidth: persisted.secondaryRailWidth ?? DEFAULT_STATE.secondaryRailWidth,
    railCollapsed: persisted.railCollapsed ?? DEFAULT_STATE.railCollapsed,
    favorites: persisted.favorites ?? [],
    lastOpenedVaultId: persisted.lastOpenedVaultId ?? DEFAULT_STATE.lastOpenedVaultId,
  };

  const listeners = new Set<(state: AppState) => void>();

  function persist(): void {
    if (!storage) return;
    const blob: PersistedState = {
      colorMode: state.colorMode,
      expandedFolderIds: [...state.expandedFolderIds],
      collapsedVaultIds: [...state.collapsedVaultIds],
      hiddenVaultIds: state.hiddenVaultIds,
      secondaryRailWidth: state.secondaryRailWidth,
      railCollapsed: state.railCollapsed,
      favorites: state.favorites,
      lastOpenedVaultId: state.lastOpenedVaultId,
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
    toggleVaultHidden: (vaultId) => {
      const hidden = state.hiddenVaultIds.includes(vaultId);
      const next = hidden
        ? state.hiddenVaultIds.filter((id) => id !== vaultId)
        : sortedIds([...state.hiddenVaultIds, vaultId]);
      commit({ ...state, hiddenVaultIds: next });
    },
    setSecondaryRailWidth: (width) => {
      const clamped = clampSecondaryRailWidth(width);
      if (clamped === state.secondaryRailWidth) return;
      commit({ ...state, secondaryRailWidth: clamped });
    },
    toggleRailCollapsed: () => commit({ ...state, railCollapsed: !state.railCollapsed }),
    setRailCollapsed: (collapsed) => {
      if (collapsed === state.railCollapsed) return;
      commit({ ...state, railCollapsed: collapsed });
    },
    setLastOpenedVaultId: (vaultId) => {
      if (vaultId === state.lastOpenedVaultId) return;
      commit({ ...state, lastOpenedVaultId: vaultId });
    },
    toggleFavorite: (entry) => {
      const target = favoriteKey(entry);
      const idx = state.favorites.findIndex((e) => favoriteKey(e) === target);
      if (idx >= 0) {
        const next = state.favorites.slice();
        next.splice(idx, 1);
        commit({ ...state, favorites: next });
        return;
      }
      commit({
        ...state,
        favorites: [
          ...state.favorites,
          { kind: entry.kind, vaultId: entry.vaultId, path: entry.path, addedAt: Date.now() },
        ],
      });
    },
    removeFavorite: (entry) => {
      const target = favoriteKey(entry);
      if (!state.favorites.some((e) => favoriteKey(e) === target)) return;
      commit({ ...state, favorites: state.favorites.filter((e) => favoriteKey(e) !== target) });
    },
    favoritesOnNoteDeleted: (vaultId, path) => {
      const next = state.favorites.filter(
        (e) => !(e.kind === 'note' && e.vaultId === vaultId && e.path === path),
      );
      if (next.length === state.favorites.length) return;
      commit({ ...state, favorites: next });
    },
    favoritesOnNoteRenamed: (vaultId, oldPath, newPath) => {
      if (oldPath === newPath) return;
      let changed = false;
      const next = state.favorites.map((e) => {
        if (e.kind === 'note' && e.vaultId === vaultId && e.path === oldPath) {
          changed = true;
          return { ...e, path: newPath };
        }
        return e;
      });
      if (!changed) return;
      commit({ ...state, favorites: next });
    },
    favoritesOnFolderDeleted: (vaultId, path) => {
      const prefix = `${path}/`;
      const next = state.favorites.filter((e) => {
        if (e.vaultId !== vaultId) return true;
        if (e.path === path && e.kind === 'folder') return false;
        if (e.path.startsWith(prefix)) return false;
        return true;
      });
      if (next.length === state.favorites.length) return;
      commit({ ...state, favorites: next });
    },
    favoritesOnFolderRenamed: (vaultId, oldPath, newPath) => {
      if (oldPath === newPath) return;
      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${newPath}/`;
      let changed = false;
      const next = state.favorites.map((e) => {
        if (e.vaultId !== vaultId) return e;
        if (e.kind === 'folder' && e.path === oldPath) {
          changed = true;
          return { ...e, path: newPath };
        }
        if (e.path.startsWith(oldPrefix)) {
          changed = true;
          return { ...e, path: newPrefix + e.path.slice(oldPrefix.length) };
        }
        return e;
      });
      if (!changed) return;
      commit({ ...state, favorites: next });
    },
  };
}
