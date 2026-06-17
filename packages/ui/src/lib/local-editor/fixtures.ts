import type { LocalSearchResult, LocalTreeNode, StarredRowData } from './types';

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

// A handful of starred rows, matching the tree fixture's paths + accents,
// for the starred panel stories. Folders first, then notes — the grouping
// the panel renders.
export const localEditorStarredFoldersFixture: StarredRowData[] = [
  {
    id: 'folder:demo-vault:projects/active',
    kind: 'folder',
    label: 'active',
    accent: 'coral',
    path: 'projects/active',
    available: true
  },
  {
    id: 'folder:demo-vault:research',
    kind: 'folder',
    label: 'research',
    accent: 'sky',
    path: 'research',
    available: true
  }
];

export const localEditorStarredNotesFixture: StarredRowData[] = [
  {
    id: 'note:demo-vault:projects/active/launch-notes.md',
    kind: 'note',
    label: 'launch-notes.md',
    accent: 'coral',
    path: 'projects/active/launch-notes.md',
    available: true
  },
  {
    id: 'note:demo-vault:research/local-first.md',
    kind: 'note',
    label: 'local-first.md',
    accent: 'sky',
    path: 'research/local-first.md',
    available: true
  },
  {
    // A pin whose target no longer exists — renders dimmed + unavailable.
    id: 'note:demo-vault:archive/old-plan.md',
    kind: 'note',
    label: 'old-plan.md',
    accent: 'slate',
    path: 'archive/old-plan.md',
    available: false
  }
];
