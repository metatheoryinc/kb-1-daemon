<script lang="ts">
  import { LocalEditorMobileShell, type BreadcrumbItem, type RailNavId } from '../index';
  import { folderKey } from '../local-editor/expansion';
  import {
    localEditorDocumentPath,
    localEditorTreeFixture
  } from '../local-editor/fixtures';

  const VAULT_ID = 'demo-vault';

  const breadcrumbItems: BreadcrumbItem[] = [
    { label: 'demo-vault' },
    ...localEditorDocumentPath
      .split('/')
      .filter(Boolean)
      .map((segment, index, parts) => ({
        label: segment,
        current: index === parts.length - 1
      }))
  ];

  let documentFavorited = $state(false);
  let navOpen = $state(true);

  let expandedFolderIds = $state(
    new Set([
      folderKey(VAULT_ID, 'projects'),
      folderKey(VAULT_ID, 'projects/active'),
      folderKey(VAULT_ID, 'research')
    ])
  );
  let activeNav = $state<RailNavId>('files');
  let colorModeChoice = $state<'light' | 'dark' | 'system'>('system');
  let hiddenVaultIds = $state<string[]>([]);

  const cycle = (m: 'light' | 'dark' | 'system'): 'light' | 'dark' | 'system' =>
    m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light';
</script>

<LocalEditorMobileShell
  bind:navOpen
  vaultName="demo-vault"
  documentPath={localEditorDocumentPath}
  {breadcrumbItems}
  statusLabel="Saved"
  {documentFavorited}
  onToggleDocumentFavorite={() => {
    documentFavorited = !documentFavorited;
  }}
  onRenameDocument={() => {}}
  onMoveDocument={() => {}}
  onDeleteDocument={() => {}}
  {colorModeChoice}
  {activeNav}
  vaultId={VAULT_ID}
  tree={localEditorTreeFixture}
  {expandedFolderIds}
  {hiddenVaultIds}
  onSelectNav={(id) => {
    activeNav = id;
  }}
  onToggleVaultHidden={(id) => {
    hiddenVaultIds = hiddenVaultIds.includes(id)
      ? hiddenVaultIds.filter((x) => x !== id)
      : [...hiddenVaultIds, id];
  }}
  onToggleColorMode={() => {
    colorModeChoice = cycle(colorModeChoice);
  }}
  onToggleFolder={(key) => {
    const next = new Set(expandedFolderIds);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    expandedFolderIds = next;
  }}
>
  <div class="fake-editor">
    <p class="kicker">Markdown</p>
    <h2>The Local Editor Mobile Shell</h2>
    <p>
      The mobile shell frames the same canvas in mobile chrome: a full-screen
      left-nav flyout holding the primary rail and the files / starred panel.
    </p>
    <p>
      Tapping the hamburger opens the flyout; picking a file or vault closes it
      and lands you on the new view. Folder taps keep the flyout open so you can
      keep drilling.
    </p>
  </div>
</LocalEditorMobileShell>

<style>
  .fake-editor {
    width: 100%;
    min-height: 100%;
    margin: 0 auto;
    background: var(--rd-panel);
    color: var(--rd-ink-2);
    padding: 32px 24px;
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
    font-size: 24px;
    font-weight: 650;
    letter-spacing: 0;
  }

  p {
    margin: 0 0 14px;
    font-size: 15px;
    line-height: 1.6;
  }
</style>
