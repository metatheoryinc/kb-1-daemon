import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function statOrNull(pathname: string): Promise<Stats | null> {
  try {
    return await stat(pathname);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}
