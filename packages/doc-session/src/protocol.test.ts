import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

import {
  MESSAGE_SESSION_EVENT,
  decodeSessionEvent,
  encodeSessionEvent,
  type DocumentSessionEvent,
  type DocumentSessionEventKind
} from './protocol.js';

describe('document session protocol events', () => {
  it.each([
    'content-persisted',
    'external-merge',
    'external-change',
    'persist-failure',
    'persist-recovered',
    'doc-moved',
    'doc-deleted'
  ] satisfies DocumentSessionEventKind[])('round-trips %s session events', (kind) => {
    const event: DocumentSessionEvent = {
      kind,
      path: 'notes/demo.md',
      ts: 123,
      fromPath: 'notes/old.md',
      toPath: 'notes/demo.md'
    };

    const decoder = decoding.createDecoder(encodeSessionEvent(event));

    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SESSION_EVENT);
    expect(decodeSessionEvent(decoder)).toEqual(event);
  });

  it.each([
    { kind: 'unknown', path: 'notes/demo.md', ts: 123 },
    { kind: 'content-persisted', path: 42, ts: 123 },
    { kind: 'content-persisted', path: 'notes/demo.md', ts: 'now' },
    { kind: 'content-persisted', path: 'notes/demo.md', ts: 123, fromPath: 42 },
    { kind: 'content-persisted', path: 'notes/demo.md', ts: 123, toPath: 42 }
  ])('rejects malformed session events %#', (payload) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, JSON.stringify(payload));

    expect(decodeSessionEvent(decoding.createDecoder(encoding.toUint8Array(encoder)))).toBeUndefined();
  });
});
