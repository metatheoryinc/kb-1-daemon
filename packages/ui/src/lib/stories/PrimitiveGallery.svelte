<script lang="ts">
  import {
    Avatar,
    Badge,
    BrandMark,
    Breadcrumb,
    Checkbox,
    FavoriteButton,
    FolderIcon,
    Icon,
    IconButton,
    LiveDot,
    LiveStatusChip,
    SearchInput,
  } from '../index';

  const breadcrumbItems = [
    { label: 'Vault', avatar: { kind: 'org' as const, accent: 'sky' as const, letter: 'K' } },
    { label: 'Research', avatar: { kind: 'folder' as const, accent: 'sage' as const } },
    { label: 'Local-first roadmap', current: true }
  ];

  let checked = $state(true);
  let query = $state('filesystem');
</script>

<div class="gallery">
  <section>
    <h2>Identity</h2>
    <div class="row">
      <BrandMark />
      <Avatar kind="human" accent="coral" letter="Y" size={28} />
      <Avatar kind="agent" accent="periwinkle" brand="codex" size={28} />
      <Avatar kind="folder" accent="sage" size={28} />
      <FolderIcon color="#bae6fd" icon="*" size="lg" label="Folder" />
    </div>
  </section>

  <section>
    <h2>Status</h2>
    <div class="row">
      <Badge>Neutral</Badge>
      <Badge tone="success">Online</Badge>
      <Badge tone="danger">Unavailable</Badge>
      <LiveStatusChip label="Live saved 2s ago" />
      <LiveDot title="Live" />
    </div>
  </section>

  <section>
    <h2>Controls</h2>
    <div class="row">
      <Checkbox {checked} ariaLabel="Select file" onclick={() => (checked = !checked)} />
      <FavoriteButton favorited />
      <IconButton title="Refresh">
        <Icon name="refresh" />
      </IconButton>
      <SearchInput bind:value={query} />
    </div>
  </section>

  <section>
    <h2>Breadcrumb</h2>
    <Breadcrumb items={breadcrumbItems} />
  </section>
</div>

<style>
  .gallery {
    display: grid;
    gap: 28px;
    padding: 36px;
    background: var(--rd-bg);
    min-height: 100vh;
  }

  section {
    display: grid;
    gap: 12px;
  }

  h2 {
    margin: 0;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 13px;
    font-weight: 600;
  }

  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
</style>
