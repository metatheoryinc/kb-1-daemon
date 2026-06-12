/**
 * CM6 `WidgetType` that mounts a Svelte 5 <MentionChip> in place of a
 * `[Name](mention:email)` source range.
 *
 * Replaces the older CSS-only `.kb1-mention` Decoration.mark approach
 * (see git history of `plaintext-decorations.ts` / `app.css`). Three
 * rounds of CSS-only iteration couldn't pixel-match the canonical
 * `<Avatar>` because the chip lived as `attr()`-rendered pseudo-elements
 * mirroring Avatar by hand — every Avatar tweak risked drift. The widget
 * mounts the real component, so visual parity is structural.
 *
 * Path α vs β: this is Path β. UserAvatar would have been ideal, but it
 * pulls in Tanstack svelte-query's `getQueryClientContext` whose context
 * key is a module-private Symbol — Svelte 5's `mount({ context: Map })`
 * can't thread the existing QueryClient without re-instantiating the
 * provider tree, which would create a stale-data subtree. So we resolve
 * orgPeople → person at decoration-build time (already wired) and pass
 * snapshot props (id/image/letter/accent) into the widget, then mount
 * the low-level `<Avatar>` inside `<MentionChip>` directly. No
 * PersonHoverCard for now (deferred — same trade-off as the old CSS chip).
 *
 * Lifecycle:
 *   - `toDOM` creates the host `<span>` and calls Svelte 5 `mount(...)`
 *     into it. Returns the host span so CM6 hangs it where the source
 *     range used to be.
 *   - `destroy(dom)` calls `unmount(component)` so the Svelte instance
 *     tears its effects + DOM down cleanly. CM6 calls this when the
 *     decoration is removed (cursor enters the range → widget skipped
 *     in next rebuild) or when the editor unmounts.
 *   - `eq(other)` compares the snapshot prop tuple. Re-resolution
 *     (orgPeople loads after first paint and promotes a stale chip)
 *     flips `accent` / `image` / `letter` / `stale`, which `eq` returns
 *     `false` for → CM6 rebuilds the widget with fresh props.
 *   - `mousedown` is handled directly on the host span. CM6's default
 *     posAtCoords places the caret at the widget's right boundary
 *     (`linkTo`) for right-side clicks, which falls outside the
 *     `selTo < linkTo` reveal gate in plaintext-decorations and makes
 *     the right half of the chip look unclickable. Our handler
 *     dispatches a selection at `posAtDOM(host) + 1` (just inside `[`),
 *     so any click on the chip reveals the source for in-place editing.
 *     `ignoreEvent` returns `true` for `mousedown` so CM6 doesn't also
 *     run its own caret placement; other events pass through.
 */

import { WidgetType, type EditorView } from '@codemirror/view';
import type { AccentName } from '@kb-2/ui';
import { mount, unmount } from 'svelte';
// Note: `MentionChip.svelte` is imported lazily inside `toDOM()` rather
// than statically. The test harness for `plaintext-decorations.ts`
// (which transitively pulls this file in) runs without the Svelte vite
// plugin — a static import would force vitest to parse the `.svelte`
// source and crash with "invalid JS syntax." Browser builds don't pay
// the lazy-import cost (the chunk is cached after first paint), and
// CM6 never calls `toDOM()` in tests so the dynamic import never runs
// in vitest.

export interface MentionChipProps {
  /** Full email parsed out of the `mention:<email>` URL — kept for
   *  data attribute / aria. */
  email: string;
  /** Display name surfaced as the chip's text label. Falls back to the
   *  email handle when the directory has only an email, or to "Unknown"
   *  for fully-stale chips — same fallback chain as UserAvatar. */
  displayName: string;
  /** Uppercased single character rendered inside the Avatar fallback. */
  letter: string;
  /** Resolved profile image URL when the directory entry has one; `null`
   *  otherwise (avatar renders the letter). */
  image: string | null;
  /** Per-user accent — `accentForId(resolved.id)` for resolved chips,
   *  `'slate'` for stale. Matches the user's accent across the rest of
   *  the app (HISTORY panel, byline, file rows). */
  accent: AccentName;
  /** Native browser tooltip surfaced on hover — defaults to `email` to
   *  match the old CSS chip's `data-mention-email` hover affordance.
   *  Required (not optional) so the `<MentionChip>` `title` prop contract
   *  is satisfied at the type level instead of through a runtime
   *  `undefined`. */
  title: string;
  /** True when the email didn't resolve against the current org
   *  directory. The chip styles itself muted + line-through. */
  stale: boolean;
}

