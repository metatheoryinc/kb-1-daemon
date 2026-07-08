import { onDestroy } from 'svelte';

/**
 * Viewport breakpoint at which the desktop shell takes over from the
 * mobile shell. Below this width the mobile shell (full-screen left-nav
 * flyout) renders; at or above it the desktop shell (rail + secondary
 * panel + workspace side-by-side) renders. 880 leaves enough room for
 * the rail + the secondary panel + a usable canvas, and matches the
 * `880px` content breakpoint the document column already uses.
 */
const DESKTOP_BREAKPOINT_PX = 880;

type ViewportMode = 'desktop' | 'mobile';

interface ViewportStore {
  readonly mode: ViewportMode;
}

/**
 * Reactive viewport mode for the editor shell. The layout root owns its
 * lifecycle — one matchMedia listener for the whole app, not one per
 * consumer. `mode` is the only piece of state; anything that wants
 * "is desktop?" reads `mode === 'desktop'`.
 *
 * SSR: `ssr = false` is set globally in `routes/+layout.ts`, so this
 * always runs in the browser. No `browser` guard needed.
 */
export function createViewportStore(): ViewportStore {
  const query = `(min-width: ${String(DESKTOP_BREAKPOINT_PX)}px)`;
  const mql = window.matchMedia(query);

  let mode = $state<ViewportMode>(mql.matches ? 'desktop' : 'mobile');

  const handler = (event: MediaQueryListEvent) => {
    mode = event.matches ? 'desktop' : 'mobile';
  };
  mql.addEventListener('change', handler);

  onDestroy(() => {
    mql.removeEventListener('change', handler);
  });

  return {
    get mode() {
      return mode;
    },
  };
}
