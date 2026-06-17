<script lang="ts">
  import {
    ArrowsClockwise,
    ArrowsOut,
    Bell,
    BookBookmark,
    BookOpen,
    BookmarkSimple,
    CaretDown,
    CaretLeft,
    CaretRight,
    ClockCounterClockwise,
    Cloud,
    Code,
    Desktop,
    DeviceMobile,
    DotsThree,
    File,
    Folder,
    PushPinSimple,
    PushPinSimpleSlash,
    FunnelSimple,
    GearSix,
    House,
    List,
    MagnifyingGlass,
    Moon,
    NotePencil,
    Plus,
    Pulse,
    Robot,
    SidebarSimple,
    Star,
    Stop,
    Sun,
    User,
    UsersThree,
    X,
  } from 'phosphor-svelte';
  import type { IconName, IconWeight } from './types';

  interface Props {
    name: IconName;
    size?: number;
    weight?: IconWeight;
    title?: string;
    ariaLabel?: string;
    class?: string;
  }

  let {
    name,
    size = 18,
    weight = 'thin',
    title,
    ariaLabel,
    class: className = '',
  }: Props = $props();

  const label = $derived(ariaLabel ?? title);
  const phosphorProps = $derived({
    size,
    weight,
    class: className,
    'aria-hidden': label ? undefined : true,
    'aria-label': label,
  });

  type BrandIconName = Extract<
    IconName,
    | 'claude'
    | 'anthropic'
    | 'openai'
    | 'chatgpt'
    | 'codex'
    | 'opencode'
    | 'claudeCode'
    | 'cursor'
    | 'gemini'
    | 'copilot'
    | 'mistral'
    | 'replit'
    | 'zed'
    | 'cline'
  >;

  type BrandPath = {
    d?: string;
    opacity?: string;
    fillRule?: 'evenodd' | 'nonzero';
    clipRule?: 'evenodd' | 'nonzero';
    rect?: { width: number; height: number };
  };

  type BrandIcon = {
    viewBox: string;
    center: [number, number];
    scale: number;
    translate?: [number, number];
    paths: BrandPath[];
  };

  const openAiPaths: BrandPath[] = [
    {
      d: 'M75.91 73.628V62.232c0-.96.36-1.68 1.199-2.16l22.912-13.194c3.119-1.8 6.838-2.639 10.676-2.639 14.394 0 23.511 11.157 23.511 23.032 0 .839 0 1.799-.12 2.758l-23.752-13.914c-1.439-.84-2.879-.84-4.318 0L75.91 73.627Zm53.499 44.383v-27.23c0-1.68-.72-2.88-2.159-3.719L97.142 69.55l9.836-5.638c.839-.48 1.559-.48 2.399 0l22.912 13.195c6.598 3.839 11.035 11.995 11.035 19.912 0 9.116-5.397 17.513-13.915 20.992v.001Zm-60.577-23.99-9.836-5.758c-.84-.48-1.2-1.2-1.2-2.16v-26.39c0-12.834 9.837-22.55 23.152-22.55 5.039 0 9.716 1.679 13.676 4.678L70.993 55.516c-1.44.84-2.16 2.039-2.16 3.719v34.787-.002Zm21.173 12.234L75.91 98.339V81.546l14.095-7.917 14.094 7.917v16.793l-14.094 7.916Zm9.056 36.467c-5.038 0-9.716-1.68-13.675-4.678l23.631-13.676c1.439-.839 2.159-2.038 2.159-3.718V85.863l9.956 5.757c.84.48 1.2 1.2 1.2 2.16v26.389c0 12.835-9.957 22.552-23.27 22.552v.001Zm-28.43-26.75L47.72 102.778c-6.599-3.84-11.036-11.996-11.036-19.913 0-9.236 5.518-17.513 14.034-20.992v27.35c0 1.68.72 2.879 2.16 3.718l29.989 17.393-9.837 5.638c-.84.48-1.56.48-2.399 0Zm-1.318 19.673c-13.555 0-23.512-10.196-23.512-22.792 0-.959.12-1.919.24-2.879l23.63 13.675c1.44.84 2.88.84 4.32 0l30.108-17.392v11.395c0 .96-.361 1.68-1.2 2.16l-22.912 13.194c-3.119 1.8-6.837 2.639-10.675 2.639Zm29.748 14.274c14.515 0 26.63-10.316 29.39-23.991 13.434-3.479 22.071-16.074 22.071-28.91 0-8.396-3.598-16.553-10.076-22.43.6-2.52.96-5.039.96-7.557 0-17.153-13.915-29.99-29.989-29.99-3.239 0-6.358.48-9.477 1.56-5.398-5.278-12.835-8.637-20.992-8.637-14.515 0-26.63 10.316-29.39 23.991-13.434 3.48-22.07 16.074-22.07 28.91 0 8.396 3.598 16.553 10.075 22.431-.6 2.519-.96 5.038-.96 7.556 0 17.154 13.915 29.989 29.99 29.989 3.238 0 6.357-.479 9.476-1.559 5.397 5.278 12.835 8.637 20.992 8.637Z',
    },
  ];

  const brandIcons: Record<BrandIconName, BrandIcon> = {
    claude: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.76,
      paths: [
        {
          d: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
        },
      ],
    },
    anthropic: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      translate: [0, 0.2],
      paths: [
        {
          d: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
        },
      ],
    },
    openai: {
      viewBox: '0 0 180 180',
      center: [90, 90],
      scale: 1.14,
      translate: [0, -3],
      paths: openAiPaths,
    },
    chatgpt: {
      viewBox: '0 0 180 180',
      center: [90, 90],
      scale: 1.14,
      translate: [0, -3],
      paths: openAiPaths,
    },
    codex: {
      viewBox: '0 0 180 180',
      center: [90, 90],
      scale: 1.14,
      translate: [0, -3],
      paths: openAiPaths,
    },
    opencode: {
      viewBox: '0 0 512 512',
      center: [256, 256],
      scale: 0.78,
      paths: [
        { rect: { width: 512, height: 512 }, opacity: '0.18' },
        { d: 'M320 224V352H192V224H320Z', opacity: '0.46' },
        { d: 'M384 416H128V96H384V416ZM320 160H192V352H320V160Z', fillRule: 'evenodd', clipRule: 'evenodd' },
      ],
    },
    // Claude Code uses the Anthropic "A" mark — Anthropic publishes the
    // wordmark "A" as the Claude Code identifier in CLI contexts.
    claudeCode: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      translate: [0, 0.2],
      paths: [
        {
          d: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
        },
      ],
    },
    cursor: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
        },
      ],
    },
    gemini: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
        },
      ],
    },
    copilot: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z',
        },
      ],
    },
    mistral: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z',
        },
      ],
    },
    replit: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'M2 1.5A1.5 1.5 0 0 1 3.5 0h7A1.5 1.5 0 0 1 12 1.5V8H3.5A1.5 1.5 0 0 1 2 6.5ZM12 8h8.5A1.5 1.5 0 0 1 22 9.5v5a1.5 1.5 0 0 1-1.5 1.5H12ZM2 17.5A1.5 1.5 0 0 1 3.5 16H12v6.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 22.5Z',
        },
      ],
    },
    zed: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z',
        },
      ],
    },
    cline: {
      viewBox: '0 0 24 24',
      center: [12, 12],
      scale: 0.86,
      paths: [
        {
          d: 'm23.365 13.556-1.442-2.895V8.994c0-2.764-2.218-5.002-4.954-5.002h-2.464c.178-.367.276-.779.276-1.213A2.77 2.77 0 0 0 12.018 0a2.77 2.77 0 0 0-2.763 2.779c0 .434.098.846.276 1.213H7.067c-2.736 0-4.954 2.238-4.954 5.002v1.667L.64 13.549c-.149.29-.149.636 0 .927l1.472 2.855v1.667C2.113 21.762 4.33 24 7.067 24h9.902c2.736 0 4.954-2.238 4.954-5.002V17.33l1.44-2.865c.143-.286.143-.622.002-.91m-12.854 2.36a2.27 2.27 0 0 1-2.261 2.273 2.27 2.27 0 0 1-2.261-2.273v-4.042A2.27 2.27 0 0 1 8.249 9.6a2.267 2.267 0 0 1 2.262 2.274zm7.285 0a2.27 2.27 0 0 1-2.26 2.273 2.27 2.27 0 0 1-2.262-2.273v-4.042A2.267 2.267 0 0 1 15.535 9.6a2.267 2.267 0 0 1 2.261 2.274z',
        },
      ],
    },
  };

  const brandIcon = $derived(brandIcons[name as BrandIconName]);
  const brandTransform = $derived.by(() => {
    if (!brandIcon) return undefined;

    const [centerX, centerY] = brandIcon.center;
    const [translateX, translateY] = brandIcon.translate ?? [0, 0];

    return `translate(${centerX + translateX} ${centerY + translateY}) scale(${brandIcon.scale}) translate(${-centerX} ${-centerY})`;
  });
