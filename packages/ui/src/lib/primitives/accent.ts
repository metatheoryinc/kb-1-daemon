const userAccents = [
  'coral',
  'peach',
  'butter',
  'sage',
  'mint',
  'lime',
  'sky',
  'periwinkle',
  'lavender',
  'rose',
  'teal',
] as const;

export const accents = [...userAccents, 'slate'] as const;

export type AccentName = (typeof accents)[number];

export const accentHex: Record<AccentName, string> = {
  coral: '#ee8a91',
  peach: '#e9a570',
  butter: '#dcb653',
  sage: '#7dcb8e',
  mint: '#70cdb4',
  lime: '#9ccf66',
  sky: '#7fb9e5',
  periwinkle: '#8f8bd9',
  lavender: '#a48cd6',
  rose: '#e68ab2',
  teal: '#63bcc0',
  slate: '#8fa3b1',
};

export const accentNames = accents;

export function accentForId(id: string): AccentName {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return userAccents[hash % userAccents.length] ?? 'slate';
}

export function accentHexForId(id: string): string {
  return accentHex[accentForId(id)];
}

export function accentStyle(accent: AccentName = 'slate'): string {
  return `--rd-accent: var(--rd-${accent}); --rd-accent-bg: var(--rd-${accent}-bg);`;
}
