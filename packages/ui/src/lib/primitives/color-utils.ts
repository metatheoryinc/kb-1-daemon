/**
 * Color helpers for folder icons. The picker lets users pick any hex;
 * the rendered icon needs a darker border shade derived from the fill
 * without storing it separately. We lean on CSS `color-mix()` for the
 * live rendering — this module only handles validation and the
 * server-agnostic fallback color.
 */

export const DEFAULT_ICON_COLOR = '#cbd5e1';

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(input: string): boolean {
  return HEX_RE.test(input);
}

/**
 * Expand `#rgb` to `#rrggbb`. Returns the input unchanged for any other
 * shape so callers can pass the result straight into CSS.
 */
export function normalizeHex(color: string): string {
  if (color.length === 4 && color.startsWith('#')) {
    const [, r, g, b] = color;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (color.length === 7 && color.startsWith('#')) return color.toLowerCase();
  return color;
}
