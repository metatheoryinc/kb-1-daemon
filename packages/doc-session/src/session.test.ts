import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as Y from 'yjs';

import { createFastDiffYTextDelta } from './session.js';
import {
  OneFileDocumentSession,
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
