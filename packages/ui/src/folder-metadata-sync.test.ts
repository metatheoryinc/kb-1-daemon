import { describe, expect, it } from 'vitest';

import { folderMetadataColorNames, folderMetadataIconNames } from '../../vault-core/src/folder-metadata-options.js';
import { accentNames } from './lib/primitives/accent.js';
import { iconNames } from './lib/primitives/types.js';

describe('folder metadata primitives', () => {
  it('keeps vault-core folder metadata colors and icons in sync with UI primitives', () => {
    expect(folderMetadataColorNames).toEqual(accentNames);
    expect(folderMetadataIconNames).toEqual(iconNames);
  });
});
