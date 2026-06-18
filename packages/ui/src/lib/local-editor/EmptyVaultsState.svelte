<script lang="ts">
  import Button from '../button/button.svelte';
  import Icon from '../primitives/Icon.svelte';

  /**
   * The calm "no vaults yet" screen. Zero vaults is a NORMAL state — a
   * fresh daemon, or the user just deleted the last vault — never an
   * error. This invites the user to create their first vault.
   *
   * Prop-driven and transport-free: the create action is the host's
   * `onCreateVault` callback (the host opens the new-vault dialog and owns
   * the network create).
   */
  interface Props {
    /** Open the create-vault flow. */
    onCreateVault?: () => void;
  }

  let { onCreateVault }: Props = $props();
</script>

<section class="empty-vaults" aria-label="No vaults yet">
  <div class="card">
    <span class="glyph" aria-hidden="true">
      <Icon name="folder" size={28} weight="duotone" />
    </span>
    <h1>Create your first vault</h1>
    <p class="message">
      A vault is a folder of notes. You don’t have one yet — create one to
      start writing. Your notes live as plain files on disk.
    </p>
    <Button onclick={() => onCreateVault?.()}>
      <span class="btn-glyph" aria-hidden="true">
        <Icon name="plus" size={14} weight="bold" />
      </span>
      New vault
    </Button>
  </div>
</section>

<style>
  .empty-vaults {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    min-height: 100%;
    padding: 48px 24px;
    background: var(--rd-bg);
    font-family: var(--rd-ui);
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 30rem;
    gap: 14px;
  }

  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 14px;
    background: var(--rd-panel);
    color: var(--rd-ink-3);
  }

  h1 {
    margin: 0;
    color: var(--rd-ink-1);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .message {
    margin: 0;
    color: var(--rd-ink-3);
    font-size: 14px;
    line-height: 1.6;
  }

  .btn-glyph {
    display: inline-flex;
    align-items: center;
    margin-right: 6px;
  }
</style>
