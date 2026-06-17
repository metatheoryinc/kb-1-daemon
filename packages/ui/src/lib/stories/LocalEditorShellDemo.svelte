<script lang="ts">
  import { LocalEditorShell, type RailNavId } from '../index';
  import {
    localEditorDocumentPath,
    localEditorSearchFixture,
    localEditorTreeFixture
  } from '../local-editor/fixtures';

  let expandedPaths = $state(new Set(['projects', 'projects/active', 'research']));
  let activeNav = $state<RailNavId>('files');
  let colorModeChoice = $state<'light' | 'dark' | 'system'>('system');

  const cycle = (m: 'light' | 'dark' | 'system'): 'light' | 'dark' | 'system' =>
    m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light';
</script>

<LocalEditorShell
  vaultName="demo-vault"
  daemonLabel="Daemon · live"
  daemonStatus="open"
  documentPath={localEditorDocumentPath}
  colorMode="light"
  {colorModeChoice}
  {activeNav}
  tree={localEditorTreeFixture}
  {expandedPaths}
  searchValue=""
  searchResults={localEditorSearchFixture}
  searchTotal={localEditorSearchFixture.length}
  onSelectNav={(id) => {
    activeNav = id;
  }}
  onToggleColorMode={() => {
    colorModeChoice = cycle(colorModeChoice);
  }}
  onToggleFolder={(path) => {
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    expandedPaths = next;
  }}
>
  <div class="fake-editor">
    <p class="kicker">Markdown</p>
    <h2>The Local Editor App Shell</h2>
    <p>
      This fixture-backed surface previews the two-pane local editor without
      reaching for the daemon.
    </p>
    <p>
      Folder color, file navigation, search rows, and the breadcrumb header are
      all rendered from local fixtures.
    </p>
  </div>
</LocalEditorShell>

<style>
  .fake-editor {
    width: min(100%, 760px);
    min-height: 100%;
    margin: 0 auto;
    border-left: 1px solid var(--rd-rule);
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
    color: var(--rd-ink-2);
    padding: 42px 48px;
    font-family: var(--rd-ui);
  }

  .kicker {
    margin: 0 0 12px;
    color: var(--rd-ink-4);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 16px;
    color: var(--rd-ink-1);
    font-size: 28px;
    font-weight: 650;
    letter-spacing: 0;
  }

  p {
    max-width: 36rem;
    margin: 0 0 14px;
    font-size: 15px;
    line-height: 1.6;
  }
</style>
