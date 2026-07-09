import path from 'node:path';

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const INTERNAL_VAULT_PATH_SEGMENTS = new Set([
  '.git',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  '.kb1',
]);

type VaultPathKind = 'file' | 'folder' | 'artifact';

export class InvalidPathError extends Error {
  constructor(public readonly input: string, public readonly reason: string) {
    super(`Invalid vault path "${input}": ${reason}`);
    this.name = 'InvalidPathError';
  }
}

export function validateVaultPath(input: string, kind: VaultPathKind): string {
  if (typeof input !== 'string') {
    throw new InvalidPathError(String(input), 'path must be a string');
  }
  if (input.length === 0) {
    throw new InvalidPathError(input, 'path is empty');
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new InvalidPathError(input, `path exceeds ${MAX_PATH_LENGTH} chars`);
  }
  if (input.includes('\\')) {
    throw new InvalidPathError(input, 'path must use forward slashes');
  }
  if (path.posix.isAbsolute(input) || path.isAbsolute(input)) {
    throw new InvalidPathError(input, 'path must be vault-relative');
  }
  if (input.startsWith('/') || input.endsWith('/')) {
    throw new InvalidPathError(input, 'path must not start or end with "/"');
  }

  const segments = input.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new InvalidPathError(input, 'path contains an empty segment');
    }
    if (segment === '.' || segment === '..') {
      throw new InvalidPathError(input, 'path must not contain "." or ".." segments');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new InvalidPathError(input, `segment exceeds ${MAX_SEGMENT_LENGTH} chars`);
    }
    if (INTERNAL_VAULT_PATH_SEGMENTS.has(segment)) {
      throw new InvalidPathError(input, `${segment} is reserved for vault metadata`);
    }
  }

  if (kind === 'file') {
    const filename = segments[segments.length - 1]!;
    const dot = filename.indexOf('.');
    if (dot <= 0 || dot === filename.length - 1) {
      throw new InvalidPathError(input, 'file paths must end in name.ext');
    }
  }

  return input;
}

export function validateOptionalVaultPath(input: string | undefined, kind: VaultPathKind): string | undefined {
  if (input === undefined || input.length === 0) return undefined;
  return validateVaultPath(input, kind);
}

export function isInternalVaultPath(input: string): boolean {
  if (input.length === 0) return false;
  return input.split('/').some((segment) => INTERNAL_VAULT_PATH_SEGMENTS.has(segment));
}

export function relativeDescendantPath(parent: string, child: string): string | null {
  if (child === parent) return '';
  const prefix = `${parent}/`;
  return child.startsWith(prefix) ? child.slice(prefix.length) : null;
}

export function resolveVaultPath(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  /* v8 ignore next -- Public operations validate away traversal before resolution; this is a second containment guard for future call sites. */
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new InvalidPathError(relPath, 'path escapes vault root');
  }
  return resolved;
}
