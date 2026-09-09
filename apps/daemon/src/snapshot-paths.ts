import { createHash } from 'node:crypto';
import { extname } from 'node:path';

const ENCODED_SEGMENT_PREFIX = '~kb1-';
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"\\|?*\u0000-\u001f]/;

/** ZIP paths are always relative POSIX paths, including on Windows. */
export function assertSafeSnapshotPath(path: string): void {
  if (path.includes('\\') || path.includes('\0') || path.split('/').some(
    (segment) => segment.length === 0 || segment === '.' || segment === '..',
  )) {
    throw new Error(`Unsafe snapshot path: ${JSON.stringify(path)}`);
  }
}

export function isPortableSnapshotSegment(segment: string): boolean {
  return !WINDOWS_INVALID_CHARACTER.test(segment)
    && !/[. ]$/.test(segment)
    && !WINDOWS_RESERVED_BASENAME.test(segment);
}

/**
 * Map only incompatible names and case/Unicode collisions. ZIP still owns
 * compression and parsing; this is the archive's path-to-original-name glue.
 * A reserved prefix keeps a customer's literal name from impersonating a
 * generated name. Original paths, not hashes, are the restore authority.
 */
export function portableSnapshotPaths(paths: string[]): Map<string, string> {
  const children = new Map<string, Set<string>>();
  const declared = new Set<string>();
  for (const path of paths) {
    assertSafeSnapshotPath(path);
    if (declared.has(path)) throw new Error(`Duplicate snapshot path: ${path}`);
    declared.add(path);
    let parent = '';
    for (const segment of path.split('/')) {
      const siblings = children.get(parent) ?? new Set<string>();
      siblings.add(segment);
      children.set(parent, siblings);
      parent = parent ? `${parent}/${segment}` : segment;
    }
  }

  const mapped = new Map<string, string>();
  const visit = (parent: string, mappedParent: string): void => {
    const siblings = [...(children.get(parent) ?? [])].sort();
    const counts = new Map<string, number>();
    for (const segment of siblings) {
      const key = portableKey(segment);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const used = new Set<string>();
    for (const segment of siblings) {
      const needsMapping = !isPortableSnapshotSegment(segment)
        || (counts.get(portableKey(segment)) ?? 0) > 1
        || segment.toLowerCase().startsWith(ENCODED_SEGMENT_PREFIX);
      const extension = extname(segment);
      const portable = needsMapping
        ? `${ENCODED_SEGMENT_PREFIX}${createHash('sha256').update(segment).digest('hex')}${/^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : ''}`
        : segment;
      const key = portableKey(portable);
      if (used.has(key)) throw new Error('Snapshot name mapping produced a collision.');
      used.add(key);
      const originalPath = parent ? `${parent}/${segment}` : segment;
      const mappedPath = mappedParent ? `${mappedParent}/${portable}` : portable;
      mapped.set(originalPath, mappedPath);
      visit(originalPath, mappedPath);
    }
  };
  visit('', '');
  return mapped;
}

function portableKey(segment: string): string {
  return segment.normalize('NFC').toLocaleLowerCase('en-US');
}
