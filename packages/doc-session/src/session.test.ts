import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as Y from 'yjs';

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

  it('reconciles direct filesystem changes into the active session', async () => {
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

    expect(events.filter((event) => event.kind === 'external-change')).toHaveLength(1);
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
    expect(events.filter((event) => event.kind === 'external-change')).toHaveLength(0);
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

    expect(events.filter((event) => event.kind === 'external-change')).toHaveLength(1);
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
    const warnings: DocumentSessionWarning[] = [];
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: 'active\n',
      warn: (warning) => warnings.push(warning)
    });
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
    await session.close();
  });
});

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
