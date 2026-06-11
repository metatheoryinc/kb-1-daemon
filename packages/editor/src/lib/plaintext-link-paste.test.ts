import { describe, expect, it } from 'vitest';

import { linkPasteMarkdown, noteLinkLabel } from './plaintext-link-paste';

describe('noteLinkLabel', () => {
  it('extracts the filename stem from an org vault note URL', () => {
    const url = new URL(
      'http://localhost:8797/app/org/dev-org/vault/dev-vault/projects/my-research.md',
    );
    expect(noteLinkLabel(url)).toBe('my-research');
  });

  it('handles private and public vault shapes', () => {
    expect(
      noteLinkLabel(new URL('https://kb.example.com/app/private/vault/kb-1/idea.md')),
    ).toBe('idea');
    expect(
      noteLinkLabel(new URL('https://kb.example.com/app/public/vault/kb-1/README.md')),
    ).toBe('README');
  });

  it('decodes percent-encoded path segments', () => {
    const url = new URL(
      'http://localhost:8797/app/org/dev-org/vault/dev-vault/meeting%20notes.md',
    );
    expect(noteLinkLabel(url)).toBe('meeting notes');
  });

  it('returns null for vault roots and folders (no dot in last segment)', () => {
    expect(
      noteLinkLabel(new URL('http://localhost:8797/app/org/dev-org/vault/dev-vault')),
    ).toBeNull();
    expect(
      noteLinkLabel(
        new URL('http://localhost:8797/app/org/dev-org/vault/dev-vault/projects'),
      ),
    ).toBeNull();
  });

  it('returns null for non-vault app routes and external URLs', () => {
    expect(
      noteLinkLabel(new URL('http://localhost:8797/app/settings')),
    ).toBeNull();
    expect(noteLinkLabel(new URL('https://example.com/some/page.html'))).toBeNull();
  });
});

describe('linkPasteMarkdown', () => {
  const noteUrl =
    'http://localhost:8797/app/org/dev-org/vault/dev-vault/projects/my-research.md';

  it('inserts [note name](url) for a kb-1 note URL with no selection', () => {
    expect(linkPasteMarkdown(noteUrl, '')).toBe(`[my-research](${noteUrl})`);
  });

  it('tolerates surrounding whitespace from the clipboard', () => {
    expect(linkPasteMarkdown(`${noteUrl}\n`, '')).toBe(
      `[my-research](${noteUrl})`,
    );
  });

  it('wraps a selection for any URL, not just note URLs', () => {
    expect(linkPasteMarkdown('https://example.com/docs', 'the docs')).toBe(
      '[the docs](https://example.com/docs)',
    );
    expect(linkPasteMarkdown(noteUrl, 'my research note')).toBe(
      `[my research note](${noteUrl})`,
    );
  });

  it('falls through for an external URL with no selection', () => {
    expect(linkPasteMarkdown('https://example.com/docs', '')).toBeNull();
  });

  it('falls through for non-URL pastes', () => {
    expect(linkPasteMarkdown('just some text', 'selected')).toBeNull();
    expect(linkPasteMarkdown('not a url with spaces', '')).toBeNull();
  });

  it('falls through for non-http(s) schemes', () => {
    expect(linkPasteMarkdown('ftp://example.com/file', 'label')).toBeNull();
    expect(linkPasteMarkdown('javascript:alert(1)', 'label')).toBeNull();
  });

  it('replaces (does not wrap) a selection that is itself a URL', () => {
    expect(
      linkPasteMarkdown('https://example.com/new', 'https://example.com/old'),
    ).toBeNull();
  });

  it('falls through for multi-line selections', () => {
    expect(
      linkPasteMarkdown('https://example.com', 'line one\nline two'),
    ).toBeNull();
  });

  it('falls through for multi-line clipboard text containing a URL', () => {
    expect(
      linkPasteMarkdown('check this:\nhttps://example.com', 'label'),
    ).toBeNull();
  });

  it('escapes markdown-significant characters in the label', () => {
    expect(
      linkPasteMarkdown('https://example.com/docs', 'see [this] \\ that'),
    ).toBe('[see \\[this\\] \\\\ that](https://example.com/docs)');
  });

  it('percent-encodes parens in the destination so the link parses', () => {
    const parenUrl =
      'http://localhost:8797/app/org/dev-org/vault/dev-vault/plan%20(draft).md';
    expect(linkPasteMarkdown(parenUrl, '')).toBe(
      '[plan (draft)](http://localhost:8797/app/org/dev-org/vault/dev-vault/plan%20%28draft%29.md)',
    );
  });
});
