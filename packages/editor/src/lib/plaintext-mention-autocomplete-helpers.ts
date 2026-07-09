import type { EditorState } from '@codemirror/state';
import { formatMentionUrl, type OrgPerson } from './markdown-core';
import { findMentionAt } from './plaintext-mention-keymap';

/** Pattern: `@` preceded by start-of-line or whitespace, then non-whitespace query chars. */
export const TRIGGER_RE = /(^|[\s])@([^\s]*)$/;

export function getQueryRange(
  state: EditorState,
): { query: string; from: number; to: number } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const cursor = sel.head;
  const line = state.doc.lineAt(cursor);
  const textBefore = state.sliceDoc(line.from, cursor);
  const match = TRIGGER_RE.exec(textBefore);
  if (!match) return null;
  const query = match[2] ?? '';
  const prefixLen = match[1].length;
  const atOffset = match.index + prefixLen;
  return {
    query,
    from: line.from + atOffset,
    to: cursor,
  };
}

export function formatMentionInsertion(person: OrgPerson): string {
  return `[${person.name}](${formatMentionUrl(person.email)}) `;
}

export function isInsideMentionLink(state: EditorState, pos: number): boolean {
  return findMentionAt(state, pos, -1) !== null;
}

export function filterPeople(
  people: readonly OrgPerson[],
  query: string,
): readonly OrgPerson[] {
  const q = query.toLowerCase();
  if (q.length === 0) return people.slice();
  return people.filter(
    (person) =>
      person.name.toLowerCase().includes(q) ||
      person.email.toLowerCase().includes(q),
  );
}
