import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';

import {
  DOCUMENT_BYTES_LIMIT,
  SPLICE_BYTES_LIMIT,
  appendContent,
  applyAnchoredSplice,
  deleteVaultFile,
  deleteVaultFolder,
  getVaultInfo,
  listVaultTree,
  lfNormalize,
  makeVaultFolder,
  moveVaultPath,
  prependContent,
  readVaultFile,
  searchVaultFiles,
  validateVaultPath,
  writeVaultFile,
  type VaultContext
} from './index.js';

describe('vault path validation', () => {
  const validSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/).filter((segment) =>
    segment !== '.' &&
    segment !== '..' &&
    segment !== '.kb2' &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
  const validFileName = fc.tuple(validSegment, validSegment).map(([name, ext]) => `${name}.${ext}`);
  const validFolderPath = fc.array(validSegment, { minLength: 1, maxLength: 5 }).map((segments) => segments.join('/'));
  const validFilePath = fc.tuple(fc.array(validSegment, { minLength: 0, maxLength: 4 }), validFileName)
    .map(([parents, file]) => [...parents, file].join('/'));

  it.each([
    ['', 'file'],
    ['/absolute.md', 'file'],
    ['nested//file.md', 'file'],
    ['nested/', 'folder'],
    ['.', 'folder'],
    ['..', 'folder'],
    ['nested/../file.md', 'file'],
    ['nested\\.md', 'file'],
    ['folder/no-extension', 'file'],
    ['folder/.hidden', 'file'],
    ['folder/trailing.', 'file'],
    ['.kb2/audit.md', 'file'],
    [`${'a'.repeat(256)}.md`, 'file'],
    [`${'a'.repeat(1025)}.md`, 'file']
  ] as const)('rejects invalid %s as %s', (input, kind) => {
    expect(() => validateVaultPath(input, kind)).toThrow();
  });

  it.each([
    ['note.md', 'file'],
    ['nested/note.md', 'file'],
    ['nested/deep', 'folder']
  ] as const)('accepts %s as %s', (input, kind) => {
    expect(validateVaultPath(input, kind)).toBe(input);
  });

  it('rejects non-string input', () => {
    expect(() => validateVaultPath(123 as unknown as string, 'file')).toThrow('path must be a string');
  });

  it('property: valid file paths validate idempotently and resolve inside the vault root', () => {
    fc.assert(fc.property(validFilePath, (candidate) => {
      const validated = validateVaultPath(candidate, 'file');
      expect(validateVaultPath(validated, 'file')).toBe(validated);
      expect(path.resolve('/tmp/kb2-property-vault', validated).startsWith('/tmp/kb2-property-vault/')).toBe(true);
    }));
  });

  it('property: valid folder paths validate idempotently and resolve inside the vault root', () => {
    fc.assert(fc.property(validFolderPath, (candidate) => {
      const validated = validateVaultPath(candidate, 'folder');
      expect(validateVaultPath(validated, 'folder')).toBe(validated);
      expect(path.resolve('/tmp/kb2-property-vault', validated).startsWith('/tmp/kb2-property-vault/')).toBe(true);
    }));
  });

  it('property: generated traversal, absolute, and empty-segment inputs never validate', () => {
    const invalidPath = fc.oneof(
      validFilePath.map((candidate) => `/${candidate}`),
      validFilePath.map((candidate) => `${candidate}/..`),
      validFilePath.map((candidate) => `../${candidate}`),
      validFilePath.map((candidate) => candidate.replace('/', '//')).filter((candidate) => candidate.includes('//')),
      fc.tuple(validSegment, validFileName).map(([segment, file]) => `${segment}//${file}`),
      fc.tuple(validSegment, validFileName).map(([segment, file]) => `${segment}/./${file}`),
      fc.tuple(validSegment, validFileName).map(([segment, file]) => `${segment}/../${file}`)
    );

    fc.assert(fc.property(invalidPath, (candidate) => {
      expect(() => validateVaultPath(candidate, 'file')).toThrow();
    }));
  });
});

