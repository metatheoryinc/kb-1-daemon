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

  const normalizedContent = normalizeWithRawOffsets(content);
  const needle = before + oldText + after;
  const matches = findAllSubstringOffsets(normalizedContent.value, needle);
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
  const rawOldOffset = normalizedContent.rawOffsets[oldOffset]!;
  const rawOldEndOffset = normalizedContent.rawOffsets[oldOffset + oldText.length]!;
  const next =
    content.slice(0, rawOldOffset) +
    newText +
    content.slice(rawOldEndOffset);
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
  const insertionPoint = frontmatterInsertionPoint(content) ?? 0;
  const separator = insertionPoint > 0 &&
    normalizedAddition.length > 0 &&
    !endsWithLineEnding(content.slice(0, insertionPoint))
    ? '\n'
    : '';
  return content.slice(0, insertionPoint) + separator + normalizedAddition + content.slice(insertionPoint);
}

function frontmatterInsertionPoint(content: string): number | undefined {
  const opening = /^---(?:\r\n|\n|\r)/.exec(content);
  if (!opening) return undefined;

  let lineStart = opening[0].length;
  while (lineStart < content.length) {
    const lineEnd = nextLineEnd(content, lineStart);
    const line = content.slice(lineStart, lineEnd.contentEnd);
    if (line.trim() === '---') {
      return lineEnd.nextStart;
    }
    lineStart = lineEnd.nextStart;
  }

  // Unterminated frontmatter is treated as ordinary body content.
  return undefined;
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

function normalizeWithRawOffsets(content: string): { value: string; rawOffsets: number[] } {
  let value = '';
  const rawOffsets: number[] = [];
  let rawIndex = 0;

  while (rawIndex < content.length) {
    rawOffsets.push(rawIndex);
    const char = content[rawIndex]!;
    if (char === '\r') {
      value += '\n';
      rawIndex += content[rawIndex + 1] === '\n' ? 2 : 1;
      continue;
    }
    value += char;
    rawIndex += 1;
  }

  rawOffsets.push(content.length);
  return { value, rawOffsets };
}

function nextLineEnd(content: string, lineStart: number): { contentEnd: number; nextStart: number } {
  let index = lineStart;
  while (index < content.length) {
    const char = content[index]!;
    if (char === '\n') {
      return { contentEnd: index, nextStart: index + 1 };
    }
    if (char === '\r') {
      return {
        contentEnd: index,
        nextStart: content[index + 1] === '\n' ? index + 2 : index + 1
      };
    }
    index += 1;
  }
  return { contentEnd: content.length, nextStart: content.length };
}

function endsWithLineEnding(value: string): boolean {
  return value.endsWith('\n') || value.endsWith('\r');
}
