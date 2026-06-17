import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as Y from 'yjs';

import { createFastDiffYTextDelta } from './session.js';
import {
  OneFileDocumentSession,
  DocumentSessionManager,
  type DocumentSessionEvent,
  type DocumentSessionWarning
} from './index.js';

describe('OneFileDocumentSession', () => {
  let kb2Home: string;
  let filePath: string;

  beforeEach(async () => {
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-doc-session-'));
    filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
  });

  afterEach(async () => {
    await rm(kb2Home, { force: true, recursive: true });
  });

  it('maps fast-diff output to a Y.Text delta that reproduces randomized disk content exactly', () => {
    const cases = [
      ['', ''],
      ['', 'created\n'],
      ['deleted\n', ''],
      ['same\n', 'same\n'],
      ['a😀b', 'a😃b'],
      ['😀 at start', 'prefix 😀 at start'],
      ['end 🧪', 'end 🧪 suffix'],
      ['repeat\nrepeat\nrepeat\n', 'repeat\nchanged\nrepeat\n'],
      ['multi\nline\nsource\n', 'multi\n🧪 line\ntarget\n'],
    ];

    for (let seed = 1; seed <= 160; seed += 1) {
      cases.push([randomDocument(seed), randomDocument(seed * 7919)]);
    }

    for (const [source, target] of cases) {
      const doc = new Y.Doc();
      const text = doc.getText('markdown');
      text.insert(0, source);

      doc.transact(() => {
        text.applyDelta(createFastDiffYTextDelta(source, target));
      });

      expect(text.toString()).toBe(target);
    }
  });

  it('applies surrogate-pair boundary edits without corrupting the document', () => {
    const source = 'alpha 😀 omega';
    const cases = [
      'alpha 🧪 omega',
      'alpha 😀 inserted omega',
      'alpha inserted 😀 omega',
      'alpha omega',
    ];

    for (const target of cases) {
      const doc = new Y.Doc();
      const text = doc.getText('markdown');
      text.insert(0, source);
      text.applyDelta(createFastDiffYTextDelta(source, target));

      expect(text.toString()).toBe(target);
    }
  });

  it('creates the configured file when it is missing', async () => {
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'seed\n' });

    await session.open();

    await expect(readFile(filePath, 'utf8')).resolves.toBe('seed\n');
    await expect(session.getContent()).resolves.toBe('seed\n');
    await session.close();
  });

  it('falls back to plaintext when the persisted Yjs state sidecar is stale or invalid', async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, 'stable\n', 'utf8');

    const invalidStateFilePath = join(kb2Home, '.kb2', 'doc-session-state', 'invalid.json');
    await mkdir(dirname(invalidStateFilePath), { recursive: true });
    await writeFile(invalidStateFilePath, '{not-json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalidStateSession = new OneFileDocumentSession(filePath, { stateFilePath: invalidStateFilePath });

    await invalidStateSession.open();

    expect(invalidStateSession.ydoc.getText('markdown').toString()).toBe('stable\n');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored invalid Yjs state snapshot'),
      expect.any(SyntaxError)
    );
    await invalidStateSession.close();
    warn.mockRestore();

    const mismatchedDoc = new Y.Doc();
    mismatchedDoc.getText('markdown').insert(0, 'different\n');
    const mismatchedStateFilePath = join(kb2Home, '.kb2', 'doc-session-state', 'mismatched.json');
    const mismatchedUpdateBase64 = Buffer.from(Y.encodeStateAsUpdate(mismatchedDoc)).toString('base64');
    await writeFile(mismatchedStateFilePath, JSON.stringify({
      version: 1,
      contentHash: createHash('sha256').update('stable\n').digest('hex'),
      updateBase64: mismatchedUpdateBase64
    }), 'utf8');
    const mismatchedStateSession = new OneFileDocumentSession(filePath, { stateFilePath: mismatchedStateFilePath });

    await mismatchedStateSession.open();

    expect(mismatchedStateSession.ydoc.getText('markdown').toString()).toBe('stable\n');
    await mismatchedStateSession.close();

    const staleStateFilePath = join(kb2Home, '.kb2', 'doc-session-state', 'stale.json');
    await writeFile(staleStateFilePath, JSON.stringify({
      version: 1,
      contentHash: createHash('sha256').update('old\n').digest('hex'),
      updateBase64: mismatchedUpdateBase64
    }), 'utf8');
    const staleStateSession = new OneFileDocumentSession(filePath, { stateFilePath: staleStateFilePath });

    await staleStateSession.open();

    expect(staleStateSession.ydoc.getText('markdown').toString()).toBe('stable\n');
    await staleStateSession.close();
    mismatchedDoc.destroy();
  });

  it('rejects missing document opens with not_found and leaves parent folders untouched', async () => {
    const session = new OneFileDocumentSession(filePath);

    await expect(session.open()).rejects.toMatchObject({
      failure: {
        ok: false,
        error: 'not_found',
        message: 'file not found'
      }
    });
    await expect(readdir(kb2Home)).resolves.toEqual([]);
  });

  it('cold boots the Yjs document from the materialized Markdown file', async () => {
    await writeFileWithParents(filePath, 'from disk\n');
    const session = new OneFileDocumentSession(filePath);

    await session.open();

    await expect(session.getContent()).resolves.toBe('from disk\n');
    await session.close();
  });

  it('materializes Yjs edits to the filesystem', async () => {
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();

    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'written through Yjs\n');
    Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(clientDoc), clientDoc);
    await session.flush();

    await expect(readFile(filePath, 'utf8')).resolves.toBe('written through Yjs\n');
    await session.close();
  });

  it('flushes dirty manager sessions and re-emits content-persisted events', async () => {
    const manager = new DocumentSessionManager({ root: join(kb2Home, 'demo-vault'), defaultContent: '' });
    const events: DocumentSessionEvent[] = [];
    manager.onEvent((event) => events.push(event));
    const session = manager.getSession('notes/flush.md');
    await session.open();

    session.ydoc.getText('markdown').insert(0, 'manager flush\n');
    await expect(manager.flushDirtySessions()).resolves.toEqual({ flushed: 1 });

    await expect(readFile(join(kb2Home, 'demo-vault', 'notes', 'flush.md'), 'utf8')).resolves.toBe('manager flush\n');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'content-persisted', path: 'notes/flush.md' }));
    await expect(manager.flushDirtySessions()).resolves.toEqual({ flushed: 0 });
    await manager.close();
  });

  it('issues baselines, rejects stale baseline edits with current content, and retries with the fresh baseline', async () => {
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'one two three\n' });
    await session.open();

    const firstRead = await session.readWithBaseline();
    expect(firstRead).toMatchObject({ content: 'one two three\n' });
    expect(firstRead.baseline.length).toBeGreaterThan(0);

    await session.applyContentEdit((current) => current.replace('two', 'TWO'));
    const stale = await session.applyBaselineEdit(firstRead.baseline, (current) => ({
      ok: true,
      content: current.replace('three', 'THREE')
    }));

    expect(stale).toMatchObject({
      ok: false,
      rejected: 'stale_doc',
      current_content: 'one TWO three\n'
    });
    if (stale.ok || stale.rejected !== 'stale_doc' || typeof stale.current_content !== 'string') {
      throw new Error('expected stale_doc');
    }
    if (typeof stale.baseline !== 'string') throw new Error('expected fresh baseline');
    expect(stale.baseline).not.toBe(firstRead.baseline);

    const retry = await session.applyBaselineEdit(stale.baseline, (current) => ({
      ok: true,
      content: current.replace('three', 'THREE')
    }));
    expect(retry).toMatchObject({
      ok: true,
      content: 'one TWO THREE\n'
    });
    await expect(readFile(filePath, 'utf8')).resolves.toBe('one TWO THREE\n');
    await session.close();
  });

  it('truncates stale baseline echoes for oversized resident documents', async () => {
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'small\n' });
    await session.open();
    const firstRead = await session.readWithBaseline();

    await session.applyContent(`${'x'.repeat(1024 * 1024 + 32)}\n`);
    const stale = await session.applyBaselineEdit(firstRead.baseline, (current) => ({
      ok: true,
      content: `${current}unreachable`
    }));

    expect(stale).toMatchObject({
      ok: false,
      rejected: 'stale_doc',
      truncated: true
    });
    if (stale.ok || stale.rejected !== 'stale_doc') {
      throw new Error('expected stale_doc');
    }
    const staleContent = stale.current_content;
    if (typeof staleContent !== 'string') throw new Error('expected current_content');
    expect(new TextEncoder().encode(staleContent).length).toBeLessThanOrEqual(1024 * 1024);
    await session.close();
  });

  it('applies a baseline edit through the session Y.Text so concurrent Yjs updates survive', async () => {
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'alpha\nomega\n' });
    await session.open();
    const read = await session.readWithBaseline();

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc), session);
    clientDoc.getText('markdown').insert('alpha\n'.length, 'typed while splice lands\n');
    const inFlightUpdate = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(session.ydoc));

    const splice = await session.applyBaselineEdit(read.baseline, (current) => ({
      ok: true,
      content: current.replace('omega', 'agent splice')
    }));
    expect(splice).toMatchObject({ ok: true, content: 'alpha\nagent splice\n' });

    Y.applyUpdate(session.ydoc, inFlightUpdate, clientDoc);
    await session.flush();

    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('typed while splice lands\n');
    expect(persisted).toContain('agent splice\n');
    await session.close();
  });

  it('rebuilds a fresh session from the last materialized content', async () => {
    const firstSession = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await firstSession.open();
    await firstSession.reset('after restart\n');
    await firstSession.close();

    const secondSession = new OneFileDocumentSession(filePath);
    await secondSession.open();

    await expect(secondSession.getContent()).resolves.toBe('after restart\n');
    await secondSession.close();
  });

  it('quietly merges direct filesystem changes into an idle active session', async () => {
    const events: DocumentSessionEvent[] = [];
    await writeFileWithParents(filePath, 'active\n');
    const session = new OneFileDocumentSession(filePath, {
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await writeFile(filePath, 'external edit\n', 'utf8');

    await waitUntil(async () => await session.getContent() === 'external edit\n', () =>
      `Timed out waiting for external reconcile; content=${session.ydoc.getText('markdown').toString()}`
    );

    expect(eventKinds(events)).toEqual(['external-merge']);
    await session.close();
  });

  it('uses the default external-change warning and keeps notifying after a handler throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: DocumentSessionEvent[] = [];
    await writeFileWithParents(filePath, 'active\n');
    const session = new OneFileDocumentSession(filePath, {
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent(() => {
      throw new Error('handler failed');
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await writeFile(filePath, 'external edit\n', 'utf8');

    await waitUntil(() => events.some((event) => event.kind === 'external-merge'), () =>
      `Timed out waiting for external merge; events=${JSON.stringify(events)}`
    );

    await writeFile(filePath, 'racing disk edit\n', 'utf8');
    await session.reset('session edit\n');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('external document change detected'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('document session event handler failed'),
      expect.any(Error)
    );
    warnSpy.mockRestore();
    await session.close();
  });

  it('does not report its own materializations as external changes', async () => {
    const events: DocumentSessionEvent[] = [];
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: '',
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    session.ydoc.getText('markdown').insert(0, 'own write\n');
    await session.flush();
    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(readFile(filePath, 'utf8')).resolves.toBe('own write\n');
    expect(events.filter((event) => event.kind === 'external-change' || event.kind === 'external-merge')).toHaveLength(0);
    await session.close();
  });

  it('does not emit an external-change event when disk and session content already match', async () => {
    const events: DocumentSessionEvent[] = [];
    await writeFileWithParents(filePath, 'same content\n');
    const session = new OneFileDocumentSession(filePath, {
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await writeFile(filePath, 'same content\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(events.filter((event) => event.kind === 'external-change' || event.kind === 'external-merge')).toHaveLength(0);
    await expect(session.getContent()).resolves.toBe('same content\n');
    await session.close();
  });

  it('coalesces rapid external writes into one reconciliation event', async () => {
    const events: DocumentSessionEvent[] = [];
    await writeFileWithParents(filePath, 'start\n');
    const session = new OneFileDocumentSession(filePath, {
      watchDebounceMs: 50,
      watchPollMs: 10_000
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await writeFile(filePath, 'external 1\n', 'utf8');
    await writeFile(filePath, 'external 2\n', 'utf8');
    await writeFile(filePath, 'external final\n', 'utf8');

    await waitUntil(async () => await session.getContent() === 'external final\n', () =>
      `Timed out waiting for coalesced reconcile; content=${session.ydoc.getText('markdown').toString()}`
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(eventKinds(events)).toEqual(['external-merge']);
    await session.close();
  });

  it('keeps the loud external-change event when the backing file is truncated', async () => {
    const events: DocumentSessionEvent[] = [];
    await writeFileWithParents(filePath, 'nonempty\n');
    const session = new OneFileDocumentSession(filePath, {
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await writeFile(filePath, '', 'utf8');

    await waitUntil(async () => await session.getContent() === '', () =>
      `Timed out waiting for truncation reconcile; content=${session.ydoc.getText('markdown').toString()}`
    );

    expect(eventKinds(events)).toEqual(['external-change']);
    await session.close();
  });

  it('treats external deletion of an open file as doc-deleted instead of reconciling to empty', async () => {
    const events: DocumentSessionEvent[] = [];
    await writeFileWithParents(filePath, 'do not silently empty me\n');
    const session = new OneFileDocumentSession(filePath, {
      eventPath: 'hello-world.md',
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await rm(filePath);

    await waitUntil(() => events.some((event) => event.kind === 'doc-deleted'), () =>
      `Timed out waiting for doc-deleted; events=${JSON.stringify(events)}`
    );

    expect(eventKinds(events)).toEqual(['doc-deleted']);
    await expect(session.getContent()).resolves.toBe('do not silently empty me\n');
    await session.close();
  });

  it('persists a client update that arrives after an idle external merge', async () => {
    const events: DocumentSessionEvent[] = [];
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: 'base\n',
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc), session);
    clientDoc.getText('markdown').insert(clientDoc.getText('markdown').length, 'client edit\n');
    const inFlightUpdate = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(session.ydoc));

    await writeFile(filePath, 'external edit\n', 'utf8');
    await waitUntil(async () => await session.getContent() === 'external edit\n', () =>
      `Timed out waiting for idle external merge; content=${session.ydoc.getText('markdown').toString()}`
    );

    Y.applyUpdate(session.ydoc, inFlightUpdate, clientDoc);
    await session.flush();

    await waitUntil(async () => {
      const content = await readFile(filePath, 'utf8');
      return content.includes('external edit\n') && content.includes('client edit\n');
    }, () => `Timed out waiting for external and client edits to persist; content=${session.ydoc.getText('markdown').toString()}`);

    expect(eventKinds(events)).toEqual(['external-merge', 'content-persisted']);
    const finalContent = await readFile(filePath, 'utf8');
    expect(finalContent).toContain('external edit\n');
    expect(finalContent).toContain('client edit\n');
    await session.close();
  });

  it('broadcasts persistence failure and recovery events while keeping the session alive', async () => {
    const events: DocumentSessionEvent[] = [];
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    session.onEvent((event) => events.push(event));
    await session.open();

    const vaultDir = dirname(filePath);
    await chmod(vaultDir, 0o500);
    session.ydoc.getText('markdown').insert(0, 'unsaved while readonly\n');

    await waitUntil(() => events.some((event) => event.kind === 'persist-failure'), () =>
      `Timed out waiting for persist-failure; events=${JSON.stringify(events)}`
    );

    await chmod(vaultDir, 0o700);
    session.ydoc.getText('markdown').insert(session.ydoc.getText('markdown').length, 'saved after recovery\n');

    await waitUntil(() => events.some((event) => event.kind === 'persist-recovered'), () =>
      `Timed out waiting for persist-recovered; events=${JSON.stringify(events)}`
    );

    await expect(readFile(filePath, 'utf8')).resolves.toBe('unsaved while readonly\nsaved after recovery\n');
    await session.close();
  });

  it('fails explicit flushes until a later write successfully persists', async () => {
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const vaultDir = dirname(filePath);

    try {
      await chmod(vaultDir, 0o500);
      session.ydoc.getText('markdown').insert(0, 'unsaved\n');
      await expect(session.flush()).rejects.toThrow('Failed to persist document session');
      await expect(session.flush()).rejects.toThrow('Failed to persist document session');
      expect(session.hasActivePersistFailure()).toBe(true);

      await chmod(vaultDir, 0o700);
      session.ydoc.getText('markdown').insert(session.ydoc.getText('markdown').length, 'saved\n');
      await session.flush();
      expect(session.hasActivePersistFailure()).toBe(false);
      await expect(readFile(filePath, 'utf8')).resolves.toBe('unsaved\nsaved\n');
    } finally {
      await chmod(vaultDir, 0o700).catch(() => undefined);
      if (session.hasActivePersistFailure()) {
        session.ydoc.getText('markdown').insert(session.ydoc.getText('markdown').length, 'cleanup\n');
        await session.flush().catch(() => undefined);
      }
      await session.close();
    }
  });

  it('reconciles direct filesystem changes before materializing a racing session edit', async () => {
    const events: DocumentSessionEvent[] = [];
    const warnings: DocumentSessionWarning[] = [];
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: 'active\n',
      warn: (warning) => warnings.push(warning)
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    await writeFile(filePath, 'external stale edit\n', 'utf8');
    await session.reset('active wins\n');

    await expect(readFile(filePath, 'utf8')).resolves.toBe('external stale edit\n');
    await expect(session.getContent()).resolves.toBe('external stale edit\n');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'external-change-detected',
      filePath
    });
    expect(events.some((event) => event.kind === 'external-change')).toBe(true);
    await session.close();
  });

  it('rekeys a live session on move and preserves edits made during the move at the new path', async () => {
    const events: DocumentSessionEvent[] = [];
    const targetPath = join(kb2Home, 'demo-vault', 'renamed.md');
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: 'base\n',
      eventPath: 'hello-world.md'
    });
    session.onEvent((event) => events.push(event));
    await session.open();

    const move = session.moveTo(targetPath, 'renamed.md', async () => {
      session.ydoc.getText('markdown').insert(session.ydoc.getText('markdown').length, 'typed during rename\n');
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(filePath, targetPath);
    });
    await move;
    await session.flush();

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('base\ntyped during rename\n');
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'doc-moved',
      path: 'renamed.md',
      fromPath: 'hello-world.md',
      toPath: 'renamed.md'
    }));
    await session.close();
  });

  it('rekeys every live session under a moved folder subtree', async () => {
    const manager = new DocumentSessionManager({ root: join(kb2Home, 'demo-vault'), defaultContent: '' });
    const first = manager.getSession('folder/a.md');
    const second = manager.getSession('folder/deep/b.md');
    const events: DocumentSessionEvent[] = [];
    first.onEvent((event) => events.push(event));
    second.onEvent((event) => events.push(event));
    await first.open();
    await second.open();
    first.ydoc.getText('markdown').insert(0, 'a\n');
    second.ydoc.getText('markdown').insert(0, 'b\n');
    await Promise.all([first.flush(), second.flush()]);

    const moved = await manager.moveSessionSubtree('folder', 'moved/folder', async () => {
      await mkdir(join(kb2Home, 'demo-vault', 'moved'), { recursive: true });
      await rename(join(kb2Home, 'demo-vault', 'folder'), join(kb2Home, 'demo-vault', 'moved', 'folder'));
    });

    expect(moved.sort()).toEqual(['moved/folder/a.md', 'moved/folder/deep/b.md']);
    await expect(readFile(join(kb2Home, 'demo-vault', 'moved', 'folder', 'a.md'), 'utf8')).resolves.toBe('a\n');
    await expect(readFile(join(kb2Home, 'demo-vault', 'moved', 'folder', 'deep', 'b.md'), 'utf8')).resolves.toBe('b\n');
    expect(events.filter((event) => event.kind === 'doc-moved')).toHaveLength(2);
    await manager.close();
  });

  it('runs move/delete fallbacks when no live session is open', async () => {
    const manager = new DocumentSessionManager({ root: join(kb2Home, 'demo-vault'), defaultContent: '' });
    let moved = false;
    let deleted = false;

    await expect(manager.moveSession('missing.md', 'renamed.md', async () => {
      moved = true;
    })).resolves.toBe(false);
    expect(moved).toBe(false);
    await expect(manager.moveSessionSubtree('folder', 'moved/folder', async () => {
      moved = true;
    })).resolves.toEqual([]);
    expect(moved).toBe(true);

    await expect(manager.deleteSession('missing.md', async () => {
      deleted = true;
    })).resolves.toBe(false);
    expect(deleted).toBe(false);
    await expect(manager.deleteSessionSubtree('folder', async () => {
      deleted = true;
    })).resolves.toEqual([]);
    expect(deleted).toBe(true);
    await manager.close();
  });

  it('keeps a released client session alive through the idle grace and closes it after', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: 'base\n',
      idleSessionGraceMs: 80
    });
    const first = manager.attachClientSession('idle.md');
    await first.session.open();
    first.release();

    const second = manager.attachClientSession('idle.md');
    expect(second.session).toBe(first.session);
    second.release();

    await waitUntil(() => manager.getOpenSessionCount() === 0, () =>
      `Timed out waiting for idle close; count=${manager.getOpenSessionCount()}`
    );
    await manager.close();
  });

  it('evicts a never-opened client session whose missing-file open failed', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      idleSessionGraceMs: 80
    });
    const lease = manager.attachClientSession('typo/missing.md');

    await expect(lease.session.open({ createIfMissing: false })).rejects.toMatchObject({
      failure: {
        ok: false,
        error: 'not_found',
        message: 'file not found'
      }
    });
    expect(manager.getOpenSession('typo/missing.md')).toBeUndefined();
    expect(manager.getOpenSessionCount()).toBe(1);

    lease.release();

    expect(manager.getOpenSessionCount()).toBe(0);
    await expect(readdir(kb2Home)).resolves.toEqual([]);
    await manager.close();
  });

  it('keeps a session open until every simultaneous client lease is released', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: '',
      idleSessionGraceMs: 30
    });
    const first = manager.attachClientSession('leased.md');
    const second = manager.attachClientSession('leased.md');
    await first.session.open();

    try {
      first.release();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(manager.getOpenSession('leased.md')).toBe(first.session);

      second.release();
      await waitUntil(() => manager.getOpenSessionCount() === 0, () =>
        `Timed out waiting for all leases to release; count=${manager.getOpenSessionCount()}`
      );
    } finally {
      second.release();
      await manager.close();
    }
  });

  it('flushes a pending client edit before idle close removes the session', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: '',
      idleSessionGraceMs: 1
    });
    const lease = manager.attachClientSession('flush-before-close.md');
    await lease.session.open();
    lease.session.ydoc.getText('markdown').insert(0, 'pending before close\n');
    lease.release();

    await waitUntil(() => manager.getOpenSessionCount() === 0, () =>
      `Timed out waiting for idle close; count=${manager.getOpenSessionCount()}`
    );
    await expect(readFile(join(kb2Home, 'demo-vault', 'flush-before-close.md'), 'utf8'))
      .resolves.toBe('pending before close\n');
    await manager.close();
  });

  it('does not idle-close a session whose latest content failed to persist', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: 'base\n',
      idleSessionGraceMs: 20
    });
    const lease = manager.attachClientSession('readonly.md');
    await lease.session.open();
    const vaultDir = join(kb2Home, 'demo-vault');

    try {
      await chmod(vaultDir, 0o500);
      lease.session.ydoc.getText('markdown').insert(lease.session.ydoc.getText('markdown').length, 'unsaved\n');
      await expect(lease.session.flush()).rejects.toThrow('Failed to persist document session');
      lease.release();

      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(manager.getOpenSession('readonly.md')).toBe(lease.session);
      await expect(lease.session.getContent()).resolves.toBe('base\nunsaved\n');

      await chmod(vaultDir, 0o700);
      lease.session.ydoc.getText('markdown').insert(lease.session.ydoc.getText('markdown').length, 'saved\n');
      await lease.session.flush();
      await expect(readFile(join(kb2Home, 'demo-vault', 'readonly.md'), 'utf8')).resolves.toBe('base\nunsaved\nsaved\n');
    } finally {
      await chmod(vaultDir, 0o700).catch(() => undefined);
      if (lease.session.hasActivePersistFailure()) {
        lease.session.ydoc.getText('markdown').insert(lease.session.ydoc.getText('markdown').length, 'cleanup recovery\n');
        await lease.session.flush().catch(() => undefined);
      }
      lease.release();
      await manager.close();
    }
  });

  it('hydrates API sessions with default content, keeps them through idle grace, then closes them', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      idleSessionGraceMs: 20
    });

    const result = await manager.withSession(
      'api-created.md',
      async (session) => {
        await session.open();
        return session.getContent();
      },
      { defaultContent: '' }
    );

    expect(result).toBe('');
    expect(manager.getOpenSession('api-created.md')).toBeDefined();
    await waitUntil(() => manager.getOpenSessionCount() === 0, () =>
      `Timed out waiting for API session idle close; count=${manager.getOpenSessionCount()}`
    );
    await manager.close();
  });

  it('cancels a pending idle close when an API session is acquired again', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      idleSessionGraceMs: 30
    });

    const result = await manager.withSession(
      'api-retained.md',
      async (session) => {
        await session.open();
        return session;
      },
      { defaultContent: '' }
    );

    expect(manager.getOpenSession('api-retained.md')).toBe(result);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.getSession('api-retained.md')).toBe(result);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.getOpenSession('api-retained.md')).toBe(result);
    await manager.close();
  });

  it('does not idle-close an API-touched session while a client is attached', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: 'client\n',
      idleSessionGraceMs: 10
    });
    const lease = manager.attachClientSession('client-held.md');
    await lease.session.open();

    await manager.withSession('client-held.md', async (session) => {
      expect(session).toBe(lease.session);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.getOpenSession('client-held.md')).toBe(lease.session);

    lease.release();
    await waitUntil(() => manager.getOpenSessionCount() === 0, () =>
      `Timed out waiting for released client idle close; count=${manager.getOpenSessionCount()}`
    );
    await manager.close();
  });

  it('hydrates a fresh session when a client attaches while idle close is in flight', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: 'base\n',
      idleSessionGraceMs: 1
    });
    const original = manager.getSession('closing.md');
    await original.open();
    let closeStarted!: () => void;
    let allowClose!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const allowClosePromise = new Promise<void>((resolve) => {
      allowClose = resolve;
    });
    const originalClose = original.close.bind(original);
    original.close = async () => {
      closeStarted();
      await allowClosePromise;
      await originalClose();
    };

    await manager.withSession('closing.md', async (session) => {
      expect(session).toBe(original);
    });
    await closeStartedPromise;

    const attachedDuringClose = manager.attachClientSession('closing.md');
    try {
      expect(attachedDuringClose.session).not.toBe(original);
      await attachedDuringClose.session.open();
      expect(manager.getOpenSession('closing.md')).toBe(attachedDuringClose.session);
    } finally {
      allowClose();
      attachedDuringClose.release();
      await waitUntil(() => manager.getOpenSessionCount() === 0, () =>
        `Timed out waiting for fresh attached session to close; count=${manager.getOpenSessionCount()}`
      );
      await manager.close();
    }
  });

  it('logs unexpected idle close failures without keeping the failed session registered', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: '',
      idleSessionGraceMs: 1
    });
    const session = manager.getSession('close-error.md');
    await session.open();
    session.close = async () => {
      throw new Error('unexpected close failure');
    };

    try {
      await manager.withSession('close-error.md', async (active) => {
        expect(active).toBe(session);
      });
      await waitUntil(() => manager.getOpenSession('close-error.md') === undefined, () =>
        'Timed out waiting for failed close to unregister session'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to close idle document session'),
        expect.any(Error)
      );
    } finally {
      warnSpy.mockRestore();
      await manager.close();
    }
  });

  it('restores an idle-closing session when close discovers a persist failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: '',
      idleSessionGraceMs: 1
    });
    const session = manager.getSession('late-persist-failure.md');
    await session.open();
    const originalClose = session.close.bind(session);
    session.close = async () => {
      (session as unknown as { persistFailed: boolean }).persistFailed = true;
      throw new Error('late persist failure');
    };

    try {
      await manager.withSession('late-persist-failure.md', async (active) => {
        expect(active).toBe(session);
      });
      await waitUntil(() => warnSpy.mock.calls.length > 0, () =>
        'Timed out waiting for failed-persist close warning'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('refused to close idle document session'),
        expect.any(Error)
      );
      expect(manager.getOpenSession('late-persist-failure.md')).toBe(session);
      (session as unknown as { persistFailed: boolean }).persistFailed = false;
      session.close = originalClose;
    } finally {
      warnSpy.mockRestore();
      (session as unknown as { persistFailed: boolean }).persistFailed = false;
      session.close = originalClose;
      await manager.close();
    }
  });

  it('moves a single live manager session and updates the path registry', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: ''
    });
    const session = manager.getSession('single-move.md');
    await session.open();
    session.ydoc.getText('markdown').insert(0, 'single\n');
    await session.flush();

    await expect(manager.moveSession('single-move.md', 'moved-single.md', async () => {
      await rename(join(kb2Home, 'demo-vault', 'single-move.md'), join(kb2Home, 'demo-vault', 'moved-single.md'));
    })).resolves.toBe(true);

    expect(manager.getOpenSession('single-move.md')).toBeUndefined();
    expect(manager.getOpenSession('moved-single.md')).toBe(session);
    await expect(readFile(join(kb2Home, 'demo-vault', 'moved-single.md'), 'utf8')).resolves.toBe('single\n');
    await manager.close();
  });

  it('clears pending idle timers when the manager closes', async () => {
    const manager = new DocumentSessionManager({
      root: join(kb2Home, 'demo-vault'),
      defaultContent: '',
      idleSessionGraceMs: 10_000
    });
    await manager.withSession('timer.md', async (session) => {
      await session.open();
    });
    expect(manager.getOpenSession('timer.md')).toBeDefined();

    await manager.close();
    expect(manager.getOpenSessionCount()).toBe(0);
  });

  it('deletes every live session under a folder subtree once after the disk delete', async () => {
    const manager = new DocumentSessionManager({ root: join(kb2Home, 'demo-vault'), defaultContent: '' });
    const first = manager.getSession('folder/a.md');
    const second = manager.getSession('folder/deep/b.md');
    await first.open();
    await second.open();
    first.ydoc.getText('markdown').insert(0, 'a\n');
    second.ydoc.getText('markdown').insert(0, 'b\n');
    await Promise.all([first.flush(), second.flush()]);

    let deleteCalls = 0;
    const deleted = await manager.deleteSessionSubtree('folder', async () => {
      deleteCalls += 1;
      await rm(join(kb2Home, 'demo-vault', 'folder'), { recursive: true });
    });

    expect(deleted).toEqual(['folder/a.md', 'folder/deep/b.md']);
    expect(deleteCalls).toBe(1);
    expect(manager.getOpenSession('folder/a.md')).toBeUndefined();
    expect(manager.getOpenSession('folder/deep/b.md')).toBeUndefined();
    await manager.close();
  });
});

function eventKinds(events: DocumentSessionEvent[]): DocumentSessionEvent['kind'][] {
  return events.map((event) => event.kind);
}

function randomDocument(seed: number): string {
  const alphabet = ['a', 'b', 'c', ' ', '\n', '# ', '- ', '😀', '😃', '🧪', '𝌆'];
  let state = seed;
  const length = nextRandomInt(0, 80);
  let content = '';

  for (let index = 0; index < length; index += 1) {
    content += alphabet[nextRandomInt(0, alphabet.length - 1)];
  }

  return content;

  function nextRandomInt(min: number, max: number): number {
    state = (state * 1664525 + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  }
}

async function writeFileWithParents(pathname: string, content: string): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  await writeFile(pathname, content, 'utf8');
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errorMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage());
}
