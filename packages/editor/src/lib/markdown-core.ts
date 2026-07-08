const MENTION_URL_SCHEME = 'mention:' as const;

interface MentionParts {
  email: string;
}

export function parseMentionUrl(href: string): MentionParts | null {
  if (!href.startsWith(MENTION_URL_SCHEME)) return null;
  const payload = href.slice(MENTION_URL_SCHEME.length);
  if (payload.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    return null;
  }
  const atIdx = decoded.indexOf('@');
  if (atIdx === -1) return null;
  if (decoded.includes('@', atIdx + 1)) return null;
  const local = decoded.slice(0, atIdx);
  const domain = decoded.slice(atIdx + 1);
  if (local.length === 0 || domain.length === 0) return null;
  return { email: decoded };
}

export interface OrgPerson {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export function resolvePerson(
  email: string,
  orgPeople: readonly OrgPerson[],
): OrgPerson | null {
  const target = email.toLowerCase();
  for (const person of orgPeople) {
    if (person.email.toLowerCase() === target) return person;
  }
  return null;
}

export interface WikilinkParts {
  target: string;
  heading: string;
  alias?: string;
}

export function parseWikilinkInner(inner: string): WikilinkParts | null {
  const pipeIdx = inner.indexOf('|');
  let targetAndHeading: string;
  let alias: string | undefined;
  if (pipeIdx === -1) {
    targetAndHeading = inner;
  } else {
    targetAndHeading = inner.slice(0, pipeIdx);
    const rawAlias = inner.slice(pipeIdx + 1).trim();
    alias = rawAlias.length === 0 ? undefined : rawAlias;
  }
  const hashIdx = targetAndHeading.indexOf('#');
  let target: string;
  let heading: string;
  if (hashIdx === -1) {
    target = targetAndHeading.trim();
    heading = '';
  } else {
    target = targetAndHeading.slice(0, hashIdx).trim();
    heading = targetAndHeading.slice(hashIdx + 1).trim();
  }
  if (target.length === 0) return null;
  return alias === undefined ? { target, heading } : { target, heading, alias };
}

export interface LivePath {
  path: string;
  noteId: string;
}

const RESOLVABLE_EXTENSIONS = ['.md', '.txt'] as const;

function basenameNoExt(path: string): string {
  const slashIdx = path.lastIndexOf('/');
  const base = slashIdx === -1 ? path : path.slice(slashIdx + 1);
  return stripEditorExtension(base);
}

function stripEditorExtension(s: string): string {
  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (s.endsWith(ext)) return s.slice(0, -ext.length);
  }
  return s;
}

export function resolveLinkTarget(params: {
  raw: string;
  livePaths: readonly LivePath[];
}): LivePath | null {
  const { raw, livePaths } = params;
  for (const candidate of livePaths) {
    if (candidate.path === raw) return candidate;
    for (const ext of RESOLVABLE_EXTENSIONS) {
      if (candidate.path === `${raw}${ext}`) return candidate;
    }
  }

  const rawNoExt = stripEditorExtension(raw);
  const target = rawNoExt.toLowerCase();
  let sole: LivePath | null = null;
  let multiple = false;
  for (const candidate of livePaths) {
    if (basenameNoExt(candidate.path).toLowerCase() === target) {
      if (sole === null) {
        sole = candidate;
      } else {
        multiple = true;
        break;
      }
    }
  }
  if (sole !== null && !multiple) return sole;

  if (rawNoExt.includes('/')) {
    sole = null;
    multiple = false;
    for (const candidate of livePaths) {
      let hit = false;
      for (const ext of RESOLVABLE_EXTENSIONS) {
        const withExt = `${rawNoExt}${ext}`;
        if (candidate.path === withExt || candidate.path.endsWith(`/${withExt}`)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        if (sole === null) {
          sole = candidate;
        } else {
          multiple = true;
          break;
        }
      }
    }
    if (sole !== null && !multiple) return sole;
  }

  return null;
}