describe('vault-core filesystem operations', () => {
  let root: string;
  let ctx: VaultContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kb2-vault-core-'));
    ctx = { root, actor: { kind: 'user', client: 'vitest' } };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates, reads, refuses no-clobber writes, overwrites, and audits', async () => {
    const created = await writeVaultFile(ctx, { path: 'notes/a.md', content: 'first' });
    expect(created.ok).toBe(true);

    const duplicate = await writeVaultFile(ctx, { path: 'notes/a.md', content: 'second' });
    expect(duplicate).toMatchObject({ ok: false, error: 'already_exists' });

    const overwritten = await writeVaultFile(ctx, { path: 'notes/a.md', content: 'second', overwrite: true });
    expect(overwritten.ok).toBe(true);

    const read = await readVaultFile(ctx, 'notes/a.md');
    expect(read).toMatchObject({ ok: true, value: { path: 'notes/a.md', content: 'second' } });

    const auditLines = await readAuditLines(root);
    expect(auditLines).toHaveLength(2);
    expect(auditLines[0]).toMatchObject({
      actor: { kind: 'user', client: 'vitest' },
      operation: 'create',
      entityKind: 'file',
      path: 'notes/a.md'
    });
    expect(auditLines[1]).toMatchObject({
      operation: 'write',
      path: 'notes/a.md'
    });
  });

  it('creates folders idempotently and lists trees excluding .kb2 trash/audit', async () => {
    await expect(makeVaultFolder(ctx, 'notes')).resolves.toMatchObject({ ok: true, value: { path: 'notes' } });
    await expect(makeVaultFolder(ctx, 'notes')).resolves.toMatchObject({ ok: true, value: { path: 'notes' } });
    await writeVaultFile(ctx, { path: 'notes/a.md', content: 'a' });
    await deleteVaultFile(ctx, { path: 'notes/a.md' });

    const tree = await listVaultTree(ctx);
    expect(tree.ok).toBe(true);
    expect(tree.ok ? tree.value.entries.map((entry) => entry.path) : []).toEqual(['notes']);
  });

  it('lists subtrees with depth limits and entry-cap errors', async () => {
    await writeVaultFile(ctx, { path: 'notes/a.md', content: 'a' });
    await writeVaultFile(ctx, { path: 'notes/deep/b.md', content: 'b' });

    const shallow = await listVaultTree(ctx, { under: 'notes', depth: 0 });
    expect(shallow.ok ? shallow.value.entries.map((entry) => entry.path) : []).toEqual([
      'notes/a.md',
      'notes/deep'
    ]);

    await expect(listVaultTree(ctx, { under: 'missing' }))
      .resolves.toMatchObject({ ok: false, error: 'not_found' });
    await expect(listVaultTree(ctx, { under: '../escape' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid_path' });
    await expect(listVaultTree(ctx, { entryCap: 1 }))
      .resolves.toMatchObject({ ok: false, error: 'entry_cap_exceeded' });
    await expect(listVaultTree(ctx, { entryCap: 0 }))
      .resolves.toMatchObject({ ok: false, error: 'entry_cap_exceeded' });
  });

  it('reports vault counts from durable files', async () => {
    await writeVaultFile(ctx, { path: 'notes/a.md', content: 'a' });
    await writeVaultFile(ctx, { path: 'notes/deep/b.md', content: 'b' });

    const info = await getVaultInfo(ctx);
    expect(info).toMatchObject({
      ok: true,
      value: {
        fileCount: 2,
        folderCount: 2
      }
    });
  });

  it('reports an entry-cap error when vault info exceeds the service cap', async () => {
    await Promise.all(Array.from({ length: 5001 }, async (_value, index) => {
      await writeFile(path.join(root, `file-${index}.md`), '');
    }));

    await expect(getVaultInfo(ctx)).resolves.toMatchObject({ ok: false, error: 'entry_cap_exceeded' });
  });

  it('moves files and folders with collision checks', async () => {
    await writeVaultFile(ctx, { path: 'notes/a.md', content: 'a' });
    await writeVaultFile(ctx, { path: 'notes/existing.md', content: 'existing' });

    await expect(moveVaultPath(ctx, { kind: 'file', fromPath: 'notes/a.md', toPath: 'archive/a.md' }))
      .resolves.toMatchObject({ ok: true, value: { fromPath: 'notes/a.md', toPath: 'archive/a.md', kind: 'file' } });
    await expect(readFile(path.join(root, 'archive/a.md'), 'utf8')).resolves.toBe('a');
    await expect(stat(path.join(root, 'notes/a.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(moveVaultPath(ctx, { kind: 'file', fromPath: 'archive/a.md', toPath: 'notes/existing.md' }))
      .resolves.toMatchObject({ ok: false, error: 'path_collision' });

    await expect(moveVaultPath(ctx, { kind: 'folder', fromPath: 'archive', toPath: 'moved/archive' }))
      .resolves.toMatchObject({ ok: true, value: { fromPath: 'archive', toPath: 'moved/archive', kind: 'folder' } });
    await expect(readFile(path.join(root, 'moved/archive/a.md'), 'utf8')).resolves.toBe('a');
  });

  it('supports overwrite moves and reports invalid/not-found move errors', async () => {
    await writeVaultFile(ctx, { path: 'source.md', content: 'source' });
    await writeVaultFile(ctx, { path: 'target.md', content: 'target' });

    await expect(moveVaultPath(ctx, { kind: 'file', fromPath: 'source.md', toPath: 'target.md', overwrite: true }))
      .resolves.toMatchObject({ ok: true, value: { fromPath: 'source.md', toPath: 'target.md' } });
    await expect(readFile(path.join(root, 'target.md'), 'utf8')).resolves.toBe('source');
    await expect(moveVaultPath(ctx, { kind: 'file', fromPath: 'missing.md', toPath: 'next.md' }))
      .resolves.toMatchObject({ ok: false, error: 'not_found' });
    await expect(moveVaultPath(ctx, { kind: 'file', fromPath: '../bad.md', toPath: 'next.md' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid_path' });

    await makeVaultFolder(ctx, 'folder');
    await expect(moveVaultPath(ctx, { kind: 'folder', fromPath: 'folder', toPath: 'folder/child' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid_path' });
    await expect(moveVaultPath(ctx, { kind: 'folder', fromPath: 'folder', toPath: 'folder' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid_path' });
  });

  it('classifies parent-file collisions without throwing', async () => {
    await writeVaultFile(ctx, { path: 'parent.md', content: 'file parent' });
    await writeVaultFile(ctx, { path: 'source.md', content: 'source' });

    await expect(makeVaultFolder(ctx, 'parent.md'))
      .resolves.toMatchObject({ ok: false, error: 'path_collision' });
    await expect(writeVaultFile(ctx, { path: 'parent.md/child.md', content: 'child' }))
      .resolves.toMatchObject({ ok: false, error: 'path_collision' });
    await expect(makeVaultFolder(ctx, 'parent.md/child'))
      .resolves.toMatchObject({ ok: false, error: 'path_collision' });
    await expect(moveVaultPath(ctx, { kind: 'file', fromPath: 'source.md', toPath: 'parent.md/child.md' }))
      .resolves.toMatchObject({ ok: false, error: 'path_collision' });
  });

  it('rethrows unexpected filesystem errors after classified collision checks', async () => {
    await chmod(root, 0o500);
    try {
      await expect(writeVaultFile(ctx, { path: 'blocked/file.md', content: 'x' }))
        .rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('refuses non-recursive folder delete and trashes recursive delete with original path', async () => {
    await writeVaultFile(ctx, { path: 'folder/file.md', content: 'x' });

    await expect(deleteVaultFolder(ctx, { path: 'folder' }))
      .resolves.toMatchObject({ ok: false, error: 'folder_not_empty' });

    const deleted = await deleteVaultFolder(ctx, { path: 'folder', recursive: true });
    expect(deleted.ok).toBe(true);
    const trashPath = deleted.ok ? deleted.value.trashPath : undefined;
    expect(trashPath).toMatch(/^\.kb2\/trash\/.+\/folder$/);
    await expect(readFile(path.join(root, trashPath!, 'file.md'), 'utf8')).resolves.toBe('x');
  });

  it('permanently deletes files when requested', async () => {
    await writeVaultFile(ctx, { path: 'gone.md', content: 'x' });
    await expect(deleteVaultFile(ctx, { path: 'gone.md', permanent: true }))
      .resolves.toMatchObject({ ok: true, value: { permanent: true } });
    await expect(stat(path.join(root, 'gone.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports read/delete not found and invalid path failures', async () => {
    await expect(readVaultFile(ctx, 'missing.md')).resolves.toMatchObject({ ok: false, error: 'not_found' });
    await expect(readVaultFile(ctx, '../missing.md')).resolves.toMatchObject({ ok: false, error: 'invalid_path' });
    await expect(writeVaultFile(ctx, { path: '../bad.md', content: 'x' })).resolves.toMatchObject({ ok: false, error: 'invalid_path' });
    await expect(makeVaultFolder(ctx, '../bad')).resolves.toMatchObject({ ok: false, error: 'invalid_path' });
    await expect(deleteVaultFile(ctx, { path: 'missing.md' })).resolves.toMatchObject({ ok: false, error: 'not_found' });
    await expect(deleteVaultFile(ctx, { path: '../missing.md' })).resolves.toMatchObject({ ok: false, error: 'invalid_path' });
    await expect(deleteVaultFolder(ctx, { path: 'missing' })).resolves.toMatchObject({ ok: false, error: 'not_found' });
    await expect(deleteVaultFolder(ctx, { path: '../missing' })).resolves.toMatchObject({ ok: false, error: 'invalid_path' });
  });

  it('permanently deletes folders when requested', async () => {
    await writeVaultFile(ctx, { path: 'folder/file.md', content: 'x' });
    await expect(deleteVaultFolder(ctx, { path: 'folder', recursive: true, permanent: true }))
      .resolves.toMatchObject({ ok: true, value: { path: 'folder', permanent: true } });
    await expect(stat(path.join(root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defaults audit actors to user when none is supplied', async () => {
    await writeVaultFile({ root }, { path: 'default-actor.md', content: 'x' });
    const audit = await readAuditLines(root);
    expect(audit[0]).toMatchObject({ actor: { kind: 'user' } });
  });
});

describe('anchored splice and positioned content helpers', () => {
  it('applies exact replacements with anchors, occurrence, LF normalization, and surrogate pairs', () => {
    expect(applyAnchoredSplice('one two three', {
      oldText: 'two',
      newText: 'TWO'
    })).toEqual({ ok: true, content: 'one TWO three' });

    expect(applyAnchoredSplice('foo bar foo baz foo', {
      oldText: 'foo',
      newText: 'FOO',
      occurrence: 2
    })).toEqual({ ok: true, content: 'foo bar FOO baz foo' });

    expect(applyAnchoredSplice('aa aa aa', {
      before: 'aa ',
      oldText: 'aa',
      after: ' aa',
      newText: 'XX'
    })).toEqual({ ok: true, content: 'aa XX aa' });

    expect(applyAnchoredSplice('line one\nline two', {
      oldText: 'one\r\nline',
      newText: 'ONE\nLINE'
    })).toEqual({ ok: true, content: 'line ONE\nLINE two' });

    expect(applyAnchoredSplice('before 😀 after', {
      oldText: '😀',
      newText: '🧪'
    })).toEqual({ ok: true, content: 'before 🧪 after' });
  });

  it('rejects missing, ambiguous, out-of-range, and size-capped splices', () => {
    expect(applyAnchoredSplice('hello', {
      oldText: 'missing',
      newText: 'x'
    })).toEqual({ ok: false, rejected: 'not_found' });

    expect(applyAnchoredSplice('hello', {
      oldText: '',
      newText: 'x'
    })).toEqual({ ok: false, rejected: 'not_found' });

    expect(applyAnchoredSplice('aaa', {
      oldText: 'aa',
      newText: 'b'
    })).toEqual({ ok: false, rejected: 'ambiguous', match_count: 2 });

    expect(applyAnchoredSplice('foo foo', {
      oldText: 'foo',
      newText: 'bar',
      occurrence: 3
    })).toEqual({ ok: false, rejected: 'not_found' });

    expect(applyAnchoredSplice('x', {
      oldText: 'x'.repeat(SPLICE_BYTES_LIMIT + 1),
      newText: 'y'
    })).toEqual({ ok: false, rejected: 'too_large_splice', limit_bytes: SPLICE_BYTES_LIMIT });

    const base = `x${'a'.repeat(DOCUMENT_BYTES_LIMIT - 1)}`;
    expect(applyAnchoredSplice(base, {
      oldText: 'x',
      newText: 'yy'
    })).toEqual({
      ok: false,
      rejected: 'too_large_document',
      current_bytes: DOCUMENT_BYTES_LIMIT + 1,
      limit_bytes: DOCUMENT_BYTES_LIMIT
    });
  });

  it('property: anchored splice result equals the direct string replacement for generated full-unicode documents', () => {
    const unicodeFragment = fc.array(
      fc.oneof(
        fc.string({ maxLength: 4 }),
        fc.constantFrom('😀', '🧪', '𝌆', 'é', '中', '\uD800', '\uDC00', '\r\n', '\r')
      ),
      { maxLength: 20 }
    ).map((parts) => parts.join(''));
    const boundary = fc.constantFrom('', '😀', '🧪', '𝌆', '\uD800', '\uDC00');

    fc.assert(fc.property(
      unicodeFragment,
      unicodeFragment,
      unicodeFragment,
      unicodeFragment,
      boundary,
      boundary,
      (left, oldText, right, replacement, edgeBefore, edgeAfter) => {
        const splicedText = `${edgeBefore}${oldText}${edgeAfter}`;
        fc.pre(splicedText.length > 0);
        const before = '__KB2_LEFT__';
        const after = '__KB2_RIGHT__';
        fc.pre(!left.includes(before + splicedText + after));
        fc.pre(!right.includes(before + splicedText + after));
        const source = `${left}${before}${splicedText}${after}${right}`;
        const expected = `${left}${before}${lfNormalize(replacement)}${after}${right}`;
        const result = applyAnchoredSplice(source, {
          before,
          oldText: splicedText,
          after,
          newText: replacement
        });
        expect(result).toEqual({ ok: true, content: expected });
      }
    ));
  });

  it('splices across CRLF, CR, and mixed line boundaries while preserving surrounding bytes', () => {
    expect(applyAnchoredSplice('alpha\r\nold\r\nomega', {
      oldText: 'old\nomega',
      newText: 'NEW'
    })).toEqual({ ok: true, content: 'alpha\r\nNEW' });

    expect(applyAnchoredSplice('alpha\r\nold\r\nomega', {
      oldText: 'old\r\nomega',
      newText: 'NEW'
    })).toEqual({ ok: true, content: 'alpha\r\nNEW' });

    expect(applyAnchoredSplice('a\r\nb\rc\nd', {
      oldText: 'b\nc\nd',
      newText: 'B'
    })).toEqual({ ok: true, content: 'a\r\nB' });

    expect(applyAnchoredSplice('a\rb\rc', {
      oldText: 'a\nb',
      newText: 'AB'
    })).toEqual({ ok: true, content: 'AB\rc' });
  });

  it('appends and prepends after YAML frontmatter using gray-matter detection', () => {
    expect(appendContent('a\r\n', 'b\r\n')).toBe('a\r\nb\n');
    expect(prependContent('body\n', 'top\r\n')).toBe('top\nbody\n');
    expect(prependContent('---\ntitle: Test\n---\nbody\n', 'inserted\n')).toBe(
      '---\ntitle: Test\n---\ninserted\nbody\n'
    );
    expect(prependContent('---\nonly: front\n---', 'inserted\n')).toBe(
      '---\nonly: front\n---\ninserted\n'
    );
    expect(prependContent('---\r\ntitle: Test\r\n---\r\nbody\r\n', 'inserted\n')).toBe(
      '---\r\ntitle: Test\r\n---\r\ninserted\nbody\r\n'
    );
    expect(prependContent('---\ronly: front\r---\rbody\r', 'inserted\n')).toBe(
      '---\ronly: front\r---\rinserted\nbody\r'
    );
    expect(prependContent('---\nonly: front\nbody\n', 'inserted\n')).toBe(
      'inserted\n---\nonly: front\nbody\n'
    );
  });
});

describe('scan search', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kb2-search-'));
    await writeFileWithParents(path.join(root, 'notes', 'a.md'), 'alpha\nBeta target\ngamma\n', 'utf8');
    await writeFileWithParents(path.join(root, 'notes', 'deep', 'b.txt'), 'target two\nnext\n', 'utf8');
    await writeFileWithParents(path.join(root, 'notes', 'deep', 'c.markdown'), 'no hit\n', 'utf8');
    await writeFileWithParents(path.join(root, 'notes', 'skip.json'), 'target ignored\n', 'utf8');
    await writeFileWithParents(path.join(root, '.kb2', 'audit', 'hidden.md'), 'target hidden\n', 'utf8');
    await writeFileWithParents(path.join(root, 'trash', 'old.md'), 'target trashed\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds case-insensitive line matches with context, filters, and pagination', async () => {
    const result = await searchVaultFiles(root, {
      q: 'TARGET',
      under: 'notes',
      context: 1,
      limit: 1,
      offset: 1
    });

    expect(result).toMatchObject({
      q: 'TARGET',
      under: 'notes',
      limit: 1,
      offset: 1,
      total: 2
    });
    expect(result.results).toEqual([
      {
        path: 'notes/deep/b.txt',
        line: 1,
        lineText: 'target two',
        context: { before: [], after: ['next'] }
      }
    ]);
  });

  it('searches from the vault root and excludes metadata and trash folders', async () => {
    const result = await searchVaultFiles(root, { q: 'target', context: 0, limit: 10 });

    expect(result.total).toBe(2);
    expect(result.results.map((hit) => hit.path)).toEqual([
      'notes/a.md',
      'notes/deep/b.txt'
    ]);
    expect(result.results.every((hit) => hit.context.before.length === 0 && hit.context.after.length === 0)).toBe(true);
  });

  it('caps the searchable file walk before unbounded scans', async () => {
    const cappedRoot = await mkdtemp(path.join(tmpdir(), 'kb2-search-cap-'));
    const nestedRoot = await mkdtemp(path.join(tmpdir(), 'kb2-search-nested-cap-'));
    try {
      await Promise.all(Array.from({ length: 5001 }, async (_value, index) => {
        await writeFile(path.join(cappedRoot, `file-${index}.md`), 'needle\n', 'utf8');
      }));

      const result = await searchVaultFiles(cappedRoot, { q: 'needle', limit: 10 });
      expect(result.total).toBe(5000);
      expect(result.truncated).toBe(true);
      expect(result.results).toHaveLength(10);

      await mkdir(path.join(nestedRoot, 'nested'), { recursive: true });
      await Promise.all(Array.from({ length: 5000 }, async (_value, index) => {
        await writeFile(path.join(nestedRoot, 'nested', `file-${index}.md`), 'needle\n', 'utf8');
      }));
      await writeFile(path.join(nestedRoot, 'after.md'), 'needle\n', 'utf8');
      const nested = await searchVaultFiles(nestedRoot, { q: 'needle', limit: 10 });
      expect(nested.total).toBe(5000);
      expect(nested.truncated).toBe(true);
    } finally {
      await rm(cappedRoot, { recursive: true, force: true });
      await rm(nestedRoot, { recursive: true, force: true });
    }
  });

  it('property: every randomized search result references a real line in a real file', async () => {
    const segment = fc.stringMatching(/^[a-z]{1,8}$/);
    const relativeFile = fc.tuple(fc.array(segment, { maxLength: 2 }), segment)
      .map(([folders, name]) => [...folders, `${name}.md`].join('/'));
    const line = fc.string({ maxLength: 24 }).filter((value) => !value.includes('\n'));
    const fileSet = fc.uniqueArray(
      fc.record({
        path: relativeFile,
        lines: fc.array(line, { minLength: 1, maxLength: 8 })
      }),
      { minLength: 1, maxLength: 12, selector: (file) => file.path }
    );

    await fc.assert(fc.asyncProperty(fileSet, async (files) => {
      const propertyRoot = await mkdtemp(path.join(tmpdir(), 'kb2-search-property-'));
      try {
        const expectedLines = new Map<string, string[]>();
        for (const file of files) {
          const lines = file.lines.length > 0 && file.lines.some((candidate) => candidate.includes('needle'))
            ? file.lines
            : ['needle', ...file.lines];
          expectedLines.set(file.path, lines);
          await writeFileWithParents(path.join(propertyRoot, file.path), `${lines.join('\n')}\n`, 'utf8');
        }

        const result = await searchVaultFiles(propertyRoot, { q: 'needle', limit: 100, context: 2 });
        for (const hit of result.results) {
          const lines = expectedLines.get(hit.path);
          expect(lines).toBeDefined();
          expect(hit.line).toBeGreaterThanOrEqual(1);
          expect(hit.line).toBeLessThanOrEqual(lines!.length);
          expect(hit.lineText).toBe(lines![hit.line - 1]);
          expect(hit.lineText.toLocaleLowerCase()).toContain('needle');
        }
      } finally {
        await rm(propertyRoot, { recursive: true, force: true });
      }
    }), { numRuns: 35 });
  });

  it('returns empty results for empty and missing-folder searches', async () => {
    await expect(searchVaultFiles(root, { q: '   ' })).resolves.toMatchObject({
      q: '   ',
      total: 0,
      results: []
    });
    await expect(searchVaultFiles(root, { q: 'target', under: 'missing' })).resolves.toMatchObject({
      total: 0,
      results: []
    });
    await expect(searchVaultFiles(root, {
      q: 'target',
      under: 'notes/a.md',
      context: 50,
      limit: -1,
      offset: -1
    })).resolves.toMatchObject({
      limit: 20,
      offset: 0,
      total: 0,
      results: []
    });
  });

  it('rejects invalid folder filters through path validation', async () => {
    await expect(searchVaultFiles(root, { q: 'target', under: '../outside' })).rejects.toThrow('Invalid vault path');
  });
});

async function readAuditLines(root: string): Promise<unknown[]> {
  const content = await readFile(path.join(root, '.kb2/audit/changes.jsonl'), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line) as unknown);
}

async function writeFileWithParents(pathname: string, content: string, encoding: BufferEncoding): Promise<void> {
  await writeFile(pathname, content, encoding).catch(async (error: unknown) => {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, content, encoding);
  });
}
