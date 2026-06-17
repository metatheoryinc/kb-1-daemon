<script lang="ts">
  import Avatar from '../../primitives/Avatar.svelte';

  interface Props {
    /** Display label for the local identity. Static — there is no user
        model, auth, or sign-out behind it; the chip is presentation only. */
    label?: string;
  }

  let { label = 'Local user' }: Props = $props();
</script>

<div class="user-chip" title={label} aria-label={label}>
  <Avatar kind="human" accent="slate" letter={label} size={26} />
</div>

<style>
  .user-chip {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 44px;
    margin-top: 10px;
    padding: 8px;
    border: 1px solid var(--rd-rule);
    border-radius: 10px;
    background: var(--rd-panel);
  }
</style>
