import type { AccentName } from '../primitives/accent';

export interface LocalFileNode {
  kind: 'file';
  path: string;
  name: string;
}

export interface LocalFolderMetadata {
  color?: AccentName;
  icon?: string | null;
}

export interface LocalFolderNode {
  kind: 'folder';
  path: string;
  name: string;
  metadata?: LocalFolderMetadata;
  children: LocalTreeNode[];
}

export type LocalTreeNode = LocalFileNode | LocalFolderNode;

export interface LocalSearchResult {
  path: string;
  line: number;
  lineText: string;
  before?: string[];
  after?: string[];
}

export interface LocalFileAction {
  kind: 'file';
  action: 'rename' | 'move' | 'delete';
  path: string;
}

export interface LocalFolderAction {
  kind: 'folder';
  action: 'new-note' | 'new-folder' | 'rename' | 'move' | 'delete' | 'color';
  path: string;
  color?: AccentName | null;
}

export type LocalTreeAction = LocalFileAction | LocalFolderAction;
