import { encodeVaultPath } from './yjs/demo-document-provider';

/**
 * Transport layer for vault, file, and folder operations. Owns every
 * daemon HTTP route and the daemon error-code → user-facing message
 * mapping. UI packages stay prop-driven; the route knowledge lives here.
 *
 * Every data route is vault-scoped: the caller supplies the active
 * vault's id and this layer builds the `/api/vaults/:id/...` URL. The
 * vault id is the daemon's stable slug (from `GET /api/vaults`).
 */

interface ApiFailure {
  ok: false;
  error?: string;
  message?: string;
}

export interface VaultSummary {
  id: string;
  displayName: string;
}

export interface TreeEntry {
  path: string;
  kind: 'file' | 'folder';
  metadata?: { color?: string; icon?: string | null };
}

export interface VaultInfo {
  rootName: string;
  fileCount: number;
  folderCount: number;
}

export interface SearchHit {
  path: string;
  line: number;
  lineText: string;
  context?: {
    before?: string[];
    after?: string[];
  };
}

/**
 * Maps a daemon service error code to a friendly message. Unknown codes
 * fall back to the raw message the daemon supplied. The optional
 * `context` lets a caller (e.g. vault create) override the wording for
 * codes whose default phrasing is file/folder-centric.
 */
function messageForError(
  code: string | undefined,
  fallback: string | undefined,
  context?: 'vault',
): string {
  if (context === 'vault') {
    switch (code) {
      case 'already_exists':
        // Slug collision: the inferred slug already names a vault. Surface
        // the daemon's specific message when present (it names the slug),
        // otherwise a plain vault-collision sentence.
        return fallback ?? 'A vault with that name already exists.';
      case 'invalid_request':
        return fallback ?? 'That vault name is not allowed.';
      case 'not_found':
        return 'That vault no longer exists.';
      default:
        break;
    }
  }
  switch (code) {
    case 'already_exists':
      return 'A note or folder with that name already exists.';
    case 'invalid_request':
      return fallback ?? 'That request was not valid.';
    case 'path_collision':
      return 'That destination collides with an existing item.';
    case 'folder_not_empty':
      return 'This folder is not empty.';
    case 'not_found':
      return 'That item no longer exists.';
    case 'invalid_path':
      return 'That name contains characters that are not allowed.';
    case 'stale_doc':
      return 'This item changed elsewhere. Try again.';
    case 'ambiguous':
      return 'That operation was ambiguous. Try again.';
    case 'entry_cap_exceeded':
      return 'The vault has too many entries to complete this.';
    case 'too_large_document':
    case 'too_large_splice':
      return 'That document is too large.';
    case 'persist_failed':
      return 'The change could not be saved to disk.';
    default:
      return fallback ?? 'The operation failed.';
  }
}

async function request<T extends { ok: true } = { ok: true }>(
  input: RequestInfo | URL,
  init?: RequestInit,
  context?: 'vault',
): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as T | ApiFailure | null;
  if (!response.ok || !body || body.ok === false) {
    const failure = body && body.ok === false ? body : null;
    throw new Error(messageForError(failure?.error, failure?.message ?? failure?.error, context));
  }
  return body as T;
}

/** Build the scoped data-route prefix for a vault. */
function vaultBase(vaultId: string): string {
  return `/api/vaults/${encodeURIComponent(vaultId)}`;
}

export const kbService = {
  // ---- Vault management ----------------------------------------------

  /** List every vault the daemon serves, in slug order. */
  async listVaults(): Promise<VaultSummary[]> {
    const result = await request<{ ok: true; vaults: VaultSummary[] }>('/api/vaults');
    return result.vaults;
  },

  /**
   * Create a vault from a display name. The daemon infers the slug; a
   * slug collision surfaces as a clean error (the daemon's 409), never a
   * silent failure.
   */
  async createVault(displayName: string): Promise<VaultSummary> {
    const result = await request<{ ok: true; vault: VaultSummary }>(
      '/api/vaults',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      },
      'vault',
    );
    return result.vault;
  },

  /** Rename a vault's display name. The slug/folder stay stable. */
  async renameVault(vaultId: string, displayName: string): Promise<VaultSummary> {
    const result = await request<{ ok: true; vault: VaultSummary }>(
      `/api/vaults/${encodeURIComponent(vaultId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      },
      'vault',
    );
    return result.vault;
  },

  /** Soft-delete a vault (folder to trash, dropped from the live registry). */
  async deleteVault(vaultId: string): Promise<void> {
    await request(
      `/api/vaults/${encodeURIComponent(vaultId)}`,
      { method: 'DELETE' },
      'vault',
    );
  },

  // ---- Vault-scoped data ---------------------------------------------

  async vaultInfo(vaultId: string): Promise<VaultInfo> {
    return request<{ ok: true } & VaultInfo>(`${vaultBase(vaultId)}/vault`);
  },

  async tree(vaultId: string): Promise<TreeEntry[]> {
    const result = await request<{ ok: true; entries: TreeEntry[] }>(`${vaultBase(vaultId)}/tree`);
    return result.entries;
  },

  async search(
    vaultId: string,
    query: string,
    limit = 50,
  ): Promise<{ results: SearchHit[]; total: number; truncated: boolean }> {
    return request<{ ok: true; results: SearchHit[]; total: number; truncated: boolean }>(
      `${vaultBase(vaultId)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  },

  /** Create a note. Writes empty content unless provided; defaults to no overwrite. */
  async createNote(vaultId: string, path: string, content = '', overwrite = false): Promise<void> {
    const query = overwrite ? '?overwrite=true' : '';
    await request(`${vaultBase(vaultId)}/files/${encodeVaultPath(path)}${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: content,
    });
  },

  /** Delete a note. `permanent` skips trash. */
  async deleteNote(vaultId: string, path: string, permanent = false): Promise<void> {
    const query = permanent ? '?permanent=true' : '';
    await request(`${vaultBase(vaultId)}/files/${encodeVaultPath(path)}${query}`, { method: 'DELETE' });
  },

  /** Move (and thereby rename) a note to a new full path. */
  async moveNote(vaultId: string, fromPath: string, toPath: string): Promise<void> {
    await request(`${vaultBase(vaultId)}/files/${encodeVaultPath(fromPath)}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: toPath }),
    });
  },

  /** Create a folder at the given full path. */
  async createFolder(vaultId: string, path: string): Promise<void> {
    await request(`${vaultBase(vaultId)}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  },

  /** Delete a folder and its contents. */
  async deleteFolder(vaultId: string, path: string, permanent = false): Promise<void> {
    const query = permanent ? '?recursive=true&permanent=true' : '?recursive=true';
    await request(`${vaultBase(vaultId)}/folders/${encodeVaultPath(path)}${query}`, { method: 'DELETE' });
  },

  /** Move (and thereby rename) a folder to a new full path. */
  async moveFolder(vaultId: string, fromPath: string, toPath: string): Promise<void> {
    await request(`${vaultBase(vaultId)}/folders/${encodeVaultPath(fromPath)}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: toPath }),
    });
  },
};

export type KbService = typeof kbService;
