<script lang="ts">
  import { LocalStatusShell } from '@kb-2/ui';

  let { routeLabel = 'Local daemon' } = $props<{
    routeLabel?: string;
  }>();
</script>

<LocalStatusShell {routeLabel} />
