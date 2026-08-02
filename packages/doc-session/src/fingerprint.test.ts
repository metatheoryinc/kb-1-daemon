import { describe, expect, it } from 'vitest';

import { fingerprintDocumentBytes } from './fingerprint.js';

describe('document fingerprints', () => {
  it.each([
    [new Uint8Array(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [
      new TextEncoder().encode('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    ],
  ])('uses the standard SHA-256 vector %#', (bytes, digest) => {
    expect(fingerprintDocumentBytes(bytes)).toBe(`sha256:${digest}`);
  });
});
