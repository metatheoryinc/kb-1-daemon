<script lang="ts">
  import { LocalStatusShell } from '@kb-2/ui';
  import type { HealthResponse } from '@kb-2/ui';
  import { onMount } from 'svelte';

  let { routeLabel = 'Local daemon' } = $props<{
    routeLabel?: string;
  }>();

  let health = $state<HealthResponse | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      const response = await fetch('/api/health');

      if (!response.ok) {
        throw new Error(`Health request failed with ${response.status}`);
      }

      health = (await response.json()) as HealthResponse;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading = false;
    }
  });
</script>

<LocalStatusShell {routeLabel} {health} {error} {loading} />
