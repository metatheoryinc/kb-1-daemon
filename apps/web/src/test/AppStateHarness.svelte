<script lang="ts">
  import { createAppState, setAppStateContext } from '$lib/app-state';
  import Page from '../routes/+page.svelte';

  // Mirror the root layout: build the app-state store once and publish it
  // on context so the page's `useAppState()` resolves a provider. This is
  // the layout's job in the real app; tests render the page in isolation,
  // so the harness stands in for the layout.
  const appState = createAppState({ storage: window.localStorage });
  setAppStateContext(appState);
</script>

<Page />
