<script lang="ts">
  import { onMount } from 'svelte';

  interface DaemonStatus {
    serviceName: string;
    startedAt: string;
    kb2Home: string;
    daemonHome: string;
    statusFile: string;
    pid: number;
    nodeVersion: string;
  }

  interface HealthResponse {
    ok: boolean;
    service: string;
    status: DaemonStatus;
  }

  let health: HealthResponse | null = null;
  let error: string | null = null;
  let loading = true;

  onMount(async () => {
    try {
      const response = await fetch('/api/health');

      if (!response.ok) {
        throw new Error(`Health request failed with ${response.status}`);
      }

      health = await response.json() as HealthResponse;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading = false;
    }
  });
</script>

<main class="min-h-screen bg-[#f6f7f9] text-[#15171a]">
  <section class="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-12 sm:px-10">
    <div class="border-b border-[#d7dce2] pb-6">
      <p class="text-sm font-semibold uppercase text-[#5a6572]">Local daemon</p>
      <h1 class="mt-3 text-4xl font-semibold tracking-normal text-[#111418] sm:text-5xl">KB-2 Local</h1>
      <p class="mt-4 max-w-2xl text-base leading-7 text-[#4b5563]">
        One local daemon port is serving the API and this SvelteKit shell.
      </p>
    </div>

    <div class="grid gap-5 py-8 md:grid-cols-[1.2fr_0.8fr]">
      <section class="rounded-lg border border-[#d7dce2] bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-lg font-semibold text-[#15171a]">Daemon status</h2>
          {#if loading}
            <span class="rounded-full bg-[#eef2f6] px-3 py-1 text-sm text-[#5a6572]">Checking</span>
          {:else if error}
            <span class="rounded-full bg-[#fff1f2] px-3 py-1 text-sm text-[#be123c]">Unavailable</span>
          {:else}
            <span class="rounded-full bg-[#ecfdf3] px-3 py-1 text-sm text-[#047857]">Online</span>
          {/if}
        </div>

        {#if error}
          <p class="mt-5 rounded-md border border-[#fecdd3] bg-[#fff1f2] p-4 text-sm text-[#9f1239]">{error}</p>
        {:else if health}
          <dl class="mt-6 grid gap-4 sm:grid-cols-2">
            <div>
              <dt class="text-sm text-[#6b7280]">Service</dt>
              <dd class="mt-1 font-mono text-sm text-[#111418]">{health.service}</dd>
            </div>
            <div>
              <dt class="text-sm text-[#6b7280]">Process</dt>
              <dd class="mt-1 font-mono text-sm text-[#111418]">pid {health.status.pid}</dd>
            </div>
            <div>
              <dt class="text-sm text-[#6b7280]">Started</dt>
              <dd class="mt-1 font-mono text-sm text-[#111418]">{health.status.startedAt}</dd>
            </div>
            <div>
              <dt class="text-sm text-[#6b7280]">Node</dt>
              <dd class="mt-1 font-mono text-sm text-[#111418]">{health.status.nodeVersion}</dd>
            </div>
          </dl>
        {:else}
          <p class="mt-5 text-sm text-[#5a6572]">Waiting for `/api/health`.</p>
        {/if}
      </section>

      <aside class="rounded-lg border border-[#d7dce2] bg-[#101418] p-5 text-white shadow-sm">
        <h2 class="text-lg font-semibold">Filesystem home</h2>
        {#if health}
          <div class="mt-5 space-y-4">
            <div>
              <p class="text-sm text-[#aab4c0]">KB2_HOME</p>
              <p class="mt-1 break-all font-mono text-sm">{health.status.kb2Home}</p>
            </div>
            <div>
              <p class="text-sm text-[#aab4c0]">Status file</p>
              <p class="mt-1 break-all font-mono text-sm">{health.status.statusFile}</p>
            </div>
          </div>
        {:else}
          <p class="mt-5 text-sm text-[#aab4c0]">Health data will appear after the API responds.</p>
        {/if}
      </aside>
    </div>
  </section>
</main>
