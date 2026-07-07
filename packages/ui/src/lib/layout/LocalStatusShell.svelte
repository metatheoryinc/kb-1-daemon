<script lang="ts" module>
  export interface DaemonStatus {
    serviceName: string;
    startedAt: string;
    kb1Home: string;
    daemonHome: string;
    statusFile: string;
    pid: number;
    nodeVersion: string;
  }

  export interface HealthResponse {
    ok: boolean;
    service: string;
    status: DaemonStatus;
  }
</script>

<script lang="ts">
  import Badge from '../primitives/Badge.svelte';
  import BrandMark from '../primitives/BrandMark.svelte';
  import { Button } from '../button';
  import Panel from './Panel.svelte';

  let {
    routeLabel = 'Local daemon',
    health = null,
    error = null,
    loading = true,
  } = $props<{
    routeLabel?: string;
    health?: HealthResponse | null;
    error?: string | null;
    loading?: boolean;
  }>();
</script>

<main class="status-shell">
  <section class="status-frame">
    <div class="hero">
      <BrandMark size={34} />
      <div>
        <p class="eyebrow">{routeLabel}</p>
        <h1>KB-1 Local</h1>
        <p class="summary">One local daemon port is serving the API and this SvelteKit shell.</p>
      </div>
    </div>

    <div class="status-grid">
      <Panel title="Daemon status" eyebrow="Runtime">
        {#snippet actions()}
          {#if loading}
            <Badge>Checking</Badge>
          {:else if error}
            <Badge tone="danger">Unavailable</Badge>
          {:else}
            <Badge tone="success">Online</Badge>
          {/if}
        {/snippet}

        {#if error}
          <p class="error">{error}</p>
        {:else if health}
          <dl class="status-list">
            <div>
              <dt>Service</dt>
              <dd>{health.service}</dd>
            </div>
            <div>
              <dt>Process</dt>
              <dd>pid {health.status.pid}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{health.status.startedAt}</dd>
            </div>
            <div>
              <dt>Node</dt>
              <dd>{health.status.nodeVersion}</dd>
            </div>
          </dl>
        {:else}
          <p class="muted">Waiting for `/api/health`.</p>
        {/if}
      </Panel>

      <Panel title="Filesystem home" eyebrow="Local state" class="dark-panel">
        {#if health}
          <div class="path-list">
            <div>
              <p>KB1_HOME</p>
              <code>{health.status.kb1Home}</code>
            </div>
            <div>
              <p>Status file</p>
              <code>{health.status.statusFile}</code>
            </div>
          </div>
        {:else}
          <p class="muted-dark">Health data will appear after the API responds.</p>
        {/if}
      </Panel>
    </div>

    <div class="shell-footer">
      <Button variant="secondary" href="/status">Open status route</Button>
    </div>
  </section>
</main>

<style>
  .status-shell {
    min-height: 100vh;
    background: var(--rd-bg);
    color: var(--rd-ink-1);
  }

  .status-frame {
    display: flex;
    width: min(100%, 1040px);
    min-height: 100vh;
    flex-direction: column;
    justify-content: center;
    margin: 0 auto;
    padding: 48px 24px;
  }

  .hero {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    border-bottom: 1px solid var(--rd-rule-strong);
    padding-bottom: 28px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--rd-ink-3);
    font-family: var(--rd-ui);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: clamp(38px, 7vw, 56px);
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1;
  }

  .summary {
    max-width: 42rem;
    margin: 16px 0 0;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 16px;
    line-height: 1.6;
  }

  .status-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
    gap: 20px;
    padding: 28px 0;
  }

  .status-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    margin: 0;
  }

  dt,
  .path-list p {
    margin: 0;
    color: var(--rd-ink-3);
    font-family: var(--rd-ui);
    font-size: 12px;
  }

  dd,
  code {
    display: block;
    margin: 4px 0 0;
    color: var(--rd-ink-1);
    font-family: var(--rd-mono);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  :global(.kb1-panel.dark-panel) {
    background: #101418;
    color: #fff;
    --rd-ink-1: #fff;
    --rd-ink-3: #aab4c0;
    --rd-rule: rgba(255, 255, 255, 0.1);
  }

  :global(.kb1-panel.dark-panel) .path-list {
    display: grid;
    gap: 18px;
  }

  .muted,
  .muted-dark,
  .error {
    margin: 0;
    border-radius: 6px;
    padding: 14px;
    font-family: var(--rd-ui);
    font-size: 13px;
  }

  .muted {
    color: var(--rd-ink-3);
    background: var(--rd-panel-alt);
  }

  .muted-dark {
    color: #aab4c0;
    background: rgba(255, 255, 255, 0.06);
  }

  .error {
    color: var(--destructive);
    background: color-mix(in srgb, var(--destructive) 10%, transparent);
  }

  .shell-footer {
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 760px) {
    .status-grid,
    .status-list {
      grid-template-columns: 1fr;
    }
  }
</style>