</script>

{#if brandIcon}
  <svg width={size} height={size} viewBox={brandIcon.viewBox} fill="currentColor" class={className} aria-hidden={label ? undefined : 'true'} aria-label={label}>
    {#if title}<title>{title}</title>{/if}
    <g transform={brandTransform}>
      {#each brandIcon.paths as path}
        {#if path.rect}
          <rect width={path.rect.width} height={path.rect.height} opacity={path.opacity} fill="currentColor" />
        {:else}
          <path d={path.d} opacity={path.opacity} fill="currentColor" fill-rule={path.fillRule} clip-rule={path.clipRule} />
        {/if}
      {/each}
    </g>
  </svg>
{:else if name === 'bookmark'}
  <BookmarkSimple {...phosphorProps} />
{:else if name === 'home'}
  <House {...phosphorProps} />
{:else if name === 'vault'}
  <BookBookmark {...phosphorProps} />
{:else if name === 'book'}
  <BookOpen {...phosphorProps} />
{:else if name === 'activity'}
  <Pulse {...phosphorProps} />
{:else if name === 'people'}
  <UsersThree {...phosphorProps} />
{:else if name === 'star'}
  <Star {...phosphorProps} />
{:else if name === 'user'}
  <User {...phosphorProps} />
{:else if name === 'stop'}
  <Stop {...phosphorProps} />
{:else if name === 'history'}
  <ClockCounterClockwise {...phosphorProps} />
{:else if name === 'refresh'}
  <ArrowsClockwise {...phosphorProps} />
{:else if name === 'fullscreen'}
  <ArrowsOut {...phosphorProps} />
{:else if name === 'panel'}
  <SidebarSimple {...phosphorProps} />
{:else if name === 'collapse'}
  <CaretLeft {...phosphorProps} />
{:else if name === 'expand-rail'}
  <CaretRight {...phosphorProps} />
{:else if name === 'dots'}
  <DotsThree {...phosphorProps} />
{:else if name === 'settings'}
  <GearSix {...phosphorProps} />
{:else if name === 'plus'}
  <Plus {...phosphorProps} />
{:else if name === 'search'}
  <MagnifyingGlass {...phosphorProps} />
{:else if name === 'filter'}
  <FunnelSimple {...phosphorProps} />
{:else if name === 'chevron'}
  <CaretRight {...phosphorProps} />
{:else if name === 'chevron-down'}
  <CaretDown {...phosphorProps} />
{:else if name === 'file'}
  <File {...phosphorProps} />
{:else if name === 'folder'}
  <Folder {...phosphorProps} />
{:else if name === 'robot'}
  <Robot {...phosphorProps} />
{:else if name === 'cloud'}
  <Cloud {...phosphorProps} />
{:else if name === 'code'}
  <Code {...phosphorProps} />
{:else if name === 'note'}
  <NotePencil {...phosphorProps} />
{:else if name === 'menu'}
  <List {...phosphorProps} />
{:else if name === 'pushpin'}
  <PushPinSimple {...phosphorProps} />
{:else if name === 'pushpin-slash'}
  <PushPinSimpleSlash {...phosphorProps} />
{:else if name === 'sun'}
  <Sun {...phosphorProps} />
{:else if name === 'moon'}
  <Moon {...phosphorProps} />
{:else if name === 'desktop'}
  <Desktop {...phosphorProps} />
{:else if name === 'device-mobile'}
  <DeviceMobile {...phosphorProps} />
{:else if name === 'bell'}
  <Bell {...phosphorProps} />
{:else if name === 'x'}
  <X {...phosphorProps} />
{/if}

<style>
  svg {
    display: block;
    flex-shrink: 0;
  }
</style>
