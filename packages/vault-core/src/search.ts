import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isNodeError, statOrNull } from './fs.js';
import { InvalidPathError, resolveVaultPath, validateOptionalVaultPath } from './path.js';

export interface SearchInput {
  q: string;
  under?: string;
  context?: number;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  lineText: string;
  context: {
    before: string[];
    after: string[];
  };
}

export interface SearchResult {
  q: string;
  under: string;
  limit: number;
  offset: number;
  total: number;
  truncated: boolean;
  results: SearchHit[];
}

const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 5;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const SEARCH_ENTRY_CAP = 5000;

export async function searchVaultFiles(root: string, input: SearchInput): Promise<SearchResult> {
  const query = input.q.trim();
  if (query.length === 0) {
    return {
      q: input.q,
      under: '',
      limit: clampPositiveInteger(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
      offset: clampNonNegativeInteger(input.offset),
      total: 0,
      truncated: false,
      results: []
    };
  }

  const under = validateOptionalVaultPath(input.under, 'folder') ?? '';
  const limit = clampPositiveInteger(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const offset = clampNonNegativeInteger(input.offset);
  const context = clampNonNegativeInteger(input.context, DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES);
  const allHits: SearchHit[] = [];
  const { files, truncated } = await collectSearchableFiles(root, under);
  const lowerQuery = query.toLocaleLowerCase();

  for (const filePath of files) {
    const absolute = vaultPath(root, filePath);
    const content = await readFile(absolute, 'utf8');
    const lines = content.split('\n');
    for (const [index, lineText] of lines.entries()) {
      if (!lineText.toLocaleLowerCase().includes(lowerQuery)) continue;
      allHits.push({
        path: filePath,
        line: index + 1,
        lineText,
        context: {
          before: lines.slice(Math.max(0, index - context), index),
          after: lines.slice(index + 1, index + 1 + context)
        }
      });
    }
  }

  return {
    q: input.q,
    under,
    limit,
    offset,
    total: allHits.length,
    truncated,
    results: allHits.slice(offset, offset + limit)
  };
}

async function collectSearchableFiles(root: string, under: string): Promise<{ files: string[]; truncated: boolean }> {
  const start = under.length === 0 ? root : vaultPath(root, under);
  const startStat = await statOrNull(start);
  if (!startStat?.isDirectory()) return { files: [], truncated: false };

  const files: string[] = [];
  const truncated = await walk(root, under, files);
  return { files: files.sort((left, right) => left.localeCompare(right)), truncated };
}

async function walk(root: string, relDir: string, files: string[]): Promise<boolean> {
  const absDir = relDir.length === 0 ? root : vaultPath(root, relDir);
  const dirents = await readdir(absDir, { withFileTypes: true });
  for (const dirent of dirents) {
    const rel = relDir.length === 0 ? dirent.name : path.posix.join(relDir, dirent.name);
    if (isExcludedSearchPath(rel)) continue;
    if (dirent.isDirectory()) {
      if (await walk(root, rel, files)) return true;
    } else if (dirent.isFile() && isMarkdownLikePath(rel)) {
      files.push(rel);
      if (files.length >= SEARCH_ENTRY_CAP) return true;
    }
  }
  return false;
}

function vaultPath(root: string, relPath: string): string {
  return resolveVaultPath(root, relPath);
}

function isExcludedSearchPath(relPath: string): boolean {
  return relPath === '.kb1' ||
    relPath.startsWith('.kb1/') ||
    relPath === 'trash' ||
    relPath.startsWith('trash/');
}

function isMarkdownLikePath(relPath: string): boolean {
  return relPath.endsWith('.md') || relPath.endsWith('.markdown') || relPath.endsWith('.txt');
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function clampNonNegativeInteger(
  value: number | undefined,
  fallback = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), max);
}
