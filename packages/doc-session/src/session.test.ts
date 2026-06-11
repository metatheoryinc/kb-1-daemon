import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

    expect(eventKinds(events)).toEqual(['external-merge']);
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
