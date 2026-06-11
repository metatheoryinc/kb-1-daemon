import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DocumentSessionManager } from '@kb-2/doc-session';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createVaultService } from './vault-service.js';

describe('vault service failure mapping', () => {
  let root: string;
  let sessions: DocumentSessionManager | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb2-vault-service-'));
  });

  afterEach(async () => {
    await sessions?.close();
    await rm(root, { recursive: true, force: true });
    sessions = undefined;
  });

  it('returns session_unavailable for edit and positioned write operations that require document sessions', async () => {
    await writeFileWithParents(join(root, 'notes', 'a.md'), 'alpha beta\n');
    const service = createVaultService({ vaultRoot: root });

    await expect(service.editNote({
      path: 'notes/a.md',
      baseline: 'unused',
      oldText: 'beta',
      newText: 'BETA',
      actor: { kind: 'user' }
    })).resolves.toMatchObject({
      ok: false,
      error: 'session_unavailable',
      message: 'document sessions are unavailable'
    });

    await expect(service.appendNote({
      path: 'notes/a.md',
      content: 'tail\n',
      actor: { kind: 'user' }
    })).resolves.toMatchObject({
      ok: false,
      error: 'session_unavailable'
    });

    await expect(service.prependNote({
      path: 'notes/a.md',
      content: 'head\n',
      actor: { kind: 'user' }
    })).resolves.toMatchObject({
      ok: false,
      error: 'session_unavailable'
    });

    await expect(readFile(join(root, 'notes/a.md'), 'utf8')).resolves.toBe('alpha beta\n');
    await expect(stat(join(root, '.kb2/audit/changes.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps live-session persist failures without writing a success audit row', async () => {
    await writeFileWithParents(join(root, 'notes', 'readonly.md'), 'base\n');
    sessions = new DocumentSessionManager({ root, defaultContent: '' });
    const service = createVaultService({ vaultRoot: root, documentSessions: sessions });

    await service.readNote({ path: 'notes/readonly.md' });
    const notesDir = join(root, 'notes');
    await chmod(notesDir, 0o500);
    const failed = await service.appendNote({
      path: 'notes/readonly.md',
      content: 'unsaved\n',
      actor: { kind: 'user' }
    });

    expect(failed).toEqual({
      ok: false,
      error: 'persist_failed',
      message: 'Document edit could not be durably saved to disk.'
    });
    await expect(readFile(join(root, 'notes/readonly.md'), 'utf8')).resolves.toBe('base\n');
    await expect(stat(join(root, '.kb2/audit/changes.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });

    await chmod(notesDir, 0o700);
    await expect(service.appendNote({
      path: 'notes/readonly.md',
      content: 'recovered\n',
      actor: { kind: 'user' }
    })).resolves.toMatchObject({
      ok: true,
      content: 'base\nunsaved\nrecovered\n'
    });
  });

  it('maps live move and folder subtree failures from vault operations', async () => {
    await writeFileWithParents(join(root, 'notes', 'live.md'), 'live\n');
    await writeFileWithParents(join(root, 'notes', 'target.md'), 'target\n');
    await writeFileWithParents(join(root, 'folder', 'child.md'), 'child\n');
    await writeFileWithParents(join(root, 'existing', 'child.md'), 'existing\n');
    sessions = new DocumentSessionManager({ root, defaultContent: '' });
    const service = createVaultService({ vaultRoot: root, documentSessions: sessions });
    await sessions.getSession('notes/live.md').open();

    await expect(service.moveNote({
      fromPath: 'notes/live.md',
      toPath: 'notes/target.md',
      actor: { kind: 'user' }
    })).resolves.toMatchObject({
      ok: false,
      error: 'path_collision'
    });

    await expect(service.moveFolder({
      fromPath: 'folder',
      toPath: 'existing',
      actor: { kind: 'user' }
    })).resolves.toMatchObject({
      ok: false,
      error: 'path_collision'
    });
  });
});

async function writeFileWithParents(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}
