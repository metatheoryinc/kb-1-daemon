<script lang="ts">
  import { onMount } from 'svelte';
  import type { Doc } from 'yjs';
  import * as Y from 'yjs';
  import {
    EditorState,
    Annotation,
    Compartment,
    Facet,
    type Extension,
  } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    highlightActiveLine,
    ViewPlugin,
    type PluginValue,
    type ViewUpdate,
  } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
  import { PLAINTEXT_USER_ORIGIN } from './content-format';
  import type { LivePath, OrgPerson } from './markdown-core';
  import {
    plaintextDecorations,
    livePathsChangedEffect,
    mentionDirectoryChangedEffect,
  } from './plaintext-decorations';
  import {
    plaintextLinkClickHandler,
    plaintextLinkHover,
  } from './plaintext-link-affordance';
  import { plaintextMentionKeymap } from './plaintext-mention-keymap';
  import { plaintextMentionAutocomplete } from './plaintext-mention-autocomplete.svelte';
  import { plaintextListKeymap } from './plaintext-list-keymap';
  import { plaintextLinkPaste } from './plaintext-link-paste';
  import { plaintextImageUpload } from './plaintext-image-upload';
  // Remote-cursor layer. Mounted only when the host supplies
  // both `awareness` and `noteId` — the daemon UI, which has no presence,
  // passes neither and the producer/consumer are skipped entirely.
  import type { Awareness } from 'y-protocols/awareness';
  import {
    plaintextCursorProducer,
    plaintextCursorConsumer,
  } from './plaintext-awareness';

  interface PlaintextSyncConfig {
    ydoc: Doc;
    ytext: Y.Text;
  }

  const plaintextSyncConfig = Facet.define<
    PlaintextSyncConfig,
    PlaintextSyncConfig | null
  >({
    combine(values) {
      return values.at(-1) ?? null;
    },
  });

  const syncAnnotation = Annotation.define<symbol>();
  const SYNC_MARK = Symbol('plaintext-sync');

  class PlaintextSyncPlugin implements PluginValue {
    private view: EditorView;
    private ydoc: Doc;
    private ytext: Y.Text;
    private observer: (
      event: Y.YTextEvent,
      transaction: Y.Transaction,
    ) => void;
    private reconcileTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(view: EditorView) {
      this.view = view;
      const config = view.state.facet(plaintextSyncConfig);
      if (!config) {
        throw new Error('PlaintextSyncPlugin requires plaintextSyncConfig');
      }
      this.ydoc = config.ydoc;
      this.ytext = config.ytext;
      this.observer = (event, _tr) => {
        // Skip echo of our own local writes.
        if (event.transaction.origin === PLAINTEXT_USER_ORIGIN) return;
        const delta = event.delta;
        const changes: { from: number; to: number; insert: string }[] = [];
        let pos = 0;
        for (const d of delta) {
          if (d.insert != null) {
            const text = typeof d.insert === 'string' ? d.insert : '';
            if (text.length > 0) {
              changes.push({ from: pos, to: pos, insert: text });
            }
          } else if (d.delete != null) {
            changes.push({ from: pos, to: pos + d.delete, insert: '' });
            pos += d.delete;
          } else if (d.retain != null) {
            pos += d.retain;
          }
        }
        if (changes.length === 0) return;
        view.dispatch({
          changes,
          annotations: [syncAnnotation.of(SYNC_MARK)],
        });
      };
      this.ytext.observe(this.observer);
      this.reconcileFromYText();
      this.reconcileTimer = setTimeout(() => {
        this.reconcileTimer = undefined;
        this.reconcileFromYText();
      }, 50);
    }

    private reconcileFromYText(): void {
      const syncedText = this.ytext.toString();
      if (syncedText !== this.view.state.doc.toString()) {
        this.view.dispatch({
          changes: {
            from: 0,
            to: this.view.state.doc.length,
            insert: syncedText,
          },
          annotations: [syncAnnotation.of(SYNC_MARK)],
        });
      }
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      // Skip CM dispatches that came from the inbound Y.Text observer.
      for (const tr of update.transactions) {
        if (tr.annotation(syncAnnotation) === SYNC_MARK) return;
      }
      // Local user edits — write them back to Y.Text with our origin.
      this.ydoc.transact(() => {
        let adj = 0;
        update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
          const insertText = insert.sliceString(0, insert.length, '\n');
          if (fromA !== toA) {
            this.ytext.delete(fromA + adj, toA - fromA);
          }
          if (insertText.length > 0) {
            this.ytext.insert(fromA + adj, insertText);
          }
          adj += insertText.length - (toA - fromA);
        });
      }, PLAINTEXT_USER_ORIGIN);
    }

    destroy(): void {
      if (this.reconcileTimer) {
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = undefined;
      }
      this.ytext.unobserve(this.observer);
    }
  }

  const plaintextSyncPlugin = ViewPlugin.fromClass(PlaintextSyncPlugin);

  interface Props {
    /** Shared Y.Doc supplied by the host app/provider. */
    ydoc: Doc;
    /** Bound Y.Text supplied by the host app/provider. */
    ytext: Y.Text;
    /** Disables typing. Mirror of MarkdownEditor's prop. */
    readOnly?: boolean;
    /** Accessibility label for the editor host. */
    ariaLabel?: string;
    /** Wrapper class — same convention as MarkdownEditor. */
    class?: string;
    /** Scroll ownership — 'self' for standalone, 'external' when the
     *  parent owns the scroll container. Defaults to 'self'. */
    scroll?: 'self' | 'external';
    /** Optional attachment URL resolver. When provided, image source
     *  paths in the markdown (`![](some/path.png)`) that don't look
     *  like absolute URLs are routed through this function to produce
     *  the actual `<img src>`. Mirrors MarkdownEditor's prop of the
     *  same name. Omit to disable attachment-path remapping (Storybook
     *  / no-vault contexts) — bare paths pass through and the browser
     *  renders a broken-image icon. */
    attachmentSrc?: (path: string) => string;
    /** Vault live-path snapshot for wikilink resolution (Slice 5).
     *  Mirrors MarkdownEditor's prop of the same name. The decoration
     *  builder runs each `[[target]]` through `resolveLinkTarget`
     *  against this list to decide between the resolved
     *  (`cm-md-wikilink-label`) and broken
     *  (`cm-md-wikilink-broken`) styles. Pass an empty array (or omit)
     *  when no resolution context is available — every wikilink will
     *  render as broken in that case, which matches reality.
     *
     *  Reactive: when the reference changes (vault tree update, vault
     *  switch), the editor dispatches a `livePathsChangedEffect` so the
     *  decoration field re-resolves without needing a doc edit. */
    livePaths?: readonly LivePath[];
    /** Org directory snapshot for mention chip resolution. Mirrors
     *  MarkdownEditor's prop of the same name. The decoration builder
     *  runs each `[Name](mention:email)` through `resolvePerson`
     *  against this list to decide between the resolved and stale
     *  variants of the `MentionChipWidget` (see
     *  `plaintext-mention-widget.ts` — the resolved variant uses the
     *  user's accent + image, the stale variant falls back to slate +
     *  a muted line-through label). Pass an empty array (or omit) when
     *  no resolution context is available — every mention will render
     *  as stale, which matches reality.
     *
     *  Reactive: when the reference changes (org switch, member added/
     *  removed), the editor dispatches a `mentionDirectoryChangedEffect`
     *  so the decoration field re-resolves without needing a doc edit. */
    orgPeople?: readonly OrgPerson[];
    /** Enables cloud people search / insertion for `@` mentions. Off by
     *  default so daemon contexts can render mention chips from markdown
     *  without exposing cloud org-directory picker semantics. */
    enableMentionAutocomplete?: boolean;
    /** Wikilink click handler (Slice 6). Fires with the URL-encoded
     *  target so the host can decode + resolve + navigate. Mirrors
     *  MarkdownEditor's prop of the same name — both editors feed the
     *  same `DocumentCanvas.handleWikilinkClick` upstream so resolution
     *  and routing stay unified. Omit when there's no navigation context
     *  (Storybook, no-vault tests) — clicks on wikilinks no-op then. */
    onWikilinkClick?: (encodedTarget: string, event: MouseEvent) => void;
    /** Paste/drop image upload hook. Hosts decide where bytes are written;
     *  the editor stores only the returned markdown path. */
    uploadImage?: (file: File) => Promise<{ path: string }>;
    onUploadStart?: () => void;
    onUploadEnd?: () => void;
    onError?: (err: unknown, file: File) => void;
    /** Vault-scoped awareness handle. When supplied
     *  (together with `noteId`), the editor publishes the local caret /
     *  selection to `awareness.cursor` and renders remote peers' carets +
     *  selections. Optional and backward-compatible: the daemon UI has no
     *  presence and omits it, so the cursor producer/consumer never mount. */
    awareness?: Awareness;
    /** Stable noteId of the note this editor is bound to. Used by the cursor
     *  layer to (a) tag the local cursor payload and (b) filter remote peers
     *  whose cursor targets a different note. Required only when `awareness`
     *  is supplied. */
    noteId?: string;
  }

  let {
    ydoc,
    ytext,
    readOnly = false,
    ariaLabel = 'Markdown editor',
    class: className,
    scroll = 'self',
    attachmentSrc,
    livePaths = [],
    orgPeople = [],
    enableMentionAutocomplete = false,
    onWikilinkClick,
    uploadImage,
    onUploadStart,
    onUploadEnd,
    onError,
    awareness,
    noteId,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  // EditorView ref kept module-scoped so the `livePaths` effect below
  // can dispatch the `livePathsChangedEffect` whenever the parent's
  // reactive snapshot reference shifts. Initialized to null and
  // populated in `onMount`.
  let editorView = $state<EditorView | null>(null);
  let readOnlyCompartment: Compartment | null = null;
  let editableCompartment: Compartment | null = null;

  // Note: the user-driven view↔edit toggle that originally shipped with
  // Slice 3 (floating button + Cmd-E keymap + Compartment-wrapped
  // editable facet) was decommissioned once Slices F (focus-aware
  // syntax reveal) and S (H-level gutter chip) landed. The combination
  // of those two slices makes the toggle redundant: clicking outside
  // the editor blurs focus, which hides syntax characters and reveals
  // the H-chips for a clean reading view; clicking back into the
  // editor focuses it and reveals the source `#`/`##`/`###` on the
  // active line for editing. The `readOnly` prop below remains the
  // parent's hook for soft-revoked-grant enforcement; it gates
  // EditorState.readOnly + EditorView.editable at mount.

  onMount(() => {
    if (!host) return;
    readOnlyCompartment = new Compartment();
    editableCompartment = new Compartment();

    // Capture stable refs — same reasoning as MarkdownEditor.svelte:469:
    // Svelte 5 `$props` getters re-read on every access including
    // during cleanup. If the parent flips `binding` to null mid-tear-
    // down, lazy reads would throw on the cleanup path.
    const stableDoc = ydoc;
    const stableAttachmentSrc = attachmentSrc;
    // livePaths is captured via getter, not snapshot, so the wikilink
    // decoration re-resolves on every rebuild against the parent's
    // latest reactive value. Same pattern as the Crepe-side wikilink
    // plugin in `wikilink-decoration-plugin.ts`.
    const stableGetLivePaths = (): readonly LivePath[] => livePaths;
    // orgPeople gets the same getter treatment for the same reason —
    // mention chip resolution needs the latest directory each rebuild.
    const stableGetOrgPeople = (): readonly OrgPerson[] => orgPeople;
    // onWikilinkClick is also a $props getter — capture via a closure
    // so the click handler reads the latest reactive callback without
    // re-instantiating the extension. Returning `null` when the prop is
    // undefined lets the affordance treat "no handler" as a no-op
    // (mirrors MarkdownEditor's `if (!onWikilinkClick) return` guard).
    const stableWikilinkClick = (
      encoded: string,
      event: MouseEvent,
    ): void => {
      const handler = onWikilinkClick;
      if (handler === undefined) return;
      handler(encoded, event);
    };
    const stableText = ytext;
    // Capture the awareness handle + noteId once at mount, mirroring KB-1's
    // `stableAwareness`/`stableNoteId` — survives Svelte 5 props-getter aliasing
    // for the cursor producer/consumer closures.
    const stableAwareness = awareness;
    const stableNoteId = noteId;

    // --- Sync plugin (replaces y-codemirror.next's `ySync`) ---------
    //
    // Mirrors upstream `y-sync.js`. The only meaningful differences:
    //   - Local CM dispatches transact onto Y.Text with origin =
    //     PLAINTEXT_USER_ORIGIN (a string) rather than the per-editor
    //     YSyncConfig instance, so the spec contract holds verbatim.
    //   - Inbound Y.Text events (origin !== PLAINTEXT_USER_ORIGIN) are
    //     dispatched into CM as edits annotated `syncAnnotation` so
    //     the update() loop can skip its own echo.
    const plaintextSync: Extension = [
      plaintextSyncConfig.of({ ydoc: stableDoc, ytext: stableText }),
      plaintextSyncPlugin,
    ];

    // --- Undo manager ----------------------------------------------
    //
    // Scoped to local user edits only. Agent splices ('plaintext-agent'),
    // peer typing (vault channel wireOrigin), and system updates
    // (hydrate with null origin) are NOT tracked — so Ctrl-Z never
    // reaches them. This is the spec's "Undo and origin tagging"
    // contract: pressing undo undoes your own typing; it does not
    // undo agent edits or remote collaborators' typing.
    const undoManager = new Y.UndoManager(stableText, {
      trackedOrigins: new Set([PLAINTEXT_USER_ORIGIN]),
    });
    const undoCmd = (): boolean => {
      undoManager.undo();
      return true;
    };
    const redoCmd = (): boolean => {
      undoManager.redo();
      return true;
    };

    // --- Theme -----------------------------------------------------
    //
    // Document-surface theme. Distinct from the app chrome (Inter
    // Tight UI, system mono) — `.txt` content uses the prose-body face
    // so the editor *feels* like a thoughtful reading surface, not
    // another panel of UI. Today that face is Geist (Vercel's OFL sans)
    // under preview evaluation, resolved via `--rd-sans-prose` and
    // self-hosted via `@fontsource-variable/geist` from `src/app.css`.
    // The previous Source Serif 4 stack remains defined as `--rd-serif`
    // in `tokens.css` so reverting is a one-line edit. Swap the body
    // face by re-pointing `font-family` below at a different token.
    //
    // Reading width is owned by the outer `.doc-column` wrapper (in
    // DocumentCanvas.svelte), not this theme — the column geometry is
    // shared with `DocumentByline` so byline + editor align
    // structurally. Color is a muted near-black (--rd-ink-2) rather
    // than pure black so heavy text doesn't burn.
    //
    // Font-smoothing — mirror Vercel docs body declarations so Geist
    // renders with the slightly thinner, crisper feel they ship with.
    // Harmless on the previous serif stack and on other surfaces that
    // don't read this theme, since it only applies inside CM6's root.
    //
    // No line-number gutter: `lineNumbers` is NOT in the extension list
    // and the empty CM gutter element is hidden via `.cm-gutters { display:
    // none }` below. The intent is "this is a document, not code".
    const documentTheme = EditorView.theme({
      '&': {
        height: scroll === 'self' ? '100%' : 'auto',
        fontFamily:
          "var(--rd-sans-prose, 'Geist Variable', system-ui, -apple-system, 'Segoe UI', sans-serif)",
        fontSize: '16px',
        color: 'var(--rd-ink-2, #2a2a2a)',
        background: 'transparent',
        textRendering: 'optimizeLegibility',
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
      },
      '.cm-scroller': {
        fontFamily: 'inherit',
        overflow: scroll === 'self' ? 'auto' : 'visible',
        lineHeight: '1.65',
      },
      '.cm-content': {
        // Tight top padding — the byline sits immediately above with
        // its own 6px bottom-pad, and the `:first-child` rule below
        // collapses the heading's intrinsic top-padding. 8px here
        // gives a small intentional gap between byline bottom edge
        // and the heading's first glyph without re-introducing the
        // pre-fix slack. 64px bottom keeps the scroll runway.
        padding: '8px 0 64px 0',
        caretColor: 'var(--rd-ink-1, #1a1d22)',
      },
      // Kill the gutter entirely — no line numbers, no fold gutter, no
      // empty rail. The extension `lineNumbers()` is also dropped from
      // the extension list above; this rule covers any residual gutter
      // element CM6 renders by default.
      '.cm-gutters': {
        display: 'none',
      },
      // Soften the active-line highlight so it doesn't read as a code
      // editor's full-bleed line band. Near-invisible warm tint.
      '.cm-activeLine': {
        backgroundColor: 'transparent',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(80, 120, 180, 0.18)',
      },
    });

    // Seed the editor's initial doc from the live Y.Text. Subsequent
    // remote/agent updates land via the observer; subsequent local
    // edits land via update().
    const extensions: Extension[] = [
      history(),
      // `lineNumbers()` deliberately omitted — see `documentTheme`
      // comment above for the "document not code" rationale.
      highlightActiveLine(),
      EditorView.lineWrapping,
      // Parent-controlled enforcement point. The compartments are
      // reconfigured when a live session enters doc-deleted/read-only state.
      readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      editableCompartment.of(EditorView.editable.of(!readOnly)),
      documentTheme,
      plaintextSync,
      // Remote-cursor producer + consumer. Mounted only when the host supplied
      // both an `awareness` handle and a `noteId`; the daemon UI omits both, so
      // this is a no-op there. The producer writes the local caret to
      // `awareness.cursor`; the consumer renders remote peers'
      // carets/selections. Must sit AFTER `plaintextSync` so the CM doc and
      // Y.Text are in sync before RelPos are built.
      ...(stableAwareness && stableNoteId !== undefined
        ? [
            plaintextCursorProducer(stableAwareness, stableText, stableNoteId),
            plaintextCursorConsumer(stableAwareness, stableText, stableNoteId),
          ]
        : []),
      // Live-preview-style markdown decorations. They are document +
      // selection driven and compose through EditorView.decorations:
      // line decos wrap the line element, mark decos wrap their range,
      // and widgets replace rendered markdown constructs.
      plaintextDecorations({
        attachmentSrc: stableAttachmentSrc,
        getLivePaths: stableGetLivePaths,
        getOrgPeople: stableGetOrgPeople,
        onWikilinkClick: stableWikilinkClick,
      }),
      // Slice 6 — link click + wikilink hover preview. Two separate
      // extensions because they hook different CM6 surfaces (DOM
      // events vs hoverTooltip); kept in a sibling file so the
      // decoration pipeline stays focused on painting. The click
      // handler routes URL links to a new tab and wikilinks back to
      // the host via the same encoded-target contract MarkdownEditor
      // uses. The hover tooltip surfaces the resolved path / "Note
      // not found" for wikilinks — markdown editor doesn't have this
      // yet; parity follow-up.
      plaintextLinkClickHandler(stableWikilinkClick),
      plaintextLinkHover(stableGetLivePaths),
      // Atomic-edge delete for mention chips (Apple lane Slice 1).
      // MUST sit BEFORE the `keymap.of([...defaultKeymap])` below so
      // Backspace / Delete reach this handler first when the caret is
      // at a mention's edge — defaultKeymap's per-char delete would
      // otherwise consume the closing `)` before the chip-deletion
      // handler ran. Caret INSIDE the mention falls through to default
      // delete (typo-fix carve-out for the display name).
      plaintextMentionKeymap(),
      ...(enableMentionAutocomplete
        ? [plaintextMentionAutocomplete({ getOrgPeople: stableGetOrgPeople })]
        : []),
      // Tab / Shift-Tab indent / outdent for list items (Apple lane
      // Feature 3). Gates on lezer `ListItem` ancestry; Tab outside
      // any list falls through (returns false) so browser focus
      // traversal stays intact for keyboard-only users. Single-line
      // v1 — multi-line block indent is a deferred follow-up.
      plaintextListKeymap(),
      // Paste-a-URL-as-markdown-link: any URL over a selection wraps
      // it as `[selection](url)`; a note URL with no selection
      // inserts `[note name](url)`. Non-URL pastes (and URL pastes
      // that match neither rule) fall through to default CM6 paste.
      // See `plaintext-link-paste.ts` for the decision rules.
      ...(uploadImage && !readOnly
        ? [
            plaintextImageUpload({
              uploadFile: uploadImage,
              ytext: stableText,
              ydoc: stableDoc,
              onUploadStart,
              onUploadEnd,
              onError,
            }),
          ]
        : []),
      ...(!readOnly ? [plaintextLinkPaste()] : []),
      keymap.of([
        { key: 'Mod-z', run: undoCmd, preventDefault: true },
        { key: 'Mod-y', mac: 'Mod-Shift-z', run: redoCmd, preventDefault: true },
        { key: 'Mod-Shift-z', run: redoCmd, preventDefault: true },
        // Enter on a list line continues the list (new bullet at same
        // indent); Enter on an empty list line exits the list. From
        // @codemirror/lang-markdown's markdownKeymap bundle — we pull
        // only this one command (not the bundle, which would override
        // Backspace and conflict with plaintextMentionKeymap's atomic
        // edge delete). Must sit BEFORE defaultKeymap's Enter (which
        // would just insert a plain newline).
        { key: 'Enter', run: insertNewlineContinueMarkup },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
    ];

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        // `toJSON()` returns the unformatted string body — same value
        // `toString()` would, but the typed entry-point per `yjs.d.ts`.
        doc: stableText.toString(),
        extensions,
      }),
    });
    editorView = view;

    return () => {
      editorView = null;
      readOnlyCompartment = null;
      editableCompartment = null;
      view.destroy();
      undoManager.destroy();
    };
  });

  $effect(() => {
    const view = editorView;
    const readOnlyFacet = readOnlyCompartment;
    const editableFacet = editableCompartment;
    if (view === null || readOnlyFacet === null || editableFacet === null) return;

    view.dispatch({
      effects: [
        readOnlyFacet.reconfigure(EditorState.readOnly.of(readOnly)),
        editableFacet.reconfigure(EditorView.editable.of(!readOnly)),
      ],
    });
  });

  /**
   * livePaths-changed effect (Slice 5). Sibling of MarkdownEditor's
   * livePaths effect at MarkdownEditor.svelte:1441-1462. When the
   * parent's `livePaths` reference flips (vault tree update, vault
   * switch) we dispatch a `livePathsChangedEffect` so the decoration
   * field's `update` callback re-resolves every wikilink against the
   * fresh snapshot — without this the resolved/broken state would
   * remain stale until the next user keystroke.
   */
  $effect(() => {
    void livePaths;
    const view = editorView;
    if (view === null) return;
    view.dispatch({ effects: livePathsChangedEffect.of(null) });
  });

  /**
   * orgPeople-changed effect (sibling of livePaths). When the parent's
   * `orgPeople` reference flips (org switch, member added/removed) we
   * dispatch a `mentionDirectoryChangedEffect` so the decoration field's
   * `update` callback re-resolves every mention chip against the fresh
   * directory — without this the resolved/stale state would remain stale
   * until the next user keystroke.
   */
  $effect(() => {
    void orgPeople;
    const view = editorView;
    if (view === null) return;
    view.dispatch({ effects: mentionDirectoryChangedEffect.of(null) });
  });
