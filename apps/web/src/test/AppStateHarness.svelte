<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { createAppState, setAppStateContext } from '$lib/app-state';
  import { createKbQueryClient } from '$lib/realtime';
  import Page from '../routes/+page.svelte';

  let {
    seedQueryClient,
  }: {
    seedQueryClient?: (client: QueryClient) => void;
  } = $props();

  // Mirror the root layout: build the app-state store once and publish it
  // on context so the page's `useAppState()` resolves a provider. This is
  // the layout's job in the real app; tests render the page in isolation,
  // so the harness stands in for the layout.
  const appState = createAppState({ storage: window.localStorage });
  setAppStateContext(appState);
  const { client: queryClient } = createKbQueryClient({ persist: false });
  function seedClient(): void {
    seedQueryClient?.(queryClient);
  }
  seedClient();
</script>

<QueryClientProvider client={queryClient}>
  <Page />
</QueryClientProvider>
