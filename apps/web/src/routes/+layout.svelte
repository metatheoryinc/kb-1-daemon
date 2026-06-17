<script lang="ts">
  import { createAppState, setAppStateContext } from '$lib/app-state';
  import '../app.css';

  let { children } = $props();

  // SSR is disabled for this app (see +layout.ts: `ssr = false`), so the
  // root layout always runs in the browser; `window.localStorage` is
  // available unconditionally. Built once at the root and shared down
  // the tree via context so the toggle and this resolver act on one
  // store instance.
  const appState = createAppState({ storage: window.localStorage });
  setAppStateContext(appState);

  // Color-mode resolver. Subscribes to the persisted `colorMode`, then
  // resolves `'system'` against `prefers-color-scheme` and writes:
  //   - `<html class="dark">` — Tailwind `.dark` variant
  //   - `<body data-rd-mode>`  — design tokens
  // The pre-hydration script in `app.html` paints the initial mode to
  // avoid a flash; this effect keeps the DOM in sync as the user toggles
  // or the OS preference changes. The matchMedia listener is only
  // registered while `colorMode === 'system'` and cleaned up otherwise.
  let colorMode = $state(appState.getState().colorMode);
  $effect(() => {
    const unsubscribe = appState.subscribe((s) => {
      if (s.colorMode !== colorMode) colorMode = s.colorMode;
    });
    return unsubscribe;
  });
  $effect(() => {
    const mode = colorMode;
    const mql =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    function apply() {
      const resolved =
        mode === 'system' ? (mql?.matches ? 'dark' : 'light') : mode;
      const root = document.documentElement;
      root.classList.toggle('dark', resolved === 'dark');
      document.body.dataset.rdMode = resolved;
    }
    apply();
    if (mode === 'system' && mql) {
      const listener = () => apply();
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }
    return undefined;
  });
</script>

{@render children()}
