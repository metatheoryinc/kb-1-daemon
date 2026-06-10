<script lang="ts" module>
  import type { AccentName } from './accent';
  import type { IconName } from './types';

  export type BreadcrumbAvatar =
    | { kind: 'org'; accent: AccentName; letter: string }
    | { kind: 'folder'; accent: AccentName }
    /**
     * Folder crumb tinted by an explicit hex color + optional emoji
     * icon. Used by /vault surfaces that resolve customize-folder
     * metadata via `folderIconResolver`. The legacy `FolderIcon`
     * primitive renders the swatch so the redesign and legacy paths
     * agree on color treatment.
     */
    | { kind: 'folder-color'; color: string; icon: string | null }
    | { kind: 'human'; accent: AccentName; letter: string }
    | { kind: 'agent'; accent: AccentName; brand: IconName };

  export interface BreadcrumbItem {
    label: string;
    avatar?: BreadcrumbAvatar;
    current?: boolean;
    /** Optional ancestor URL. When set (and the crumb isn't `current`),
        the crumb renders as an `<a href>` so SvelteKit's client-side
        nav handles the click. Production callers (DocumentCanvas) build
        hrefs for vault + folder crumbs; Storybook stories can omit it
        and keep the static `<span>` rendering. */
    href?: string;
  }
</script>

<script lang="ts">
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import FolderIcon from './FolderIcon.svelte';

  interface Props {
    items: BreadcrumbItem[];
  }

  let { items }: Props = $props();
</script>

{#snippet avatar(av: BreadcrumbAvatar)}
  {#if av.kind === 'org'}
    <Avatar kind="org" accent={av.accent} letter={av.letter} size={16} />
  {:else if av.kind === 'folder'}
    <Avatar kind="folder" accent={av.accent} size={14} />
  {:else if av.kind === 'folder-color'}
    <FolderIcon color={av.color} icon={av.icon} size="sm" variant="filled" />
  {:else if av.kind === 'human'}
    <Avatar kind="human" accent={av.accent} letter={av.letter} size={16} />
  {:else if av.kind === 'agent'}
    <Avatar kind="agent" accent={av.accent} brand={av.brand} size={16} />
  {/if}
{/snippet}

<nav class="breadcrumb" aria-label="Breadcrumb">
  {#each items as item, i (i)}
    {#if i > 0}
      <span class="separator" aria-hidden="true">
        <Icon name="chevron" size={11} weight="bold" />
      </span>
    {/if}
    {#if item.href && !item.current}
      <a class="crumb link" href={item.href}>
        {#if item.avatar}{@render avatar(item.avatar)}{/if}
        <span class="label">{item.label}</span>
      </a>
    {:else}
      <span class="crumb" class:current={item.current}>
        {#if item.avatar}{@render avatar(item.avatar)}{/if}
        <span class="label">{item.label}</span>
      </span>
    {/if}
  {/each}
</nav>

<style>
  .breadcrumb {
    display: inline-flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 6px;
    min-width: 0;
    color: var(--rd-ink-3);
    font-family: var(--rd-ui);
    font-size: 12.5px;
    line-height: 1;
  }

  .crumb {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: 6px;
  }

  /* Link crumbs reuse the static `.crumb` typography — no underline,
     no color flip — so the breadcrumb still reads as a single rule.
     Hover surfaces the affordance. */
  .crumb.link {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .crumb.link:hover .label {
    color: var(--rd-ink-1);
  }

  .crumb.link:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: 2px;
    border-radius: 3px;
  }

  .separator {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--rd-ink-3);
    opacity: 0.85;
  }

  .label {
    white-space: nowrap;
  }

  .current .label {
    color: var(--rd-ink-1);
    font-weight: 500;
  }
</style>
