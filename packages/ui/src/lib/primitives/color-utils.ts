const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(input: string): boolean {
  return HEX_RE.test(input);
}

export function normalizeHex(color: string): string {
  if (color.length === 4 && color.startsWith("#")) {
    const [, r, g, b] = color;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (color.length === 7 && color.startsWith("#")) return color.toLowerCase();
  return color;
}
