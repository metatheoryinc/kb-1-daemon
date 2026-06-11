import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';

import {
  deleteVaultFile,
  deleteVaultFolder,
  getVaultInfo,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  readVaultFile,
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

async function readAuditLines(root: string): Promise<unknown[]> {
  const content = await readFile(path.join(root, '.kb2/audit/changes.jsonl'), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line) as unknown);
}