</script>

<div
  class={[
    'kb1-editor-shell',
    scroll === 'self' ? 'scroll-self' : 'scroll-external',
    className,
  ].filter(Boolean).join(' ')}
  data-readonly={readOnly}
>
  <div
    bind:this={host}
    class={[
      'plaintext-editor',
      scroll === 'self' ? 'editor-scroll-self' : 'editor-scroll-external',
    ].join(' ')}
    role={readOnly ? 'document' : 'textbox'}
    aria-label={ariaLabel}
  ></div>
</div>

<style>
  .kb1-editor-shell {
    position: relative;
    display: flex;
    width: 100%;
    min-height: 0;
    flex-direction: column;
    background: var(--rd-panel, #ffffff);
  }

  .kb1-editor-shell.scroll-self {
    height: 100%;
    overflow: hidden;
  }

  .plaintext-editor {
    width: 100%;
  }

  .plaintext-editor.editor-scroll-self {
    height: 100%;
    overflow: auto;
  }

  .plaintext-editor.editor-scroll-external {
    overflow: visible;
  }

  /* CodeMirror manages its own DOM and styling; the host div above is
     a thin wrapper providing layout + scroll-container ownership. The
     theme extension in the script handles font/padding/gutter cosmetics;
     the markdown decoration classes below style ranges emitted by
     `plaintextDecorations()` (see plaintext-decorations.ts).

     CM6 emits decoration classes on its own DOM nodes (`.cm-line` for
     line decos, raw `<span>` for mark decos), so all the rules below
     are wrapped in `:global()` to escape Svelte's CSS scoping. */
  .plaintext-editor :global(.cm-editor) {
    outline: none;
    height: 100%;
  }
  .plaintext-editor :global(.cm-editor.cm-focused) {
    outline: none;
  }

  /* --- First-line top-space collapse ------------------------------
   * Mirrors the Crepe `.ProseMirror > :first-child { margin-top: 0 }`
   * rule in DocumentCanvas.svelte. A note typically opens with a
   * heading, and the heading-line decos below carry `padding-top:
   * 1.5em` for mid-doc breathing. When the heading IS the first line,
   * the byline already provides the top whitespace — collapse the
   * heading's intrinsic top-padding so the title sits flush under
   * "Saved · Metadata · History" instead of opening a second gap. */
  .plaintext-editor :global(.cm-content > .cm-line:first-child) {
    padding-top: 0;
  }

  /* --- Heading line decorations -----------------------------------
   * Restrained sizes — the body face is already a serif at 17px, so
   * headings only need a small lift to read as section breaks rather
   * than a typographic crescendo. Top padding opens whitespace above
   * the heading so the eye groups content into sections. Weight tops
   * out at 650 — heavy enough to anchor, not heavy enough to shout.
   *
   * Padding, not margin: CM6's heightmap measures `.cm-line` via
   * `getBoundingClientRect().height`, which is the border-box and
   * does NOT include margin. Using `margin-top` here would make
   * CM6 under-count heading line heights and place the cursor
   * ~50px below where the user clicks (cumulative across all
   * headings above the click). Padding lives inside the border
   * box, so CM6 reads the height correctly and click-to-position
   * stays aligned. */
  /* Headings — slight negative letter-spacing mirrors the Vercel docs
     typographic feel for Geist (their reference uses ~-0.06em at 40px,
     which is quite aggressive; we start moderate at -0.02em on H1 and
     fade out per level). Weight stays at 650 (between regular and bold)
     — the variable axis carries arbitrary values cleanly. If we
     revert `--rd-sans-prose` back to the serif stack the negative
     letter-spacing is still fine on Source Serif 4 at heading sizes. */
  .plaintext-editor :global(.cm-line.cm-md-h1) {
    position: relative;
    font-size: 1.6em;
    font-weight: 650;
    line-height: 1.25;
    letter-spacing: -0.02em;
    padding-top: 1.5em;
    padding-bottom: 0.4em;
    color: var(--rd-ink-1, #1a1d22);
  }
  .plaintext-editor :global(.cm-line.cm-md-h2) {
    position: relative;
    font-size: 1.35em;
    font-weight: 650;
    line-height: 1.3;
    letter-spacing: -0.015em;
    padding-top: 1.5em;
    padding-bottom: 0.4em;
    color: var(--rd-ink-1, #1a1d22);
  }
  .plaintext-editor :global(.cm-line.cm-md-h3) {
    position: relative;
    font-size: 1.15em;
    font-weight: 650;
    line-height: 1.35;
    letter-spacing: -0.01em;
    padding-top: 1.5em;
    padding-bottom: 0.4em;
    color: var(--rd-ink-1, #1a1d22);
  }

  /* --- H-level gutter chip (Slice S, refined) --------------------- *
   * Tiny `H1` / `H2` / `H3` label sitting in the left gutter, always
   * visible (does NOT hide when the user clicks into the heading line —
   * the source `#` reveals as well; chip stays as the structural
   * marker). Right edges of all chips align at a fixed x just outside
   * column-left, so H1/H2/H3 chips stack as a clean vertical column.
   *
   * Vertical centering on the heading text (not the line box). The
   * line box includes padding-top (1.5em on mid-doc headings, 0 on
   * the first-child H1 after Slice P's first-child collapse), so the
   * text center varies. Formula: `top: calc(<padding-top> + <half
   * line-height>); transform: translateY(-50%)`. First-child override
   * sets padding-top to 0 in the calc.
   *
   * Why absolute / right-aligned-in-fixed-box: chip must NOT consume
   * column width (Slice P alignment invariant). Each chip is a 32px-
   * wide right-aligned box at `left: -40px` (so the box's right edge
   * sits 8px left of column-edge). Text inside is right-aligned, so
   * H1/H2/H3 glyphs all end at the same x position regardless of font
   * size.
   *
   * Size: H1 11px, H2 10px, H3 9px — slight tapering matches the
   * heading hierarchy without crescendoing. */
  .plaintext-editor :global(.cm-line.cm-md-h1)::before,
  .plaintext-editor :global(.cm-line.cm-md-h2)::before,
  .plaintext-editor :global(.cm-line.cm-md-h3)::before {
    position: absolute;
    left: -40px;
    width: 32px;
    text-align: right;
    transform: translateY(-50%);
    font-family: var(
      --rd-mono,
      ui-monospace,
      SFMono-Regular,
      'SF Mono',
      Menlo,
      Consolas,
      monospace
    );
    font-weight: 500;
    letter-spacing: 0.05em;
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    pointer-events: none;
    user-select: none;
  }
  /* Per-level: size + vertical-center in ABSOLUTE px.
     `em` inside `::before` resolves to ::before's own font-size (the chip's
     11/10/9px), NOT the heading's — so the top:calc(...) values can't be
     written in em terms here. Computed from heading dimensions:
       Body font = 17px (set in documentTheme).
       H1: font 1.6em = 27.2px, line-height 1.25 = 34px, padding-top 1.5em = 40.8px.
       H2: font 1.35em = 22.95px, line-height 1.3 = 29.84px, padding-top 1.5em = 34.43px.
       H3: font 1.15em = 19.55px, line-height 1.35 = 26.39px, padding-top 1.5em = 29.33px.
     Text center = padding-top + line-height/2. */
  .plaintext-editor :global(.cm-line.cm-md-h1)::before {
    content: 'H1';
    font-size: 11px;
    top: 57.8px; /* 40.8 + 17 */
  }
  .plaintext-editor :global(.cm-line.cm-md-h2)::before {
    content: 'H2';
    font-size: 10px;
    top: 49.35px; /* 34.43 + 14.92 */
  }
  .plaintext-editor :global(.cm-line.cm-md-h3)::before {
    content: 'H3';
    font-size: 9px;
    top: 42.52px; /* 29.33 + 13.20 */
  }
  /* First-child override: Slice P's collapse zeroes padding-top, so
     text center is just line-height/2. */
  .plaintext-editor :global(.cm-content > .cm-line:first-child.cm-md-h1)::before {
    top: 17px;
  }
  .plaintext-editor :global(.cm-content > .cm-line:first-child.cm-md-h2)::before {
    top: 14.92px;
  }
  .plaintext-editor :global(.cm-content > .cm-line:first-child.cm-md-h3)::before {
    top: 13.2px;
  }
  .plaintext-editor :global(.cm-line.cm-md-h4),
  .plaintext-editor :global(.cm-line.cm-md-h5),
  .plaintext-editor :global(.cm-line.cm-md-h6) {
    font-size: 1em;
    font-weight: 650;
    padding-top: 1.2em;
    padding-bottom: 0.3em;
    color: var(--rd-ink-1, #1a1d22);
  }
  /* Adjacent-heading collapse: nested heading reads as subdivision, not section break. */
  .plaintext-editor
    :global(
      :is(.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6)
        + :is(.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6)
    ) {
    padding-top: 0.5em;
  }
  /* Chip re-center when adjacent-heading collapse fires. New padding-top
     in px: H1 0.5em=13.6, H2 11.48, H3 9.78. top = padding-top + line-height/2. */
  .plaintext-editor
    :global(
      :is(.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6)
        + .cm-md-h1::before
    ) {
    top: 30.6px;
  }
  .plaintext-editor
    :global(
      :is(.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6)
        + .cm-md-h2::before
    ) {
    top: 26.4px;
  }
  .plaintext-editor
    :global(
      :is(.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6)
        + .cm-md-h3::before
    ) {
    top: 22.97px;
  }
  /* Kill the default-highlight-style underline on lezer-markdown's
     heading tag emissions. `syntaxHighlighting(defaultHighlightStyle)`
     is mounted by plaintextDecorations() for fenced-code-block
     coloring; it also paints `tag.heading` as underlined which lands
     on every inline span inside a heading line (the `ͼN ͼM` classes).
     Bear has no heading underline; strip it on the line scope so the
     fenced-code highlight survives elsewhere. */
  .plaintext-editor :global(.cm-line.cm-md-h1 *),
  .plaintext-editor :global(.cm-line.cm-md-h2 *),
  .plaintext-editor :global(.cm-line.cm-md-h3 *),
  .plaintext-editor :global(.cm-line.cm-md-h4 *),
  .plaintext-editor :global(.cm-line.cm-md-h5 *),
  .plaintext-editor :global(.cm-line.cm-md-h6 *) {
    text-decoration: none;
  }

  /* --- Inline emphasis / code -------------------------------------
   * Bold capped at 650 so it doesn't punch above the heading weight.
   * Inline code drops a touch below body x-height (0.88em) and gets a
   * theme-tinted background — distinct from a fenced code block but
   * sitting in the same monospace family. */
  .plaintext-editor :global(.cm-md-bold) {
    font-weight: 650;
  }
  .plaintext-editor :global(.cm-md-italic) {
    font-style: italic;
  }
  .plaintext-editor :global(.cm-md-strike) {
    text-decoration: line-through;
  }
  .plaintext-editor :global(.cm-md-code) {
    font-family: var(
      --rd-mono,
      ui-monospace,
      SFMono-Regular,
      'SF Mono',
      Menlo,
      Consolas,
      monospace
    );
    font-size: 0.88em;
    background-color: var(--rd-hover, rgba(0, 0, 0, 0.05));
    padding: 0.05em 0.35em;
    border-radius: 0.25em;
  }
  /* Link label tint (Slice Q polish). `[label](url)` — the label
     between `[` and `]` carries `.cm-md-link-label`; bracket/paren/URL
     are hidden by the cursor-reveal pattern when the cursor is
     outside the link, so off-cursor the user sees just the tinted
     label as a clean link. No click handler here — that's a later
     slice. Subtle blue tint; the body color is the default. The `*`
     descendant rule kills the default-highlight-style underline on
     `tag.link` (lezer-markdown's emission), keeping the look Bear-soft
     rather than classic-blue-web. */
  .plaintext-editor :global(.cm-md-link-label),
  .plaintext-editor :global(.cm-md-link-label *) {
    color: var(--rd-sky, #4a90e2);
    text-decoration: none;
  }

  /* --- Link + wikilink click affordance (Slice 6) ---------------- *
   * Pointer cursor on tinted labels so the click is signaled at
   * hover. We always show the pointer (not gated on focus / mod
   * keys) — matches the markdown editor's behavior where the
   * tinted span is unambiguously interactive. Click-and-drag for
   * text selection still works because CM6's selection handling
   * runs on mousedown; pointer is purely a hover-time hint.
   *
   * The bracket / paren syntax chars carry `.cm-md-syntax` and are
   * NOT in this rule, so when they're revealed (cursor inside the
   * link) clicking them still positions the caret normally — the
   * click handler only fires on the LABEL element. */
  .plaintext-editor :global(.cm-md-link-label),
  .plaintext-editor :global(.cm-md-wikilink-label) {
    cursor: pointer;
  }

  /* --- Wikilink + footnote hover preview (Slice 6 + footnote slice) *
   * `hoverTooltip` from @codemirror/view emits a positioned
   * `.cm-tooltip` shell; we paint the inner `.cm-md-wikilink-preview`
   * div with Bear-soft surface tones — translucent panel, hairline
   * border, faint shadow, small body type. The data-state attribute
   * distinguishes resolved (path text in default ink-2) from broken
   * (muted ink-4 + italic "Note not found:") so the reader can
   * disambiguate at a glance without color shouting.
   *
   * The footnote hover (`.cm-md-footnote-preview`) shares this exact
   * visual register — it's the same kind of "small floating reference
   * panel" affordance, just with definition-body text inside instead
   * of a resolved-path string.
   *
   * Sizing: max-width caps the tooltip at a reading width so very
   * deep paths wrap rather than running off-screen. `word-break:
   * break-word` keeps long basenames from overflowing the cap.
   *
   * `pointer-events: none` is critical — the tooltip is purely
   * informational, and without it the panel intercepts the click the
   * user aimed at the link beneath, sending `event.target` to the
   * tooltip and breaking the affordance handler's label-class match.
   * (Symptom: cursor lands on the link's line, Shape A reveals raw
   * markdown, click never follows.) */
  :global(
      .cm-tooltip:has(.cm-md-wikilink-preview),
      .cm-tooltip:has(.cm-md-footnote-preview)
    ) {
    background: var(--rd-panel, #fdfdfd);
    color: var(--rd-ink-2, rgba(0, 0, 0, 0.75));
    border: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
    overflow: hidden;
    pointer-events: none;
  }
  :global(.cm-md-wikilink-preview),
  :global(.cm-md-footnote-preview) {
    padding: 6px 10px;
    font-family: var(
      --rd-sans,
      -apple-system,
      'Inter Tight',
      system-ui,
      sans-serif
    );
    font-size: 13px;
    line-height: 1.4;
    max-width: 360px;
    word-break: break-word;
  }
  :global(.cm-md-wikilink-preview[data-state='broken']) {
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    font-style: italic;
  }

  /* --- Wikilink tints (Slice 5) ---------------------------------- *
   * `[[note]]` and `[[note|alias]]` — the resolved-target label is
   * tinted in the same Bear-soft sky tone as the `[label](url)` link
   * (sibling kind of cross-reference; same prose-link affordance). The
   * `[[` / `]]` bracket characters and the `|` (when an alias is
   * present) follow the cursor-reveal pattern via the existing
   * `.cm-md-syntax.cm-hidden` rules — off-cursor the reader sees just
   * the tinted label, on-cursor the brackets reveal for editing.
   *
   * Resolved (`.cm-md-wikilink-label`): sky-tone color, no underline —
   * matches the inline-link label so wikilinks read as cross-references
   * in the same visual register, not as classic-blue-web hyperlinks.
   *
   * Broken (`.cm-md-wikilink-label.cm-md-wikilink-broken`): the
   * resolved class always lands first, so we additionally override
   * `color` with the muted ink tone and add a dotted-underline hint.
   * The dotted underline is a "soft warning" signal — the link is
   * still legible as a reference, but the reader sees at-a-glance
   * that the target doesn't currently resolve. No bright red /
   * strikethrough — that would conflict with Bear's calm-prose
   * aesthetic and over-rotate on what's often a transient state
   * (you're about to create the target note next).
   *
   * No click handler this slice (Slice 5 is parse + paint only). The
   * click affordance + hover preview land in Slice 6. */
  .plaintext-editor :global(.cm-md-wikilink-label),
  .plaintext-editor :global(.cm-md-wikilink-label *) {
    color: var(--rd-sky, #4a90e2);
    text-decoration: none;
  }
  .plaintext-editor :global(.cm-md-wikilink-label.cm-md-wikilink-broken),
  .plaintext-editor :global(.cm-md-wikilink-label.cm-md-wikilink-broken *) {
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    text-decoration-thickness: 1px;
  }

  /* --- Footnote reference (Slice 4 of plaintext Apple lane) ------- *
   * Inline `[^id]` reference. Off-line the `[^` / `]` brackets hide
   * via the standard cm-md-syntax.cm-hidden rule, leaving just the id
   * text — which we style as a small superscript clickable span in
   * the same Bear-soft sky tone the wikilink labels use (sibling
   * cross-reference; same prose-link visual register). On-line the
   * brackets reveal as raw markdown for editing.
   *
   * Broken (`.cm-md-footnote-ref-broken`): no matching FootnoteDef in
   * the doc. Muted ink + dotted underline — same soft-warning pattern
   * as broken wikilinks. */
  .plaintext-editor :global(.cm-md-footnote-ref) {
    vertical-align: super;
    font-size: 0.75em;
    line-height: 1;
    color: var(--rd-sky, #4a90e2);
    cursor: pointer;
    text-decoration: none;
  }
  .plaintext-editor :global(.cm-md-footnote-ref.cm-md-footnote-ref-broken) {
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    text-decoration-thickness: 1px;
  }

  /* --- Footnote definition label (Bear Notes inline render) -------- *
   * Block definition `[^id]: body text` renders in Bear style: the
   * line flows as ordinary prose, with the id painted inline in link
   * color and the `:` flowing as plain punctuation. No gutter chip,
   * no card chrome — `[^` and `]` are hidden via the standard
   * `cm-md-syntax.cm-hidden` rule (emitted from plaintext-decorations
   * .ts), so off-cursor the user sees `name: body…`, with `name`
   * tinted like a wikilink/link label.
   *
   * Cursor-on-line drops the label paint and reveals the raw `[^id]:`
   * source — same reveal pattern as wikilinks and other inline marks. */
  .plaintext-editor :global(.cm-md-footnote-label) {
    color: var(--rd-sky, #4a90e2);
    text-decoration: none;
  }

  /* --- Lists -------------------------------------------------------- *
   * `.cm-md-listitem` lands on the FIRST source line of every
   * ListItem (bullet or ordered). `.cm-md-listitem-depth-N` carries
   * the nesting depth (0..5, clamped in the builder). Padding-left
   * scales with depth so nested items visibly step rightward. Marker
   * (`-` / `*` / `1.`) is always visible (Bear-style "bullet always
   * present").
   *
   * Rhythm (Bear-tightened):
   *   - depth-0 sits at 0.5em from the column-left — the bullet hugs
   *     the margin so list-prose doesn't read as deeply inset against
   *     surrounding paragraphs (matches Bear Notes' reference render).
   *   - Each subsequent depth steps +1.25em — enough nesting signal
   *     without ballooning the indent at deep levels.
   *   - Marker has `margin-right: 0.5em` so there's a clear, body-em
   *     gap between marker glyph and item text (Bear's bullet→text
   *     gap reads at ~half a body em).
   *   - Marker source-syntax font-size is bumped (was 0.7em → see the
   *     `:first-child` rule below) so raw `- ` / `1.` is readable when
   *     the cursor enters the line and source reveals.
   *   - Color: bullets/numbers tint `--rd-sky` to share the link blue;
   *     source-syntax stays in muted ink. */
  .plaintext-editor :global(.cm-line.cm-md-listitem) {
    padding-left: 0.5em;
  }
  .plaintext-editor :global(.cm-line.cm-md-listitem-depth-0) {
    padding-left: 0.2em;
  }
  .plaintext-editor :global(.cm-line.cm-md-listitem-depth-1) {
    padding-left: 1.75em;
  }
  .plaintext-editor :global(.cm-line.cm-md-listitem-depth-2) {
    padding-left: 3em;
  }
  .plaintext-editor :global(.cm-line.cm-md-listitem-depth-3) {
    padding-left: 4.25em;
  }
  .plaintext-editor :global(.cm-line.cm-md-listitem-depth-4) {
    padding-left: 5.5em;
  }
  .plaintext-editor :global(.cm-line.cm-md-listitem-depth-5) {
    padding-left: 6.75em;
  }
  /* Only the FIRST .cm-md-syntax span (the ListMark) gets the
     quiet-marker + gap styling — other `.cm-md-syntax` spans in the
     same line (wikilink brackets, emphasis marks, etc.) are sibling
     direct children and would otherwise inherit the margin-right,
     leaving visible whitespace next to hidden brackets.

     Font-size kept at the body em (no shrink) so that when the cursor
     enters a list line and the raw `- ` / `1.` source reveals, the
     marker is legible. The off-cursor bullet/number is a WIDGET
     (cm-md-bullet-glyph / cm-md-ordered-number) with its own size
     register, so widget quietness is unaffected.

     Column-width-match (Slice apple-list-alignment): the raw `- ` /
     `1.` source occupies the SAME fixed-width column the off-cursor
     BulletGlyphWidget / OrderedNumberWidget uses (font-size 0.8em,
     width 1.6em, margin-right 0.5em, inline-block, text-align right).
     Without this, body text shifted left ~1.1em when the cursor
     entered a list line — the on-cursor reveal pushed the bullet
     against the body. Now the column is stable; only the marker
     swaps from glyph to source.

     Task lines excluded via :not(.cm-md-listitem-task): task-bearing
     items have their own visual column (the checkbox widget off-
     cursor, raw `- [ ]` source on-cursor). Giving them the bullet
     column would either push the off-cursor checkbox right by 1.6em
     OR create a phantom column before the hidden ListMark. */
  .plaintext-editor
    :global(.cm-line.cm-md-listitem:not(.cm-md-listitem-task) > .cm-md-syntax:first-child),
  .plaintext-editor
    :global(.cm-line.cm-md-listitem:not(.cm-md-listitem-task) > .cm-md-syntax:first-child > *) {
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    font-size: 0.8em;
    display: inline-block;
    width: 1.6em;
    margin-right: 0.5em;
    text-align: right;
    vertical-align: baseline;
  }

  /* --- Task-list checkbox (Slice 3 → Slice L redesign) ------------- *
   * Inline widget replacing the 3-char TaskMarker (`[ ]` / `[x]`) in a
   * GFM task-list item. Slice L drops the bullet entirely on task-list
   * lines (suppressed in the ListMark branch of plaintext-decorations.ts)
   * so the row reads: checkbox · text. The leading affordance IS the
   * checkbox; a redundant `-` next to it was loud + ugly.
   *
   * Visual register: NOT the browser-native `<input type="checkbox">`
   * (the blue accent fought the editor's quiet palette). Instead a
   * custom inline SVG widget in `currentColor`:
   *   - Unchecked → an outlined rounded-corner square, faded to ~0.5
   *     opacity. The border IS the glyph.
   *   - Checked   → the Phosphor `Check` icon path, currentColor, no
   *     tint. Reads as a typographic check mark, not a UI control.
   *
   * Both states track the body em — the box is 0.95em on a side so it
   * scales with reading size. `vertical-align: -0.1em` nudges the box
   * down a hair so the centre of the box aligns with text x-height
   * (raw baseline-align reads as floating above the line).
   *
   * Dark-mode parity: every color reference uses `currentColor` or an
   * `--rd-*` variable, so the same rules read clean against `--rd-bg`
   * in both themes — no hardcoded hex for the glyph itself.
   *
   * Click behaviour unchanged from Slice 3 — mousedown on the wrap
   * dispatches the source-text flip; see TaskCheckboxWidget.toDOM. */
  .plaintext-editor :global(.cm-md-task-checkbox) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Baseline-align so the box sits on the text baseline; the
       -0.1em nudge counteracts the SVG's centre-relative-to-baseline
       offset so the glyph optically aligns with x-height. */
    vertical-align: -0.1em;
    cursor: pointer;
    /* Track the body em — 0.95em-square so the glyph reads at the
       same visual weight as a list bullet / em-dash. */
    width: 0.95em;
    height: 0.95em;
    /* Tiny gap before the body text so the row breathes. */
    margin-right: 0.4em;
    /* Quiet by default — both checked + unchecked states sit at low
       opacity. Same ~0.5 register as cm-md-ink-4 muted ink. The
       checked state's text gets a separate dim via the
       .cm-md-listitem-task-checked rule below; the box itself stays
       quiet so the line reads as a single, dimmed unit. */
    color: currentColor;
    opacity: 0.55;
  }
  .plaintext-editor :global(.cm-md-task-checkbox-unchecked) {
    /* Rounded-corner outline square — the box IS the glyph. Use
       `currentColor` so light/dark mode flips with the body ink.
       The 1.25px border weight tracks the editor's hairline tokens
       (cm-md-rule width). */
    border: 1.25px solid currentColor;
    border-radius: 3px;
  }
  .plaintext-editor :global(.cm-md-task-checkbox-checked) {
    /* No border on the checked state — the check glyph is the
       affordance. Box dimensions persist so the row's horizontal
       rhythm doesn't shift on toggle (preventing layout jitter when
       the user clicks).
       Bump the opacity slightly higher than unchecked so the check
       glyph reads cleanly; the text strike-through carries the
       "completed" register, so the check itself can be a touch
       firmer without competing. */
    opacity: 0.75;
  }
  .plaintext-editor :global(.cm-md-task-checkbox-glyph) {
    /* The SVG fills the wrap's content box; `display: block` removes
       inline-baseline whitespace below the SVG. */
    width: 100%;
    height: 100%;
    display: block;
  }

  /* Slice L: strike-through + dim the BODY text of a checked task
     line. Scoped tightly — the checkbox widget is excluded via
     direct-descendant `:not()` so the box itself stays unstyled
     (a struck-through checkbox would compound visual noise).
     The line's `.cm-md-listitem` line deco gives us the cm-line
     class; this rule layers on top.
     Both `text-decoration` AND opacity for a soft, Bear-clean
     completed register — strikethrough alone reads as a hard edit,
     dim alone reads as a draft. Combined they say "done & quiet". */
  .plaintext-editor :global(.cm-line.cm-md-listitem-task-checked) {
    opacity: 0.5;
  }
  /* Strikethrough is applied as a Decoration.mark over just the body
     range (after the TaskMarker), not on the line as a whole. CSS
     parent text-decoration draws across every in-flow descendant
     including zero-width .cm-hidden chars, so a line-scope line-
     through would read as a short leading dash before the checkbox.
     Scoping to the body mark avoids that bleed entirely. */
  .plaintext-editor :global(.cm-md-listitem-task-checked-body) {
    text-decoration: line-through;
    text-decoration-color: currentColor;
  }

  /* --- Bullet glyphs + ordered numbers (Slice L) ----------------- *
   * Inline widgets replacing the `ListMark` source range when the
   * cursor is OFF the enclosing ListItem. Cursor INSIDE reveals raw
   * source (handled in plaintext-decorations.ts via the visible
   * cm-md-syntax mark — styled small + muted by the first-child rule
   * above, same as before).
   *
   * Visual register: same family as the existing quiet-marker rule
   * (small, muted). currentColor + opacity so dark/light mode flips
   * cleanly without hardcoded hex.
   *
   * The two widget classes share styling so the visual family
   * (bullet glyph + ordered number) reads as one register — both
   * are typographic ornaments, not UI chrome. */
  /* Both widget classes share a fixed-width marker column so the body
     text starts at the same x position regardless of glyph kind or
     number length. Single-digit `1.` and double-digit `10.` and a bullet
     `●` all occupy the same 1.6em right-aligned column.

     Color: `--rd-sky` so bullets / numbers share the link-blue family
     with `[link]` / `[[wikilink]]` / `[^footnote]` labels — every
     inline accent in the editor reads in one voice. Opacity stays a
     touch under 1.0 so the marker is present but doesn't shout. */
  .plaintext-editor :global(.cm-md-bullet-glyph),
  .plaintext-editor :global(.cm-md-ordered-number) {
    display: inline-block;
    color: var(--rd-sky, #4a90e2);
    opacity: 0.85;
    font-size: 0.8em;
    width: 1.6em;
    margin-right: 0.5em;
    text-align: right;
    vertical-align: baseline;
  }
  /* SVG bullet glyph: 0.75em square so it visually matches the cap-
     height of a number / lowercase letter at the same font-size; sits
     on the baseline (small translateY nudge to land it on the text
     baseline cleanly). currentColor on the SVG fill so dark/light flip
     just works (the parent `.cm-md-bullet-glyph` now sets color to
     `--rd-sky` so the SVG inherits the link-blue tint). */
  .plaintext-editor :global(.cm-md-bullet-glyph svg) {
    width: 0.6em;
    height: 0.6em;
    vertical-align: -0.05em;
    display: inline-block;
  }
  .plaintext-editor :global(.cm-md-ordered-number) {
    font-variant-numeric: tabular-nums;
  }

  /* --- Blockquote as callout (Slice p polish) --------------------- *
   * Callout shape: thick accent bar + subtle tinted background. Each
   * blockquote line gets the line deco, so the bar + tint paints
   * continuously down a multi-line quote. The first / last lines
   * round the corners so the run reads as a single unit.
   *
   * Accent: `--rd-sky` (cool blue, available in the redesign tokens).
   * Distinct from selection highlights so callouts read as content. */
  .plaintext-editor :global(.cm-line.cm-md-blockquote) {
    border-left: 4px solid var(--rd-sky, #7fb9e5);
    background-color: color-mix(
      in oklch,
      var(--rd-sky, #7fb9e5) 8%,
      transparent
    );
    padding-left: 1em;
    /* Slice Q polish: open the text from the top/bottom borders.
       Blockquotes are line decos (not widgets), so per-line padding
       is the only knob — first/last/middle can't differ structurally.
       0.45em each opens single-line quotes without bloating them and
       gives multi-line quotes airy interior rhythm. */
    padding-top: 0.45em;
    padding-bottom: 0.45em;
    /* External top margin pushes the blockquote away from the
       preceding heading/paragraph so the tinted card doesn't crowd
       it. ONLY the first line of a blockquote should carry this —
       the adjacent-sibling rule below zeros it for consecutive
       blockquote lines so a multi-line quote reads as one block,
       not a stack of separately-spaced lines. No `margin-bottom`;
       the next content's own `margin-top` handles separation. */
    margin-top: 0.6em;
    color: var(--rd-ink-2, rgba(0, 0, 0, 0.75));
    font-style: italic;
  }
  .plaintext-editor
    :global(.cm-line.cm-md-blockquote + .cm-line.cm-md-blockquote) {
    margin-top: 0;
  }

  /* --- Fenced code block (Slice 2, Slice T polish + decompose) --- *
   * Two-layer decoration so the monospace font survives the cursor-
   * enter "reveal" transition without the body reflowing into the
   * editor's serif face:
   *
   *   - `.cm-md-code-block-text`  → TYPOGRAPHY layer. Monospace family
   *     + tightened font-size + line-height. ALWAYS applied to fence
   *     content lines, regardless of cursor position. This is the
   *     "this is code, not prose" signal — it must NOT toggle as the
   *     user clicks in / out of the fence.
   *
   *   - `.cm-md-code-block-card`  → CARD-CHROME layer. Background tint
   *     + side padding. ONLY applied off-fence. Paired with the
   *     positional `.cm-md-code-fence-{top,middle,bottom,only}`
   *     classes that add the border + radius so the run reads as a
   *     single rounded slab. Off-fence the user sees a card; on-fence
   *     the card vanishes (the user is editing raw markdown), but the
   *     code text stays monospace at the same size and line-height,
   *     so only the chrome moves — the text doesn't shift horizontally
   *     or reflow.
   *
   * Inner syntax highlighting lights up automatically via
   * syntaxHighlighting(defaultHighlightStyle) wired in
   * plaintextDecorations() — CM6 emits `.tok-keyword`, `.tok-string`,
   * etc. on inline spans inside the fence body. Those tok-* spans are
   * scoped under the code-block-text rule's monospace family via
   * font-family inheritance.
   *
   * Font-size tightened from 0.88em to 0.82em (matches a request from
   * the design pass — monospace reads larger than proportional at
   * equal pixel height, so the inline-code rule's 0.88em is too big
   * for a multi-line fence block). Line-height tightened from the
   * inherited 1.65 (set on .cm-scroller) down to 1.4 for the same
   * reason — code wants tighter vertical rhythm. */
  .plaintext-editor :global(.cm-line.cm-md-code-block-text) {
    font-family:
      ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
      'Liberation Mono', monospace;
    font-size: 0.82em;
    line-height: 1.4;
  }
  .plaintext-editor :global(.cm-line.cm-md-code-block-card) {
    background-color: var(--rd-code-bg, rgba(0, 0, 0, 0.045));
    padding: 0 1em;
  }
  /* --- Fence delimiter line collapse (off-fence) ------------------ *
   * `.cm-md-code-fence-delim` only lands on opening / closing fence
   * lines when the cursor is OFF the fence. Collapsing to zero height
   * via font-size + line-height + padding makes the visual code box
   * snap up against the surrounding prose. On-fence, the decoration
   * builder emits NO line decoration on delimiter lines so they
   * render at full size as plain prose (raw ` ```ts ` / ` ``` ` for
   * editing); content lines keep `cm-md-code-block-text` so the body
   * stays monospace at the same size across the toggle. */
  .plaintext-editor :global(.cm-line.cm-md-code-fence-delim) {
    font-size: 0;
    line-height: 0;
    padding: 0;
    background-color: transparent;
    /* Smooth the collapse so cursor enter/exit doesn't snap. */
    transition:
      font-size 120ms ease,
      line-height 120ms ease,
      padding 120ms ease;
  }
  /* --- Fence content-line frame (border + radius) ----------------- *
   * Top / middle / bottom classes paint a single rounded box across
   * all content lines of the fence. Top line rounds top-{left,right};
   * bottom line rounds bottom-{left,right}; middle keeps straight
   * sides. Border-top on top, border-bottom on bottom, side borders
   * on every content line so the run reads as one slab.
   *
   * `*-only` covers the single-content-line case (rounds all four
   * corners + full border). All four classes share the side borders +
   * padding-block via the multi-selector below. */
  .plaintext-editor :global(.cm-line.cm-md-code-fence-top),
  .plaintext-editor :global(.cm-line.cm-md-code-fence-middle),
  .plaintext-editor :global(.cm-line.cm-md-code-fence-bottom),
  .plaintext-editor :global(.cm-line.cm-md-code-fence-only) {
    position: relative;
    border-left: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
    border-right: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
  }
  .plaintext-editor :global(.cm-line.cm-md-code-fence-top) {
    border-top: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    padding-top: 0.75em;
  }
  .plaintext-editor :global(.cm-line.cm-md-code-fence-bottom) {
    border-bottom: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
    border-bottom-left-radius: 6px;
    border-bottom-right-radius: 6px;
    padding-bottom: 0.75em;
  }
  .plaintext-editor :global(.cm-line.cm-md-code-fence-only) {
    border-top: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
    border-bottom: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
    border-radius: 6px;
    padding-top: 0.75em;
    padding-bottom: 0.75em;
  }
  /* --- Language label (top-right corner) -------------------------- *
   * `data-fence-lang` lands on the first content line (Top or Only)
   * carrying the trimmed info-string from the opening ` ``` `. CSS
   * paints it as a small muted label in the top-right corner of the
   * rendered box. `pointer-events: none` so it doesn't intercept
   * clicks that should land in the code text. */
  .plaintext-editor :global(.cm-line.cm-md-code-fence-top[data-fence-lang]),
  .plaintext-editor :global(.cm-line.cm-md-code-fence-only[data-fence-lang]) {
    /* `position: relative` is already set by the side-border rule
       above; restate for clarity — `::after` is positioned within. */
    position: relative;
  }
  .plaintext-editor
    :global(.cm-line.cm-md-code-fence-top[data-fence-lang]::after),
  .plaintext-editor
    :global(.cm-line.cm-md-code-fence-only[data-fence-lang]::after) {
    content: attr(data-fence-lang);
    position: absolute;
    top: 0.35em;
    right: 0.7em;
    font-family: var(
      --rd-mono,
      ui-monospace,
      SFMono-Regular,
      'SF Mono',
      Menlo,
      Consolas,
      monospace
    );
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    pointer-events: none;
    user-select: none;
  }

  /* --- Horizontal rule (Slice R) ---------------------------------- *
   * `---` / `***` / `___` on its own line → thin hairline rule, Bear-
   * style. The decoration builder emits a `.cm-md-hr` line deco plus
   * a `cm-md-syntax` mark on the source chars (hidden off-cursor via
   * the cm-md-syntax.cm-hidden rule below, revealed on-cursor).
   *
   * Off-cursor (`:not(.cm-activeLine)`): the source chars collapse to
   * zero width via `font-size: 0` so the line's content height is ~0.
   * A `::before` pseudo paints the actual hairline, sitting in roomy
   * vertical padding so the rule reads as a quiet break in the flow.
   *
   * On-cursor (.cm-activeLine): no border, no pseudo. The chars
   * reveal at full size and the user sees raw `---` for editing.
   * `highlightActiveLine()` is mounted in the editor's extension list,
   * which adds `.cm-activeLine` to the line currently containing the
   * caret.
   *
   * Thin (1px) + low-alpha rule via `--rd-rule` so it doesn't compete
   * with body text / headings. Padding (not margin) for CM6 heightmap
   * correctness — same border-box reasoning as the heading and table
   * fixes. */
  .plaintext-editor :global(.cm-line.cm-md-hr) {
    position: relative;
    padding-top: 0.8em;
    padding-bottom: 0.8em;
  }
  .plaintext-editor :global(.cm-line.cm-md-hr:not(.cm-activeLine))::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    border-top: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.1));
  }

  /* --- Syntax-character hide/reveal (Slice p polish) -------------- *
   * `cm-md-syntax` is emitted on EVERY syntax-char span; `cm-hidden`
   * is added on top when the cursor sits OUTSIDE the enclosing
   * decorated range. So:
   *   - cursor outside  →  span has both classes  →  collapsed + faded
   *   - cursor inside   →  span has only cm-md-syntax  →  full size
   *
   * Smooth transitions: we can't animate `display: none`, so the hidden
   * state uses `font-size: 0` + `opacity: 0` instead. That zeros the
   * span's rendered width (no residual character cell) while still
   * letting both sides animate. The 120ms ease is fast enough to feel
   * snappy on cursor-enter / cursor-exit, slow enough to read as a
   * fade rather than a flash.
   *
   * Important: `font-size: 0` collapses the span's inline width but
   * leaves it in the flow as a 0-width box; CM6's selection painter
   * still positions the caret at the underlying source position
   * correctly because the source offset hasn't changed — only the
   * visual width has.
   *
   * The build pass in plaintext-decorations.ts toggles which mark
   * (hiddenSyntaxMark vs visibleSyntaxMark) lands on each syntax
   * range per-update; the CSS just reads the resulting class set. */
  .plaintext-editor :global(.cm-md-syntax) {
    transition:
      font-size 120ms ease,
      opacity 120ms ease;
  }
  .plaintext-editor :global(.cm-md-syntax.cm-hidden) {
    font-size: 0;
    opacity: 0;
  }

  /* --- Tables (Slice p polish) ------------------------------------ *
   * Rounded corners + soft shadow + tinted header row. `border-collapse:
   * separate` is required so border-radius on the outer table actually
   * clips the corner cells; `overflow: hidden` on the wrapper would
   * normally do it but tables can't crop their own children via
   * overflow. Inner cell borders use a hairline rule so the grid still
   * reads without competing with the outer shadow.
   *
   * Per-cell `text-align` is applied inline by TableWidget.toDOM —
   * keep that wins-the-cascade pattern intact (no default text-align
   * here).
   *
   * Padding lives on the `.cm-md-table-wrap` div, not as `margin` on
   * the table itself: CM6's heightmap measures the widget's outer DOM
   * element via `getBoundingClientRect().height`, which is the
   * border-box and excludes margin. A bare `<table>` with `margin: 1em
   * 0` would make CM6 under-count the widget's visual height by ~32px
   * and clicks below the table would drift below the visual target
   * (same bug class as the heading margin→padding fix in commit
   * e8875767). The wrap div's padding stays inside the border-box so
   * CM6 reads the full visual height and click-to-position stays
   * aligned. */
  .plaintext-editor :global(.cm-md-table-wrap) {
    padding-top: 1em;
    padding-bottom: 1em;
  }
  .plaintext-editor :global(table.cm-md-table) {
    border-collapse: separate;
    border-spacing: 0;
    font-size: 0.95em;
    line-height: 1.5;
    max-width: 100%;
    overflow: hidden;
    display: table;
    border-radius: 6px;
    /* Outer frame so the table reads as a "table in a margin" rather
       than fading into the document. The same hairline weight as code
       fences (Slice T) — both block constructs sit in the same visual
       register. Interior cell rules are stripped at last-child to
       avoid double-strokes against this outer border (see the
       `:last-child` rules below). */
    border: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.08));
    box-shadow:
      0 1px 3px rgba(0, 0, 0, 0.06),
      0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .plaintext-editor :global(table.cm-md-table th),
  .plaintext-editor :global(table.cm-md-table td) {
    border-right: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.07));
    border-bottom: 1px solid var(--rd-rule, rgba(0, 0, 0, 0.07));
    padding: 0.5em 0.75em;
    vertical-align: top;
  }
  /* Strip the right border on the last column and the bottom border
     on the last row so the rounded outer frame doesn't fight an inner
     line one pixel inside it. */
  .plaintext-editor :global(table.cm-md-table th:last-child),
  .plaintext-editor :global(table.cm-md-table td:last-child) {
    border-right: none;
  }
  .plaintext-editor :global(table.cm-md-table tbody tr:last-child td) {
    border-bottom: none;
  }
  .plaintext-editor :global(table.cm-md-table thead th) {
    background-color: color-mix(
      in oklch,
      var(--rd-sky, #7fb9e5) 10%,
      transparent
    );
    font-weight: 600;
    color: var(--rd-ink-1, #1a1d22);
  }
  /* Subtle zebra — barely perceptible, just enough to track rows. */
  .plaintext-editor :global(table.cm-md-table tbody tr:nth-child(even) td) {
    background-color: var(--rd-rule-soft, rgba(0, 0, 0, 0.02));
  }

  /* --- Images (Slice 4) ------------------------------------------- *
   * Inline widget — `<span class="cm-md-image-widget"><img></span>`.
   * The span wrapper renders inline so an image inside a paragraph
   * sits with surrounding text; the img itself uses inline-block so
   * the natural baseline aligns reasonably with text. `max-width:
   * 100%` keeps wide images contained; `height: auto` preserves
   * aspect ratio. No captions, no custom sizing in v1. */
  .plaintext-editor :global(.cm-md-image-widget) {
    display: inline;
  }
  .plaintext-editor :global(img.cm-md-image) {
    max-width: 100%;
    height: auto;
    display: inline-block;
    vertical-align: middle;
    /* Subtle border so a transparent image is still visually
       discernible (and matches the table border weight). */
    border-radius: 3px;
  }
  /* Broken-image fallback — Phosphor ImageBroken glyph + optional alt
     text. Replaces the browser's default broken-image icon (OS-
     specific, jarring) with a muted in-language indicator. Tinted to
     match the inline-code muted-state color (ink-4) so it reads as a
     quiet "this didn't load" signal rather than an error. */
  .plaintext-editor :global(.cm-md-image-widget[data-state='broken']) {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    /* Align the flex box itself with the surrounding text baseline so the
       glyph + alt text flow with the paragraph instead of floating above
       the line (an inline-flex box defaults to `vertical-align: baseline`
       on its bottom edge, which sits too high). */
    vertical-align: middle;
  }
  .plaintext-editor :global(.cm-md-image-broken) {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    vertical-align: middle;
  }
  .plaintext-editor :global(.cm-md-image-broken svg) {
    flex: none;
  }
  .plaintext-editor :global(.cm-md-image-broken-alt) {
    font-size: 0.88em;
    font-style: italic;
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
  }

  /* Documents may contain pending-upload:// sentinel URLs from existing data or future upload support. */
  .plaintext-editor :global(.cm-md-image-widget[data-state='pending']) {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
  }
  .plaintext-editor :global(.cm-md-image-spinner) {
    display: inline-flex;
    align-items: center;
    color: var(--rd-ink-4, rgba(0, 0, 0, 0.4));
    animation: cm-md-image-spin 0.9s linear infinite;
    vertical-align: middle;
  }
  @keyframes cm-md-image-spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

</style>
