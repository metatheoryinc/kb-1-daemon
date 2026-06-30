export const INHERIT_COLOR = "inherit";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type FolderMetadataColor = string;

export function normalizeFolderMetadataColor(
  color: string,
): FolderMetadataColor | null {
  if (color === INHERIT_COLOR) return INHERIT_COLOR;
  if (!HEX_COLOR_PATTERN.test(color)) return null;
  const normalized = color.toLowerCase();
  if (normalized.length === 4) {
    return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`;
  }
  return normalized;
}
