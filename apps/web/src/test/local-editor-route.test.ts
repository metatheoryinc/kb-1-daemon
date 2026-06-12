import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import Page from '../routes/+page.svelte';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  afterNavigateCallbacks: [] as Array<(navigation: { to: { url: URL } | null; type: string }) => void>,
  destroyProvider: vi.fn(),
  providers: [] as Array<{ path: string; doc: Y.Doc; text: Y.Text }>,
}));

vi.mock('$app/navigation', () => ({
  goto: mocks.goto,
  afterNavigate: vi.fn((callback) => {
    mocks.afterNavigateCallbacks.push(callback);
    return () => {
      mocks.afterNavigateCallbacks = mocks.afterNavigateCallbacks.filter((candidate) => candidate !== callback);
    };
  }),
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
      if (path === 'projects/missing.md' || path === 'deleted-later.md') {
        options.onStatus?.('closed');
        options.onError?.(new actual.DemoDocumentProviderOpenError({
          ok: false,
          error: 'not_found',
          message: 'file not found',
        }));
      } else {
        text.insert(0, `content:${path}`);
        options.onStatus?.('open');
        options.onSynced?.();
      }
      mocks.providers.push({ path, doc, text });
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
    mocks.afterNavigateCallbacks = [];
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

    const filesPanel = within(screen.getByRole('complementary', { name: 'Vault files' }));
    await fireEvent.click(await filesPanel.findByText('projects'));
    await fireEvent.click(await filesPanel.findByText('active'));
    await fireEvent.click(filesPanel.getByText('editor-shell.md'));

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

  it('renders an in-shell not-found state for missing document navigation without creating it', async () => {
    window.history.pushState(null, '', '/projects/missing.md');

    render(Page);

    expect(await screen.findByText('Document not found')).toBeTruthy();
    expect((await screen.findAllByText('projects/missing.md')).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Markdown editor')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    const filesPanel = within(screen.getByRole('complementary', { name: 'Vault files' }));
    await fireEvent.click(await filesPanel.findByText('projects'));
    await fireEvent.click(await filesPanel.findByText('active'));
    await fireEvent.click(filesPanel.getByText('editor-shell.md'));

    const editor = await waitForBoundEditor('content:projects/active/editor-shell.md');
    expect(editor.value).toBe('content:projects/active/editor-shell.md');
  });

  it('rebinds the editor on history navigation and can land on a deleted document path', async () => {
    render(Page);

    const initialEditor = await screen.findByLabelText('Markdown editor') as HTMLTextAreaElement;
    expect(initialEditor.value).toBe('content:hello-world.md');
    const initialDocGuid = initialEditor.dataset.docGuid;

    await simulateNavigation('/projects/active/editor-shell.md');
    const nextEditor = await waitForBoundEditor('content:projects/active/editor-shell.md');
    expect(nextEditor.dataset.docGuid).not.toBe(initialDocGuid);
    await fireEvent.input(nextEditor, { target: { value: 'history marker for active doc' } });
    expect(mocks.providers.at(-1)?.path).toBe('projects/active/editor-shell.md');
    expect(mocks.providers.at(-1)?.text.toString()).toBe('history marker for active doc');

    await simulateNavigation('/hello-world.md');
    const backEditor = await waitForBoundEditor('content:hello-world.md');
    expect(backEditor.dataset.docGuid).not.toBe(nextEditor.dataset.docGuid);
    expect(mocks.providers.find((provider) => provider.path === 'projects/active/editor-shell.md')?.text.toString())
      .toBe('history marker for active doc');

    await simulateNavigation('/deleted-later.md');
    expect(await screen.findByText('Document not found')).toBeTruthy();
    expect((await screen.findAllByText('deleted-later.md')).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Markdown editor')).toBeNull();
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

async function simulateNavigation(pathname: string): Promise<void> {
  window.history.pushState(null, '', pathname);
  for (const callback of mocks.afterNavigateCallbacks) {
    callback({
      to: { url: new URL(window.location.href) },
      type: 'popstate',
    });
  }
  await Promise.resolve();
}
