import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import Page from '../routes/+page.svelte';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  destroyProvider: vi.fn(),
}));

vi.mock('$app/navigation', () => ({
  goto: mocks.goto,
}));

vi.mock('@kb-2/editor', async () => {
  const { default: PlaintextEditor } = await import('./FakePlaintextEditor.svelte');
  return { PlaintextEditor };
});

vi.mock('$lib/yjs/demo-document-provider', async () => {
  const actual = await vi.importActual<typeof import('$lib/yjs/demo-document-provider')>(
    '$lib/yjs/demo-document-provider',
  );
  return {
    ...actual,
    createDemoDocumentProvider: vi.fn((options) => {
      options.onStatus?.('open');
      const doc = new Y.Doc();
      return {
        doc,
        text: doc.getText('markdown'),
        destroy: mocks.destroyProvider,
      };
    }),
  };
});

describe('local editor route', () => {
  beforeEach(() => {
    mocks.goto.mockReset();
    mocks.destroyProvider.mockReset();
    window.history.pushState(null, '', '/hello-world.md');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/vault') {
        return json({ ok: true, rootName: 'demo-vault' });
      }
      if (url === '/api/tree') {
        return json({
          ok: true,
          entries: [
            { kind: 'folder', path: 'projects', size: 0, mtimeMs: 1, metadata: { color: 'sage' } },
            { kind: 'folder', path: 'projects/active', size: 0, mtimeMs: 1, metadata: { color: 'coral' } },
            { kind: 'file', path: 'projects/active/editor-shell.md', size: 12, mtimeMs: 1 },
            { kind: 'file', path: 'hello-world.md', size: 12, mtimeMs: 1 },
          ],
        });
      }
      return json({ ok: false, error: 'not_found', message: `Unhandled ${url}` }, 404);
    }));
  });

  it('fetches the vault tree, renders it, and navigates with keepFocus when a file is opened', async () => {
    render(Page);

    expect((await screen.findAllByText('demo-vault')).length).toBeGreaterThan(0);
    expect(await screen.findByText('projects')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/tree')).toBe(true);

    await fireEvent.click(screen.getByText('projects'));
    await fireEvent.click(screen.getByText('active'));
    await fireEvent.click(screen.getByText('editor-shell.md'));

    await waitFor(() => {
      expect(mocks.goto).toHaveBeenCalledWith('/projects/active/editor-shell.md', {
        noScroll: true,
        keepFocus: true,
      });
    });
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
