import { encodeVaultPath } from './yjs/demo-document-provider';

/**
 * Transport layer for vault file/folder/vault operations. Owns every
 * daemon HTTP route and the daemon error-code → user-facing message
 * mapping. UI packages stay prop-driven; the route knowledge lives here.
 */

interface ApiFailure {
  ok: false;
  error?: string;
  message?: string;
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
 * fall back to the raw message the daemon supplied.
 */
function messageForError(code: string | undefined, fallback: string | undefined): string {
  switch (code) {
    case 'already_exists':
      return 'A note or folder with that name already exists.';
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
): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as T | ApiFailure | null;
  if (!response.ok || !body || body.ok === false) {
    const failure = body && body.ok === false ? body : null;
    throw new Error(messageForError(failure?.error, failure?.message ?? failure?.error));
  }
  return body as T;
}

export const kbService = {
  async vaultInfo(): Promise<VaultInfo> {
    return request<{ ok: true } & VaultInfo>('/api/vault');
  },

  async tree(): Promise<TreeEntry[]> {
    const result = await request<{ ok: true; entries: TreeEntry[] }>('/api/tree');
    return result.entries;
  },

  async search(query: string, limit = 50): Promise<{ results: SearchHit[]; total: number; truncated: boolean }> {
    return request<{ ok: true; results: SearchHit[]; total: number; truncated: boolean }>(
      `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  },

  /** Create a note. Writes empty content unless provided; defaults to no overwrite. */
  async createNote(path: string, content = '', overwrite = false): Promise<void> {
    const query = overwrite ? '?overwrite=true' : '';
    await request(`/api/files/${encodeVaultPath(path)}${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown' },
      body: content,
    });
  },

  /** Delete a note. `permanent` skips trash. */
  async deleteNote(path: string, permanent = false): Promise<void> {
    const query = permanent ? '?permanent=true' : '';
    await request(`/api/files/${encodeVaultPath(path)}${query}`, { method: 'DELETE' });
  },

  /** Move (and thereby rename) a note to a new full path. */
  async moveNote(fromPath: string, toPath: string): Promise<void> {
    await request(`/api/files/${encodeVaultPath(fromPath)}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: toPath }),
    });
  },

  /** Create a folder at the given full path. */
  async createFolder(path: string): Promise<void> {
    await request('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  },

  /** Delete a folder and its contents. */
  async deleteFolder(path: string, permanent = false): Promise<void> {
    const query = permanent ? '?recursive=true&permanent=true' : '?recursive=true';
    await request(`/api/folders/${encodeVaultPath(path)}${query}`, { method: 'DELETE' });
  },

  /** Move (and thereby rename) a folder to a new full path. */
  async moveFolder(fromPath: string, toPath: string): Promise<void> {
    await request(`/api/folders/${encodeVaultPath(fromPath)}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: toPath }),
    });
  },
};

export type KbService = typeof kbService;
