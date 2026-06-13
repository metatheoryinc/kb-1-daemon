import { describe, expect, it } from 'vitest';

import { getVisibleEditorSaveNotificationVariants } from './editor-save-notifications';

describe('editor save notification policy', () => {
  it('returns visible variants in stable chrome order', () => {
    expect(getVisibleEditorSaveNotificationVariants({
      externalMergeVisible: true,
      externalChangeVisible: true,
      persistFailureActive: true,
      persistRecoveredVisible: false,
      docDeleted: true,
    })).toEqual(['external-merge', 'external-change', 'persist-failure', 'doc-deleted']);
  });

  it('suppresses persist-recovered even when the flag is visible', () => {
    expect(getVisibleEditorSaveNotificationVariants({
      externalMergeVisible: false,
      externalChangeVisible: false,
      persistFailureActive: false,
      persistRecoveredVisible: true,
      docDeleted: false,
    })).toEqual([]);
  });
});
