import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import Page from '../routes/+page.svelte';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  destroyProvider: vi.fn(),
  providers: [] as Array<{ path: string; doc: Y.Doc; text: Y.Text }>,
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
      const path = options.path ?? 'hello-world.md';
      options.onStatus?.('syncing');
      const doc = new Y.Doc();
      const text = doc.getText('markdown');
      text.insert(0, `content:${path}`);
      mocks.providers.push({ path, doc, text });
      options.onStatus?.('open');
      options.onSynced?.();
      return {
        doc,
        text,
        destroy: mocks.destroyProvider,
      };
    }),
  };
});

describe('local editor route', () => {
  beforeEach(() => {
    mocks.goto.mockReset();
    mocks.destroyProvider.mockReset();
    mocks.providers = [];
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
      if (url.startsWith('/api/search?')) {
        return json({
          ok: true,
          results: [
            {
              path: 'research/search-hit.md',
              line: 1,
              lineText: 'Search target content',
              context: {},
            },
          ],
          total: 1,
          truncated: false,
        });
      }
      return json({ ok: false, error: 'not_found', message: `Unhandled ${url}` }, 404);
    }));
  });

  it('fetches the vault tree, renders it, and rebinds the editor when a file is opened', async () => {
    render(Page);

    expect((await screen.findAllByText('demo-vault')).length).toBeGreaterThan(0);
    expect(await screen.findByText('projects')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/tree')).toBe(true);
    const initialEditor = await screen.findByLabelText('Markdown editor') as HTMLTextAreaElement;
    expect(initialEditor.value).toBe('content:hello-world.md');
    const initialDocGuid = initialEditor.dataset.docGuid;

    await fireEvent.click(screen.getByText('projects'));
    await fireEvent.click(screen.getByText('active'));
    await fireEvent.click(screen.getByText('editor-shell.md'));

    await waitFor(() => {
      expect(mocks.goto).toHaveBeenCalledWith('/projects/active/editor-shell.md', {
        noScroll: true,
        keepFocus: true,
      });
    });
    const treeEditor = await waitForBoundEditor('content:projects/active/editor-shell.md');
    expect(treeEditor.dataset.docGuid).not.toBe(initialDocGuid);

    await fireEvent.input(treeEditor, { target: { value: 'typed into tree-opened file' } });
    const treeProvider = mocks.providers.at(-1);
    expect(treeProvider?.path).toBe('projects/active/editor-shell.md');
    expect(treeProvider?.text.toString()).toBe('typed into tree-opened file');
    expect(mocks.providers[0]?.text.toString()).toBe('content:hello-world.md');
  });

  it('rebinds the editor when a search result is opened', async () => {
    render(Page);

    const initialEditor = await screen.findByLabelText('Markdown editor') as HTMLTextAreaElement;
    expect(initialEditor.value).toBe('content:hello-world.md');

    const search = screen.getByPlaceholderText('Search files');
    await fireEvent.input(search, { target: { value: 'target' } });
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/search?'))).toBe(true);
    });

    await fireEvent.click(await screen.findByText('research/search-hit.md'));

    await waitFor(() => {
      expect(mocks.goto).toHaveBeenCalledWith('/research/search-hit.md', {
        noScroll: true,
        keepFocus: true,
      });
    });
    const searchEditor = await waitForBoundEditor('content:research/search-hit.md');

    await fireEvent.input(searchEditor, { target: { value: 'typed into search-opened file' } });
    const searchProvider = mocks.providers.at(-1);
    expect(searchProvider?.path).toBe('research/search-hit.md');
    expect(searchProvider?.text.toString()).toBe('typed into search-opened file');
  });
});

async function waitForBoundEditor(content: string): Promise<HTMLTextAreaElement> {
  let editor!: HTMLTextAreaElement;
  await waitFor(() => {
    editor = screen.getByLabelText('Markdown editor') as HTMLTextAreaElement;
    expect(editor.value).toBe(content);
  });
  return editor;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
