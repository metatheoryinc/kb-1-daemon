import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import type { QueryClient } from "@tanstack/svelte-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { queryKeys } from "$lib/realtime";
import type { NoteSnapshot } from "$lib/note/note-snapshot";
import AppStateHarness from "./AppStateHarness.svelte";
import { setPageUrl } from "./page-state.svelte";

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  destroyProvider: vi.fn(),
  providers: [] as Array<{ path: string; doc: Y.Doc; text: Y.Text }>,
  delayedSyncPaths: new Set<string>(),
  pendingSyncs: new Map<string, () => void>(),
}));

// The route derives the active vault + open document from the URL, so the
// `goto` mock NAVIGATES the reactive `page` mock (just like real SvelteKit:
// a `goto` lands a new URL, the page's `$derived`s recompute). It still
// records the call so navigation assertions hold. The helper is imported
// inside the factory (not the hoisted top scope) so the mock stays valid.
vi.mock("$app/navigation", async () => {
  const { setPageUrl: navigate } = await import("./page-state.svelte");
  return {
    goto: vi.fn((url: string, opts?: unknown) => {
      mocks.goto(url, opts);
      navigate(url);
      return Promise.resolve();
    }),
  };
});

// Reactive `page` stand-in (see page-state.svelte.ts) so `page.url` is the
// single source of truth for the route under test.
vi.mock("$app/state", async () => {
  const { page } = await import("./page-state.svelte");
  return { page };
});

vi.mock("@kb-1/editor", async () => {
  const { default: PlaintextEditor } =
    await import("./FakePlaintextEditor.svelte");
  return { PlaintextEditor };
});