type MountedInstance = ReturnType<typeof mount<MentionChipProps, Record<string, unknown>>>;

export class MentionChipWidget extends WidgetType {
  readonly props: MentionChipProps;
  // Tracked per-widget instance so `destroy` can `unmount` the same
  // component `toDOM` mounted. CM6 holds onto the WidgetType through
  // the decoration's lifetime; storing the instance here is safe.
  private component: MountedInstance | null = null;
  // Set to true between `destroy(dom)` and any race-condition late
  // arrival of the lazy-imported module. Without this guard a late
  // `mount(...)` callback could resurrect a Svelte instance inside a
  // DOM node CM6 has already discarded.
  private disposed = false;

  constructor(props: MentionChipProps) {
    super();
    this.props = props;
  }

  /**
   * Snapshot-equal: identical props tuple → reuse the existing DOM.
   * `email` alone isn't enough — when `orgPeople` lands after first
   * paint, a previously-stale chip promotes (image/letter/accent flip)
   * and we need CM6 to rebuild. Comparing every prop field catches all
   * resolution transitions.
   */
  eq(other: WidgetType): boolean {
    if (!(other instanceof MentionChipWidget)) return false;
    const a = this.props;
    const b = other.props;
    return (
      a.email === b.email &&
      a.displayName === b.displayName &&
      a.letter === b.letter &&
      a.image === b.image &&
      a.accent === b.accent &&
      a.title === b.title &&
      a.stale === b.stale
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('span');
    host.className = 'kb1-mention-widget';
    host.dataset.mentionEmail = this.props.email;
    if (this.props.stale) host.dataset.mentionStale = 'true';
    // Click-to-edit: place the caret strictly INSIDE the link source
    // range so the per-Link cursor-reveal gate in plaintext-decorations
    // (`selTo >= linkFrom && selTo < linkTo`) always fires regardless of
    // where on the chip the user clicked. Without this, CM6's default
    // posAtCoords lands the caret at `linkTo` for right-side clicks —
    // equal to the exclusive upper bound of the reveal range — and the
    // chip stays rendered. Left-side clicks land at `linkFrom` and
    // happen to work, so the bug looks like "right half is unclickable."
    //
    // `posAtDOM(host)` returns the widget's anchor position (= linkFrom
    // for a Decoration.replace), robust against doc edits shifting our
    // position since toDOM ran. `+1` puts the caret just after `[`.
    //
    // Bound to `mousedown` not `click`: our dispatch swaps this widget
    // out for raw markdown between mousedown and mouseup, and the
    // browser then cancels the click event entirely.
    host.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(host);
      view.dispatch({
        selection: { anchor: pos + 1 },
      });
      if (!view.hasFocus) view.focus();
    });
    // Lazy-import the Svelte component so vitest (which loads this
    // module without the Svelte vite plugin) never has to parse it.
    // The dynamic import resolves in a microtask; chip renders on
    // the next frame. Equivalent to v0 "loading" state — empty host
    // for ~one tick — which is invisible at typical decoration rebuild
    // cadence.
    const propsSnapshot = this.props;
    void import('./MentionChip.svelte').then((mod) => {
      if (this.disposed) return;
      // Cast through `unknown` to drop the generic Component<Props>
      // shape — the dynamic import returns `typeof import(...)` which
      // doesn't statically know our Props type, and `mount` won't
      // accept the `default` export of the Svelte module without a
      // bridge cast. The runtime shape matches Props 1:1.
      const Component = mod.default as unknown as Parameters<
        typeof mount<MentionChipProps, Record<string, unknown>>
      >[0];
      this.component = mount(Component, {
        target: host,
        props: propsSnapshot,
      });
    });
    return host;
  }

  destroy(_dom: HTMLElement): void {
    this.disposed = true;
    if (this.component !== null) {
      void unmount(this.component);
      this.component = null;
    }
  }

  /**
   * Tell CM6 to ignore `mousedown` on the widget — we handle it
   * ourselves in `toDOM` (caret placed strictly inside the link source
   * so the cursor-reveal gate fires for clicks anywhere on the chip).
   * Other events fall through to CM6's default handling.
   */
  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}
