<script lang="ts">
  import { Avatar, type AccentName } from '@kb-2/ui';

  /**
   * Editor-side mention chip. Mounted via a CM6 `WidgetType` (see
   * `plaintext-mention-widget.ts`) in place of the source range
   * `[Name](mention:email)` when the cursor is outside the link.
   *
   * Path β implementation (no `UserAvatar`, no `PersonHoverCard`,
   * no Svelte query contexts): the chip's parent (`PlaintextEditor`)
   * already resolves the mention against `orgPeople` at decoration-
   * build time and passes the resolved `id` / `image` / `letter` /
   * `accent` through the widget props. That avoids the QueryClient-
   * context bridging problem (Tanstack's context key is module-
   * private and can't be threaded through Svelte 5's `mount({context})`
   * map). Hover-card is deferred; clicks already pass through to the
   * editor so caret-placement-on-click still works.
   *
   * Visual contract:
   *   - rounded pill (5px radius), 1.4em height, accent border + tint
   *   - inline-flex with avatar slot + display-name label
   *   - mounts <Avatar kind="human"> at size 14 (≈ 0.875em on a 16px
   *     editor body, matching the old 1.1em pseudo-element slot)
   *   - stale variant: slate accent, line-through, muted color,
   *     reduced avatar opacity
   *   - `font: inherit` on the chip — the label picks up the surrounding
   *     prose typography (serif + regular weight in PlaintextEditor),
   *     so a chip in a paragraph reads as a colored pill around the
   *     same typographic voice as the line it sits on, not a UI label
   *     dropped into prose.
   *   - `vertical-align: middle` aligns the pill's center with the
   *     parent text's midline (baseline + x-height/2). Same rule the
   *     editor's broken-image / loading-spinner widgets use.
   */

  interface Props {
    accent: AccentName;
    letter: string;
    image: string | null;
    displayName: string;
    title: string;
    stale: boolean;
  }

  let { accent, letter, image, displayName, title, stale }: Props = $props();
</script>

<span
  class="chip"
  class:stale
  style="--rd-accent: var(--rd-{accent}); --rd-accent-bg: var(--rd-{accent}-bg);"
  {title}
>
  <span class="avatar-slot">
    <Avatar
      kind="human"
      {accent}
      size={14}
      {letter}
      {image}
      ariaLabel={displayName}
    />
  </span>
  <span class="label">{displayName}</span>
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25em;
    height: 1.4em;
    padding: 0 0.4em 0 0.3em;
    border-radius: 5px;
    /* `vertical-align: middle` aligns the chip's center with the parent
       text's midline (baseline + x-height/2). Earlier `-0.25em` shifted
       the inline-flex center down past the prose baseline, making the
       pill visibly droop below the surrounding text. `middle` is the
       canonical inline-pill alignment — same rule used by the
       broken-image / loading-spinner widgets further down in
       PlaintextEditor.svelte. */
    vertical-align: middle;
    text-decoration: none;
    color: var(--rd-accent);
    background: light-dark(
      color-mix(in srgb, var(--rd-accent) 11%, transparent),
      color-mix(in srgb, var(--rd-accent) 22%, transparent)
    );
    border: 1px solid
      light-dark(
        color-mix(in srgb, var(--rd-accent) 38%, transparent),
        color-mix(in srgb, var(--rd-accent) 60%, transparent)
      );
    line-height: 1;
    /* Typography inherits from the surrounding prose so the chip's text
       reads as the same typographic voice as the line it sits on. The
       editor body is `var(--rd-serif)` at the default weight (Source
       Serif 4 regular). Earlier the chip forced `var(--rd-ui)` + weight
       600 + UI-specific tracking, which looked like a bold UI label
       dropped into a serif paragraph. */
    font: inherit;
  }

  .avatar-slot {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .label {
    /* Label inherits prose typography from .chip (font: inherit), so no
       extra font rules here. Kept as its own element so we can future-
       proof for per-segment effects (e.g. muting just the label in
       stale). */
    white-space: nowrap;
  }

  .chip.stale {
    color: var(--rd-ink-3, #6b7785);
    background: color-mix(in srgb, var(--rd-accent) 8%, transparent);
    border-color: color-mix(in srgb, var(--rd-accent) 30%, transparent);
    text-decoration: line-through;
  }
  .chip.stale .avatar-slot {
    opacity: 0.6;
  }
</style>