vi.mock("$lib/yjs/demo-document-provider", async () => {
  const actual = await vi.importActual<
    typeof import("$lib/yjs/demo-document-provider")
  >("$lib/yjs/demo-document-provider");
  return {
    ...actual,
    createDemoDocumentProvider: vi.fn((options) => {
      const path = options.path ?? "hello-world.md";
      options.onStatus?.("syncing");
      const doc = new Y.Doc();
      const text = doc.getText("markdown");
      if (path === "projects/missing.md" || path === "deleted-later.md") {
        options.onStatus?.("closed");
        options.onError?.(
          new actual.DemoDocumentProviderOpenError({
            ok: false,
            error: "not_found",
            message: "file not found",
          }),
        );
      } else {
        text.insert(0, `content:${path}`);
        const open = () => {
          options.onStatus?.("open");
          options.onSynced?.();
        };
        if (mocks.delayedSyncPaths.has(path)) {
          mocks.pendingSyncs.set(path, open);
        } else {
          open();
        }
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

describe("local editor route", () => {
  beforeEach(() => {
    mocks.goto.mockReset();
    mocks.destroyProvider.mockReset();
    mocks.providers = [];
    mocks.delayedSyncPaths.clear();
    mocks.pendingSyncs.clear();
    // The harness builds the app-state store against `localStorage`, which
    // persists tree expansion and vault filters. Clear it so each test
    // starts from the clean first-load defaults rather than inheriting a
    // prior test's expanded folders or hidden vaults. happy-dom's
    // `localStorage.clear` isn't always present, so guard it.
    if (typeof window.localStorage?.clear === "function") {
      window.localStorage.clear();
    }
    // The route is now vault-segmented: `/<vaultId>/<path>`. The page mock
    // is the source of truth the route derives from; keep `window.history`
    // in sync too so bootstrap's `window.location.pathname` read agrees.
    setPageUrl("/demo-vault/hello-world.md");
    window.history.pushState(null, "", "/demo-vault/hello-world.md");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/vaults") {
          return json({
            ok: true,
            vaults: [{ id: "demo-vault", displayName: "demo-vault" }],
          });
        }
        if (url === "/api/vaults/demo-vault/tree") {
          return json({
            ok: true,
            entries: [
              {
                kind: "folder",
                path: "projects",
                size: 0,
                mtimeMs: 1,
                metadata: { color: "#d9f99d" },
              },
              {
                kind: "folder",
                path: "projects/active",
                size: 0,
                mtimeMs: 1,
                metadata: { color: "#fda4af" },
              },
              {
                kind: "folder",
                path: "attachments",
                size: 0,
                mtimeMs: 1,
              },
              {
                kind: "file",
                path: "projects/active/editor-shell.md",
                size: 12,
                mtimeMs: 1,
                artifact: {
                  kind: "text",
                  contentType: "text/markdown; charset=utf-8",
                  editable: true,
                  preview: "markdown",
                },
              },
              {
                kind: "file",
                path: "attachments/live.png",
                size: 4,
                mtimeMs: 1,
                artifact: {
                  kind: "attachment",
                  contentType: "image/png",
                  editable: false,
                  preview: "image",
                },
              },
              {
                kind: "file",
                path: "hello-world.md",
                size: 12,
                mtimeMs: 1,
                artifact: {
                  kind: "text",
                  contentType: "text/markdown; charset=utf-8",
                  editable: true,
                  preview: "markdown",
                },
              },
            ],
          });
        }
        if (url === "/api/vaults/demo-vault/files/hello-world.md/history?limit=25") {
          return json({
            ok: true,
            entries: [
              {
                id: "hist-2",
                path: "hello-world.md",
                operation: "update",
                actor: { kind: "user", id: "marcus", name: "Marcus" },
                integrationId: "agent-codex",
                createdAt: "2026-06-30T05:01:00.000Z",
                updatedAt: "2026-06-30T05:03:00.000Z",
                size: 14,
                contentHash: "hash-2",
              },
              {
                id: "hist-1",
                path: "hello-world.md",
                operation: "create",
                actor: { kind: "user", id: "olivia", name: "Olivia" },
                createdAt: "2026-06-30T05:00:00.000Z",
                updatedAt: "2026-06-30T05:00:00.000Z",
                size: 13,
                contentHash: "hash-1",
              },
            ],
            hasMore: true,
          });
        }
        if (
          url ===
          "/api/vaults/demo-vault/files/hello-world.md/history?before=2026-06-30T05%3A00%3A00.000Z&beforeId=hist-1&limit=25"
        ) {
          return json({
            ok: true,
            entries: [
              {
                id: "hist-0",
                path: "hello-world.md",
                operation: "update",
                actor: { kind: "agent", id: "local-agent", name: "local agent" },
                createdAt: "2026-06-30T04:55:00.000Z",
                updatedAt: "2026-06-30T04:55:00.000Z",
                size: 13,
                contentHash: "hash-0",
              },
            ],
            hasMore: false,
          });
        }
        return json(
          { ok: false, error: "not_found", message: `Unhandled ${url}` },
          404,
        );
      }),
    );
  });

  it("fetches the vault tree, renders it, and rebinds the editor when a file is opened", async () => {
    render(AppStateHarness);

    expect((await screen.findAllByText("demo-vault")).length).toBeGreaterThan(
      0,
    );
    expect(await screen.findByText("projects")).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => url === "/api/vaults/demo-vault/tree"),
    ).toBe(true);
    const initialEditor = (await screen.findByLabelText(
      "Markdown editor",
    )) as HTMLTextAreaElement;
    expect(initialEditor.value).toBe("content:hello-world.md");
    const initialDocGuid = initialEditor.dataset.docGuid;

    const filesPanel = within(
      screen.getByRole("complementary", { name: "Vault files" }),
    );
    await fireEvent.click(await filesPanel.findByText("projects"));
    await fireEvent.click(await filesPanel.findByText("active"));
    await fireEvent.click(filesPanel.getByText("editor-shell.md"));

    await waitFor(() => {
      expect(mocks.goto).toHaveBeenCalledWith(
        "/demo-vault/projects/active/editor-shell.md",
        {
          noScroll: true,
          keepFocus: true,
        },
      );
    });
    const treeEditor = await waitForBoundEditor(
      "content:projects/active/editor-shell.md",
    );
    expect(treeEditor.dataset.docGuid).not.toBe(initialDocGuid);

    await fireEvent.input(treeEditor, {
      target: { value: "typed into tree-opened file" },
    });
    const treeProvider = mocks.providers.at(-1);
    expect(treeProvider?.path).toBe("projects/active/editor-shell.md");
    expect(treeProvider?.text.toString()).toBe("typed into tree-opened file");
    expect(mocks.providers[0]?.text.toString()).toBe("content:hello-world.md");
  });

  it("paints a cached snapshot while syncing and preserves selection on live hydration", async () => {
    mocks.delayedSyncPaths.add("hello-world.md");
    const { container } = render(AppStateHarness, {
      props: {
        seedQueryClient: (client: QueryClient) => {
          client.setQueryData(
            queryKeys.note("demo-vault", "hello-world.md"),
            noteSnapshot({
              path: "hello-world.md",
              content: "cached hello world",
            }),
          );
        },
      },
    });

    let snapshotEditor!: HTMLTextAreaElement;
    await waitFor(() => {
      snapshotEditor = container.querySelector(
        ".snapshot-editor-layer textarea",
      ) as HTMLTextAreaElement;
      expect(snapshotEditor?.value).toBe("cached hello world");
    });

    snapshotEditor.focus();
    snapshotEditor.setSelectionRange(7, 12, "forward");
    document.dispatchEvent(new Event("selectionchange"));
    mocks.pendingSyncs.get("hello-world.md")?.();

    await waitFor(() => {
      expect(container.querySelector(".snapshot-editor-layer")).toBeNull();
    });
    const liveEditor = container.querySelector(
      ".live-editor-layer textarea",
    ) as HTMLTextAreaElement;
    expect(liveEditor.value).toBe("content:hello-world.md");
    await waitFor(() => {
      expect(liveEditor.selectionStart).toBe(7);
      expect(liveEditor.selectionEnd).toBe(12);
    });
  });

  it("opens attachment rows through the raw route instead of the document provider", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => ({ closed: false }) as Window);

    render(AppStateHarness);

    await screen.findByLabelText("Markdown editor");
    const initialProviderCount = mocks.providers.length;
    mocks.goto.mockClear();
    const filesPanel = within(
      screen.getByRole("complementary", { name: "Vault files" }),
    );

    await fireEvent.click(await filesPanel.findByText("attachments"));
    await fireEvent.click(filesPanel.getByText("live.png"));

    expect(openSpy).toHaveBeenCalledWith(
      "/api/vaults/demo-vault/raw/attachments/live.png",
      "_blank",
      "noopener,noreferrer",
    );
    expect(mocks.goto).not.toHaveBeenCalled();
    expect(mocks.providers).toHaveLength(initialProviderCount);

    openSpy.mockRestore();
  });

  it("renders direct attachment routes as raw-file links, not editable documents", async () => {
    setPageUrl("/demo-vault/attachments/live.png");
    window.history.pushState(null, "", "/demo-vault/attachments/live.png");

    render(AppStateHarness);

    const link = await screen.findByRole("link", { name: "Open live.png" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe(
      "/api/vaults/demo-vault/raw/attachments/live.png",
    );
    await waitFor(() => {
      expect(screen.queryByLabelText("Markdown editor")).toBeNull();
    });
  });

  it("hides the vault tree when the vault is toggled off in the filter", async () => {
    render(AppStateHarness);

    // The rail (and the shell) only render once the vault list loads —
    // zero vaults is a valid state that shows the empty "create your first
    // vault" screen instead — so wait for the rail before querying it.
    const filesPanel = within(
      await screen.findByRole("complementary", { name: "Vault files" }),
    );
    // The tree renders the vault's folders while the vault is visible.
    expect(await filesPanel.findByText("projects")).toBeTruthy();

    // Open the filter popover and toggle the lone vault off. The vault
    // row also matches /vault/i, so target the filter button by its
    // "All vaults" label.
    await fireEvent.click(
      filesPanel.getByRole("button", { name: "All vaults" }),
    );
    const popover = within(
      await screen.findByRole("dialog", { name: "Filter visible vaults" }),
    );
    await fireEvent.click(
      popover.getByRole("checkbox", { name: "Toggle demo-vault" }),
    );

    await waitFor(() => {
      expect(filesPanel.queryByText("projects")).toBeNull();
    });
  });

  it("renders an in-shell not-found state for missing document navigation without creating it", async () => {
    setPageUrl("/demo-vault/projects/missing.md");
    window.history.pushState(null, "", "/demo-vault/projects/missing.md");

    render(AppStateHarness);

    expect(await screen.findByText("Document not found")).toBeTruthy();
    expect(
      (await screen.findAllByText("projects/missing.md")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Markdown editor")).toBeNull();
    expect(
      vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);

    const filesPanel = within(
      screen.getByRole("complementary", { name: "Vault files" }),
    );
    // Deep-linking to `projects/missing.md` auto-expands its `projects`
    // ancestor, so the `active` folder is already reachable — open it and
    // pick the file without re-toggling `projects` (which would collapse).
    await fireEvent.click(await filesPanel.findByText("active"));
    await fireEvent.click(filesPanel.getByText("editor-shell.md"));

    const editor = await waitForBoundEditor(
      "content:projects/active/editor-shell.md",
    );
    expect(editor.value).toBe("content:projects/active/editor-shell.md");
  });

  it("opens note history from the byline and pages older entries", async () => {
    render(AppStateHarness);

    expect(await screen.findByLabelText("Markdown editor")).toBeTruthy();
    expect(screen.queryByTestId("document-history-panel")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/history")),
    ).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: "History" }));

    const panel = within(await screen.findByTestId("document-history-panel"));
    expect(await panel.findByText("Marcus")).toBeTruthy();
    expect(panel.getByText("Olivia")).toBeTruthy();
    expect(panel.queryByText("second version")).toBeNull();
    expect(panel.queryByText("first version")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url]) => url === "/api/vaults/demo-vault/files/hello-world.md/history?limit=25",
        ),
    ).toBe(true);

    await fireEvent.click(panel.getByRole("button", { name: "Load older" }));

    await waitFor(() => {
      expect(panel.getByText("local agent")).toBeTruthy();
    });
    expect(panel.queryByText("older version")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url]) =>
            url ===
            "/api/vaults/demo-vault/files/hello-world.md/history?before=2026-06-30T05%3A00%3A00.000Z&beforeId=hist-1&limit=25",
        ),
    ).toBe(true);
  });

  it("rebinds the editor on history navigation and can land on a deleted document path", async () => {
    render(AppStateHarness);

    const initialEditor = (await screen.findByLabelText(
      "Markdown editor",
    )) as HTMLTextAreaElement;
    expect(initialEditor.value).toBe("content:hello-world.md");
    const initialDocGuid = initialEditor.dataset.docGuid;

    await simulateNavigation("/demo-vault/projects/active/editor-shell.md");
    const nextEditor = await waitForBoundEditor(
      "content:projects/active/editor-shell.md",
    );
    expect(nextEditor.dataset.docGuid).not.toBe(initialDocGuid);
    await fireEvent.input(nextEditor, {
      target: { value: "history marker for active doc" },
    });
    expect(mocks.providers.at(-1)?.path).toBe(
      "projects/active/editor-shell.md",
    );
    expect(mocks.providers.at(-1)?.text.toString()).toBe(
      "history marker for active doc",
    );

    await simulateNavigation("/demo-vault/hello-world.md");
    const backEditor = await waitForBoundEditor("content:hello-world.md");
    expect(backEditor.dataset.docGuid).not.toBe(nextEditor.dataset.docGuid);
    expect(
      mocks.providers
        .find((provider) => provider.path === "projects/active/editor-shell.md")
        ?.text.toString(),
    ).toBe("history marker for active doc");

    await simulateNavigation("/demo-vault/deleted-later.md");
    expect(await screen.findByText("Document not found")).toBeTruthy();
    expect(
      (await screen.findAllByText("deleted-later.md")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Markdown editor")).toBeNull();
  });
});

async function waitForBoundEditor(
  content: string,
): Promise<HTMLTextAreaElement> {
  let editor!: HTMLTextAreaElement;
  await waitFor(() => {
    editor = screen.getByLabelText("Markdown editor") as HTMLTextAreaElement;
    expect(editor.value).toBe(content);
  });
  return editor;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noteSnapshot(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    vaultId: "demo-vault",
    path: "hello-world.md",
    version: 1,
    mtime: 1,
    size: overrides.content?.length ?? 0,
    contentType: "text/markdown; charset=utf-8",
    content: "",
    ...overrides,
  };
}

// History navigation (back/forward, deep-link) lands a new URL. The route
// derives everything from `page.url`, so point the page mock at the new
// pathname — the component's `$derived`s recompute exactly as they would
// under a real popstate. Keep `window.history` in sync for any direct
// `window.location` reads.
async function simulateNavigation(pathname: string): Promise<void> {
  setPageUrl(pathname);
  window.history.pushState(null, "", pathname);
  await Promise.resolve();
}
