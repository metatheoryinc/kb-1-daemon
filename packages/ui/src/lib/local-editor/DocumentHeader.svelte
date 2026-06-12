<script lang="ts">
  import Breadcrumb from '../primitives/Breadcrumb.svelte';
  import type { BreadcrumbItem } from '../primitives/Breadcrumb.svelte';

  interface Props {
    vaultName: string;
    path: string;
  }

  let { vaultName, path }: Props = $props();

  const title = $derived(path.split('/').filter(Boolean).at(-1) ?? path);
  const items = $derived<BreadcrumbItem[]>([
    { label: vaultName },
    ...path.split('/').filter(Boolean).map((segment, index, parts) => ({
      label: segment,
      current: index === parts.length - 1
    }))
  ]);
</script>

<header class="document-header">
  <Breadcrumb {items} />
  <h1>{title}</h1>
</header>

<style>
  .document-header {
    display: grid;
    gap: 7px;
    min-width: 0;
    border-bottom: 1px solid var(--rd-rule);
    background: color-mix(in srgb, var(--rd-panel) 92%, transparent);
    padding: 14px 24px 12px;
  }

  h1 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 18px;
    font-weight: 650;
    letter-spacing: 0;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
