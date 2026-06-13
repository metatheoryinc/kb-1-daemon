import type { DocumentSaveBannerVariant } from '../notifications/DocumentSaveBanner.svelte';

export type EditorSaveNotificationVariant = Exclude<DocumentSaveBannerVariant, 'persist-recovered'>;

export interface EditorSaveNotificationCopy {
  title: string;
  message: string;
  dismissLabel?: string;
}

export interface EditorSaveNotificationsCopy {
  externalMerge: EditorSaveNotificationCopy;
  externalChange: EditorSaveNotificationCopy;
  persistFailure: EditorSaveNotificationCopy;
  docDeleted: EditorSaveNotificationCopy;
}

export interface EditorSaveNotificationFlags {
  externalMergeVisible: boolean;
  externalChangeVisible: boolean;
  persistFailureActive: boolean;
  persistRecoveredVisible: boolean;
  docDeleted: boolean;
}

export function getVisibleEditorSaveNotificationVariants(
  flags: EditorSaveNotificationFlags,
): EditorSaveNotificationVariant[] {
  const variants: EditorSaveNotificationVariant[] = [];

  if (flags.externalMergeVisible) variants.push('external-merge');
  if (flags.externalChangeVisible) variants.push('external-change');
  if (flags.persistFailureActive) variants.push('persist-failure');
  if (flags.docDeleted) variants.push('doc-deleted');

  return variants;
}
