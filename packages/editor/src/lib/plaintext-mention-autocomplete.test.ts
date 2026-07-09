import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { OrgPerson } from './markdown-core';
import { plaintextDecorations } from './plaintext-decorations';
import {
  TRIGGER_RE,
  formatMentionInsertion,
  getQueryRange,
  isInsideMentionLink,
} from './plaintext-mention-autocomplete-helpers';

function makeState(doc: string, cursor: number) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [plaintextDecorations()],
  });
}

describe('TRIGGER_RE', () => {
  it('matches a bare `@` at start of line', () => {
    expect(TRIGGER_RE.exec('@')).not.toBeNull();
  });

  it('matches `@alice` after whitespace', () => {
    const match = TRIGGER_RE.exec('hi @alice');
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe('alice');
  });

  it('matches an empty query immediately after a space', () => {
    const match = TRIGGER_RE.exec('hi @');
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe('');
  });

  it('does not match mid-word `foo@bar`', () => {
    expect(TRIGGER_RE.exec('foo@bar')).toBeNull();
  });

  it('does not match when there is whitespace inside the query', () => {
    expect(TRIGGER_RE.exec('@ali ce')).toBeNull();
  });
});

describe('getQueryRange', () => {
  it('extracts the right range for `@<query>` at start of line', () => {
    const doc = '@alice';
    const range = getQueryRange(makeState(doc, doc.length));
    expect(range).not.toBeNull();
    expect(range?.from).toBe(0);
    expect(range?.to).toBe(doc.length);
    expect(range?.query).toBe('alice');
  });

  it('extracts the right range after leading text + space', () => {
    const doc = 'hi @bob';
    const range = getQueryRange(makeState(doc, doc.length));
    expect(range).not.toBeNull();
    expect(range?.from).toBe(doc.indexOf('@'));
    expect(range?.to).toBe(doc.length);
    expect(range?.query).toBe('bob');
  });

  it('returns the `@` position when query is empty', () => {
    const doc = 'hi @';
    const range = getQueryRange(makeState(doc, doc.length));
    expect(range).not.toBeNull();
    expect(range?.from).toBe(doc.indexOf('@'));
    expect(range?.to).toBe(doc.length);
    expect(range?.query).toBe('');
  });

  it('returns null when the caret is mid-word adjacent to `@`', () => {
    const doc = 'foo@bar';
    expect(getQueryRange(makeState(doc, doc.length))).toBeNull();
  });

  it('returns null when the selection is non-empty', () => {
    const doc = '@alice';
    const state = EditorState.create({
      doc,
      selection: EditorSelection.range(0, 3),
      extensions: [plaintextDecorations()],
    });
    expect(getQueryRange(state)).toBeNull();
  });

  it('respects per-line scope', () => {
    const doc = 'first line\n@alice';
    const range = getQueryRange(makeState(doc, doc.length));
    expect(range).not.toBeNull();
    expect(range?.from).toBe(doc.indexOf('@'));
    expect(range?.query).toBe('alice');
  });
});

describe('isInsideMentionLink', () => {
  it('returns true when the caret is inside an existing mention chip', () => {
    const doc = '[Alice](mention:alice@kb-1.dev)';
    expect(isInsideMentionLink(makeState(doc, 3), 3)).toBe(true);
  });

  it('returns false in plain text far from any mention', () => {
    const doc = 'just some plain text';
    expect(isInsideMentionLink(makeState(doc, 5), 5)).toBe(false);
  });

  it('returns false inside a non-mention link', () => {
    const doc = '[Anthropic](https://anthropic.com)';
    expect(isInsideMentionLink(makeState(doc, 3), 3)).toBe(false);
  });
});

describe('formatMentionInsertion', () => {
  const alice: OrgPerson = {
    id: 'user-alice',
    email: 'alice@kb-1.dev',
    name: 'Alice',
    image: null,
  };

  it('produces `[Name](mention:email) ` with the trailing space', () => {
    expect(formatMentionInsertion(alice)).toBe(
      '[Alice](mention:alice@kb-1.dev) ',
    );
  });

  it('ends with exactly one space', () => {
    const out = formatMentionInsertion(alice);
    expect(out.endsWith(') ')).toBe(true);
    expect(out.endsWith(')  ')).toBe(false);
  });

  it('encodes unsafe email characters while keeping `@` readable', () => {
    const person: OrgPerson = {
      id: 'user-percent',
      email: 'foo%bar@kb-1.dev',
      name: 'Percent',
      image: null,
    };
    expect(formatMentionInsertion(person)).toBe(
      '[Percent](mention:foo%25bar@kb-1.dev) ',
    );
  });
});
