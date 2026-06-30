<script lang="ts" module>
  import { cn } from '../utils';

  const DEFAULT_ICON_COLOR = '#cbd5e1';

  export type FolderIconSize = 'sm' | 'md' | 'lg';
  export type FolderIconVariant = 'filled' | 'outline';

  export function folderIconVariants({
    size = 'md',
    variant = 'filled',
  }: {
    size?: FolderIconSize;
    variant?: FolderIconVariant;
  } = {}): string {
    return `folder-icon size-${size} variant-${variant}`;
  }

  export interface FolderIconProps {
    color?: string | null;
    size?: FolderIconSize;
    variant?: FolderIconVariant;
    label?: string;
    class?: string;
  }

  function normalizeHex(color: string): string {
    if (color.length === 4 && color.startsWith('#')) {
      const [, r, g, b] = color;
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    if (color.length === 7 && color.startsWith('#')) return color.toLowerCase();
    return color;
  }
</script>

<script lang="ts">
  let {
    color = null,
    size = 'md',
    variant = 'filled',
    label,
    class: className,
  }: FolderIconProps = $props();

  const resolvedColor = $derived(
    color ? normalizeHex(color) : DEFAULT_ICON_COLOR,
  );
</script>

<span
  role={label ? 'img' : 'presentation'}
  aria-label={label}
  aria-hidden={label ? undefined : true}
  class={cn(folderIconVariants({ size, variant }), className)}
  style:--folder-icon-bg={`light-dark(${resolvedColor}, color-mix(in srgb, ${resolvedColor} 40%, black))`}
  style:--folder-icon-bg-outline="color-mix(in srgb, {resolvedColor} 35%, transparent)"
  style:--folder-icon-border={`light-dark(color-mix(in srgb, ${resolvedColor} 75%, black), color-mix(in srgb, ${resolvedColor} 85%, black))`}
>
</span>

<style>
  .folder-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: 1px solid var(--folder-icon-border);
    border-radius: 6px;
    background: var(--folder-icon-bg);
    user-select: none;
    transition:
      background 120ms ease,
      border-color 120ms ease;
  }

  .variant-outline {
    background: var(--folder-icon-bg-outline);
  }

  .size-sm {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    font-size: 10px;
  }

  .size-md {
    width: 18px;
    height: 18px;
    font-size: 12px;
  }

  .size-lg {
    width: 24px;
    height: 24px;
    border-radius: 7px;
    font-size: 14px;
  }

</style>
