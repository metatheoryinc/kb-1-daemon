<script lang="ts">
  import MentionChip from '../MentionChip.svelte';
  import type { AccentName } from '@kb-2/ui';

  interface MentionChipFixture {
    accent: AccentName;
    letter: string;
    image: string | null;
    displayName: string;
    title: string;
    stale: boolean;
  }

  const chips: MentionChipFixture[] = [
    {
      accent: 'butter',
      letter: 'Y',
      image: null,
      displayName: 'Yoh',
      title: 'yoh@example.com',
      stale: false,
    },
    {
      accent: 'slate',
      letter: '?',
      image: null,
      displayName: 'Former teammate',
      title: 'former@example.com',
      stale: true,
    },
  ];
</script>

<div class="story">
  {#each chips as chip}
    <p>
      Mention:
      <MentionChip {...chip} />
    </p>
  {/each}
</div>

<style>
  .story {
    padding: 32px;
    color: var(--rd-ink-2);
    background: var(--rd-panel);
    font-family: var(--rd-serif);
    font-size: 16px;
    line-height: 1.65;
  }

  p {
    margin: 0 0 14px;
  }
</style>
