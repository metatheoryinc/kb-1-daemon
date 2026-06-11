<script lang="ts">
  import { createDemoDocumentProvider } from '$lib/yjs/demo-document-provider';
  import type {
    DemoDocumentProvider,
    DemoDocumentProviderStatus,
  } from '$lib/yjs/demo-document-provider';
  import { PlaintextEditor, type LivePath, type OrgPerson } from '@kb-2/editor';
  import { LiveStatusChip } from '@kb-2/ui';
  import { onMount } from 'svelte';

  let provider = $state<DemoDocumentProvider | null>(null);
  let status = $state<DemoDocumentProviderStatus>('connecting');
  let error = $state<string | null>(null);

  const livePaths: LivePath[] = [
    { path: 'demo-vault/hello-world.md', noteId: 'demo-document' },
  ];

  const orgPeople: OrgPerson[] = [
    {
      id: 'demo-yoh',
      email: 'yoh@example.com',
      name: 'Yoh',
      image: null,
    },
  ];

  const statusLabel = $derived(
    status === 'open'
      ? 'Daemon · live'
      : status === 'connecting'
        ? 'Daemon · connecting'
        : status === 'error'
          ? 'Daemon · error'
          : 'Daemon · closed',
  );

  onMount(() => {
    const nextProvider = createDemoDocumentProvider({
      onStatus: (nextStatus) => {
        status = nextStatus;
      },
      onError: (caught) => {
        error = caught instanceof Error ? caught.message : String(caught);
      },
    });
    provider = nextProvider;

    return () => {
      nextProvider.destroy();
      provider = null;
    };
  });
</script>

<svelte:head>
  <title>KB-2 Editor</title>
</svelte:head>

<main class="editor-page">
  <header class="topbar">
    <div class="title-group">
      <span class="eyebrow">demo-vault</span>
      <h1>hello-world.md</h1>
    </div>
    <a class="status-link" href="/status" aria-label="Open daemon status">
      <LiveStatusChip label={statusLabel} />
    </a>
  </header>

  <section class="document-shell" aria-label="Demo Markdown document">
    {#if provider}
      <PlaintextEditor
        ydoc={provider.doc}
        ytext={provider.text}
        livePaths={livePaths}
        orgPeople={orgPeople}
        scroll="self"
      />
    {:else}
      <div class="loading">Opening document…</div>
    {/if}
  </section>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</main>

<style>
  .editor-page {
    min-height: 100vh;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--rd-bg);
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 22px 12px;
    border-bottom: 1px solid var(--rd-rule);
    background: color-mix(in srgb, var(--rd-panel) 82%, transparent);
  }

  .title-group {
    min-width: 0;
  }

  .eyebrow {
    display: block;
    color: var(--rd-ink-4);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
  }

  h1 {
    margin: 1px 0 0;
    color: var(--rd-ink-1);
    font-size: 16px;
    font-weight: 650;
    line-height: 1.2;
    letter-spacing: 0;
  }

  .status-link {
    flex: none;
    color: inherit;
    text-decoration: none;
  }

  .document-shell {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(24px, 1fr) minmax(0, 760px) minmax(24px, 1fr);
    padding: 22px 0 0;
    overflow: hidden;
  }

  .document-shell :global(.kb2-editor-shell),
  .loading {
    grid-column: 2;
    min-width: 0;
    border-left: 1px solid var(--rd-rule);
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
  }

  .document-shell :global(.plaintext-editor .cm-content) {
    /* Heading gutter chips render in a box reaching 40px left of the text
       (see PlaintextEditor's ::before rules), so the left padding must
       exceed that for the chips to sit inside the panel. */
    padding-top: 28px;
    padding-left: 56px;
    padding-right: 32px;
    padding-bottom: 64px;
  }

  .loading {
    padding: 24px;
    color: var(--rd-ink-4);
    font-size: 13px;
  }

  .error {
    position: fixed;
    left: 16px;
    bottom: 16px;
    margin: 0;
    max-width: min(520px, calc(100vw - 32px));
    border: 1px solid color-mix(in srgb, var(--destructive) 40%, transparent);
    border-radius: 6px;
    background: var(--rd-panel);
    color: var(--destructive);
    padding: 8px 10px;
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .topbar {
      padding: 12px 14px 10px;
    }

    .document-shell {
      grid-template-columns: 12px minmax(0, 1fr) 12px;
      padding-top: 12px;
    }
  }
</style>
