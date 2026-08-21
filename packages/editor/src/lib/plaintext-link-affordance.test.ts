import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { describe, expect, it } from 'vitest';
import { plaintextDecorations } from './plaintext-decorations';
import { extractLinkUrl } from './plaintext-link-affordance';

function linkNodeFor(doc: string): { state: EditorState; node: SyntaxNode } {
  const state = EditorState.create({
    doc,
    extensions: [plaintextDecorations()],
  });
  let node: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    enter: (candidate) => {
      if (candidate.type.name === 'Link') {
        node = candidate.node;
        return false;
      }
      return undefined;
    },
  });
  if (node === null) throw new Error('expected a Link node');
  return { state, node };
}

describe('extractLinkUrl', () => {
  it('returns the destination rather than a URL-shaped label', () => {
    const { state, node } = linkNodeFor(
      '[https://label.example](https://destination.example)',
    );
    expect(extractLinkUrl(state, node)).toBe('https://destination.example');
  });

  it('returns a mention destination behind a URL-shaped label', () => {
    const { state, node } = linkNodeFor(
      '[https://profile.example](mention:alice@kb-1.dev)',
    );
    expect(extractLinkUrl(state, node)).toBe('mention:alice@kb-1.dev');
  });
});
