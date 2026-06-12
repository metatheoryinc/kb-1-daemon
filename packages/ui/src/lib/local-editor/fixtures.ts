import type { LocalSearchResult, LocalTreeNode } from './types';

export const localEditorTreeFixture: LocalTreeNode[] = [
  {
    kind: 'folder',
    path: 'projects',
    name: 'projects',
    metadata: { color: 'sage' },
    children: [
      {
        kind: 'folder',
        path: 'projects/active',
        name: 'active',
        metadata: { color: 'coral' },
        children: [
          { kind: 'file', path: 'projects/active/launch-notes.md', name: 'launch-notes.md' },
          { kind: 'file', path: 'projects/active/editor-shell.md', name: 'editor-shell.md' }
        ]
      },
      { kind: 'file', path: 'projects/roadmap.md', name: 'roadmap.md' }
    ]
  },
  {
    kind: 'folder',
    path: 'research',
    name: 'research',
    metadata: { color: 'sky' },
    children: [
      { kind: 'file', path: 'research/local-first.md', name: 'local-first.md' },
      { kind: 'file', path: 'research/sync-notes.md', name: 'sync-notes.md' }
    ]
  },
  { kind: 'file', path: 'hello-world.md', name: 'hello-world.md' }
];

export const localEditorSearchFixture: LocalSearchResult[] = [
  {
    path: 'projects/active/editor-shell.md',
    line: 8,
    lineText: 'The local editor shell keeps navigation and editing in one focused workspace.',
    before: ['## App shell'],
    after: ['File operations stay behind the daemon service boundary.']
  },
  {
    path: 'research/local-first.md',
    line: 14,
    lineText: 'Search results show file paths with enough surrounding snippet context to choose quickly.',
    before: ['The vault is the durable truth.'],
    after: ['Folder colors live in .kb2/folders.yml.']
  }
];

export const localEditorDocumentPath = 'projects/active/editor-shell.md';
