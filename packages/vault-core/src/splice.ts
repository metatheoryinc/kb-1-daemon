import matter from 'gray-matter';

export const SPLICE_BYTES_LIMIT = 64 * 1024;
export const DOCUMENT_BYTES_LIMIT = 1024 * 1024;

export interface AnchoredSpliceRequest {
  oldText: string;
  newText: string;
  before?: string;
  after?: string;
  occurrence?: number;
}

export type AnchoredSpliceResult =
  | { ok: true; content: string }
  | { ok: false; rejected: 'not_found' }
  | { ok: false; rejected: 'ambiguous'; match_count: number }
  | { ok: false; rejected: 'too_large_splice'; limit_bytes: number }
  | {
      ok: false;
      rejected: 'too_large_document';
      current_bytes: number;
      limit_bytes: number;
    };

export function applyAnchoredSplice(
  content: string,
  request: AnchoredSpliceRequest
): AnchoredSpliceResult {
  const oldText = lfNormalize(request.oldText);
  const newText = lfNormalize(request.newText);
  const before = request.before === undefined ? '' : lfNormalize(request.before);
  const after = request.after === undefined ? '' : lfNormalize(request.after);

  if (
    utf8ByteLength(oldText) > SPLICE_BYTES_LIMIT ||
    utf8ByteLength(newText) > SPLICE_BYTES_LIMIT
  ) {
    return {
      ok: false,
      rejected: 'too_large_splice',
      limit_bytes: SPLICE_BYTES_LIMIT
    };
  }

  const needle = before + oldText + after;
  const matches = findAllSubstringOffsets(content, needle);
  if (matches.length === 0) return { ok: false, rejected: 'not_found' };

  let matchOffset: number;
  if (matches.length === 1) {
    matchOffset = matches[0]!;
  } else if (request.occurrence !== undefined) {
    const picked = matches[request.occurrence - 1];
    if (picked === undefined) return { ok: false, rejected: 'not_found' };
    matchOffset = picked;
  } else {
    return {
      ok: false,
      rejected: 'ambiguous',
      match_count: matches.length
    };
  }

  const oldOffset = matchOffset + before.length;
  const next =
    content.slice(0, oldOffset) +
    newText +
    content.slice(oldOffset + oldText.length);
  const nextBytes = utf8ByteLength(next);
  if (nextBytes > DOCUMENT_BYTES_LIMIT) {
    return {
      ok: false,
      rejected: 'too_large_document',
      current_bytes: nextBytes,
      limit_bytes: DOCUMENT_BYTES_LIMIT
    };
  }

  return { ok: true, content: next };
}

export function appendContent(content: string, addition: string): string {
  return content + lfNormalize(addition);
}

export function prependContent(content: string, addition: string): string {
  const normalizedAddition = lfNormalize(addition);
  const parsed = matter(content);
  const insertionPoint = matter.test(content)
    ? content.length - parsed.content.length
    : 0;
  return content.slice(0, insertionPoint) + normalizedAddition + content.slice(insertionPoint);
}

export function lfNormalize(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function findAllSubstringOffsets(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const offsets: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    offsets.push(at);
    from = at + 1;
  }
  return offsets;
}
