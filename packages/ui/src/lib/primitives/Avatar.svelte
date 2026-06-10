<script lang="ts">
  import Icon from './Icon.svelte';
  import type { AccentName } from './accent';
  import type { IconName } from './types';

  type AvatarKind = 'human' | 'agent' | 'org' | 'folder' | 'file';
  type AvatarTone = 'soft' | 'pastel';

  interface Props {
    kind: AvatarKind;
    accent?: AccentName;
    size?: number;
    letter?: string;
    /** Profile image URL. When provided and loadable, renders as an
        `<img>` filling the avatar; on load error falls back to the
        letter rendering so a stale or 404'd URL never shows a broken
        image. Only meaningful for `kind="human"`. Accepts `null` so
        callers passing nullable user fields (DB column is nullable) can
        thread them through without coercing. */
    image?: string | null;
    brand?: IconName;
    tone?: AvatarTone;
    title?: string;
    ariaLabel?: string;
    /**
     * When true, draws a 2px accent-colored ring around the avatar
     * via box-shadow. Lives on the avatar (not on a wrapper button)
     * so the ring follows the avatar's natural rounded-square radius
     * — earlier wrapper-level rings forced a 50% radius that didn't
     * match the avatar inside, producing a visible "circle jammed on
     * top of a rounded square" effect.
     */
    followed?: boolean;
  }

  let {
    kind,
    accent = 'slate',
    size = 22,
    letter,
    image,
    brand,
    tone,
    title,
    ariaLabel,
    followed = false,
  }: Props = $props();

  let imageFailed = $state(false);
  const showImage = $derived(
    kind === 'human' && !!image && !imageFailed,
  );

  // Reset the failure latch when the URL or kind changes, so a new
  // image gets a fresh load attempt instead of staying stuck on the
  // initials fallback from a previous URL.
  $effect(() => {
    image;
    kind;
    imageFailed = false;
  });

  const resolvedTone: AvatarTone = $derived(tone ?? (kind === 'org' || kind === 'folder' ? 'pastel' : 'soft'));
  const radius = $derived(Math.max(5, Math.round(size * 0.32)));
  const letterSize = $derived(Math.round(size * 0.48));
  const glyphSize = $derived(Math.round(size * 0.74));
  const displayLetter = $derived(letter?.slice(0, 1).toUpperCase());
  const label = $derived(ariaLabel ?? title);
  const folderLipWidth = $derived(Math.round(size * 0.32));
  const folderLipHeight = $derived(Math.max(2, Math.round(size * 0.12)));
  const folderLipRadius = $derived(Math.max(1, Math.round(size * 0.06)));
</script>

<span
  class="avatar"
  class:soft={resolvedTone === 'soft'}
  class:pastel={resolvedTone === 'pastel'}
  class:followed
  style="--rd-accent: var(--rd-{accent}); --rd-accent-bg: var(--rd-{accent}-bg); width: {size}px; height: {size}px; border-radius: {radius}px;"
  role={label ? 'img' : undefined}
  aria-label={label}
  {title}
>
  {#if showImage}
    <img
      class="image"
      src={image}
      alt={label ?? ''}
      referrerpolicy="no-referrer"
      onerror={() => {
        imageFailed = true;
      }}
    />
  {:else if kind === 'human' || kind === 'org'}
    {#if displayLetter}
      <span class="letter" style="font-size: {letterSize}px;">{displayLetter}</span>
    {/if}
  {:else if kind === 'agent'}
    {#if brand}
      <Icon name={brand} size={glyphSize} />
    {:else}
      <Icon name="robot" size={glyphSize} />
    {/if}
  {:else if kind === 'folder'}
    <span
      class="folder-lip"
      style="width: {folderLipWidth}px; height: {folderLipHeight}px; border-radius: {folderLipRadius}px;"
    ></span>
  {:else if kind === 'file'}
    <Icon name="file" size={glyphSize} />
  {/if}
</span>

<style>
  /* IMPORTANT: kb-1's plaintext mentions mount this component directly
     via a CM6 WidgetType (see plaintext-mention-widget.ts). The
     chip wrapper around the Avatar is `MentionChip.svelte`; the
     accent is threaded via `accentForId(resolved.id)` — same hash
     `<UserAvatar userId={...}>` uses — so the same person paints in
     the same accent across the editor chip, HISTORY panel, byline,
     and file rows. The Crepe-side mention chip in <MarkdownEditor>
     still ships as CSS only (`mention-decoration-plugin.ts`); the
     unification arc across both editors is the follow-on. */
  .avatar {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    overflow: hidden;
    /* Light: translucent border reads soft against the white-ish panel.
       Dark: bare translucent border dims into the dark surface, leaving
       the avatar a fuzzy circle. Switch to full-opacity accent in dark
       so the edge crisps up against both the dark page and the muted
       fill. */
    border: 1px solid
      light-dark(
        color-mix(in srgb, var(--rd-accent) 68%, transparent),
        var(--rd-accent)
      );
    color: var(--rd-accent);
    font-family: var(--rd-ui);
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1;
  }

  .soft {
    /* Light: 11% wash reads as a faint tint over the white panel.
       Dark: 11% over a dark panel is barely-there — bump to ~22% so
       the hue carries through and gives the border something to play
       against. */
    background: light-dark(
      color-mix(in srgb, var(--rd-accent) 11%, transparent),
      color-mix(in srgb, var(--rd-accent) 22%, transparent)
    );
  }

  .pastel {
    background: var(--rd-accent-bg);
  }

  .letter {
    color: var(--rd-accent);
  }

  .image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .folder-lip {
    position: absolute;
    top: 28%;
    left: 22%;
    background: var(--rd-accent);
    opacity: 0.55;
  }

  /* Followed-ring: 2px halo in the accent color around the avatar.
     Drawn via box-shadow on the avatar itself so the ring inherits
     the avatar's rounded-square radius without any geometry hacks
     on wrapper elements. The inner 1.5px white shadow gives a
     small breathing gap so the ring reads as a band, not a fattened
     border. `overflow: hidden` on the avatar would clip it; we
     inset-clip the box-shadow inward instead by stacking two
     shadows. */
  .followed {
    box-shadow:
      0 0 0 1.5px var(--rd-panel),
      0 0 0 3px color-mix(in srgb, var(--rd-accent) 70%, transparent);
  }
</style>
