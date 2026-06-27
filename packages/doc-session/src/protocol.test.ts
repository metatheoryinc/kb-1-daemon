import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

import {
  MESSAGE_ATTRIBUTED_SYNC_UPDATE,
  MESSAGE_ACKED_SYNC_UPDATE,
  MESSAGE_SESSION_EVENT,
  MESSAGE_SYNC_UPDATE_ACK,
  decodeAckedSyncUpdate,
  decodeAttributedSyncUpdate,
  decodeSessionEvent,
  decodeSyncUpdateAck,
  encodeAckedSyncUpdate,
  encodeAttributedSyncUpdate,
  encodeSessionEvent,
  encodeSyncUpdateAck,
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

  it('round-trips acked sync update frames', () => {
    const update = new Uint8Array([1, 2, 3]);
    const decoder = decoding.createDecoder(encodeAckedSyncUpdate({ ackId: 'ack-1', update }));

    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_ACKED_SYNC_UPDATE);
    expect(decodeAckedSyncUpdate(decoder)).toEqual({ ackId: 'ack-1', update });
  });

  it('rejects empty acked sync update ids', () => {
    const decoder = decoding.createDecoder(encodeAckedSyncUpdate({ ackId: '', update: new Uint8Array([1]) }));

    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_ACKED_SYNC_UPDATE);
    expect(decodeAckedSyncUpdate(decoder)).toBeUndefined();
  });

  it('round-trips sync update ack frames', () => {
    const decoder = decoding.createDecoder(encodeSyncUpdateAck({ ackId: 'ack-1', ts: 123 }));

    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC_UPDATE_ACK);
    expect(decodeSyncUpdateAck(decoder)).toEqual({ ackId: 'ack-1', ts: 123 });
  });

  it.each([
    { ackId: '', ts: 123 },
    { ackId: 42, ts: 123 },
    { ackId: 'ack-1', ts: 'now' }
  ])('rejects malformed sync update acks %#', (payload) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, JSON.stringify(payload));

    expect(decodeSyncUpdateAck(decoding.createDecoder(encoding.toUint8Array(encoder)))).toBeUndefined();
  });

  it('round-trips attributed sync update frames', () => {
    const update = new Uint8Array([7, 8, 9]);
    const attribution = {
      actor: { kind: 'integration', id: 'agent-1', name: 'Agent One' },
      operation: 'splice',
      path: 'notes/demo.md'
    };
    const decoder = decoding.createDecoder(encodeAttributedSyncUpdate({ attribution, update }));

    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_ATTRIBUTED_SYNC_UPDATE);
    expect(decodeAttributedSyncUpdate(decoder)).toEqual({ attribution, update });
  });

  it.each([
    { attribution: null },
    { attribution: ['not', 'an', 'object'] },
    { attribution: 42 },
    { attribution: 'actor' }
  ])('rejects malformed attributed sync update frames %#', (payload) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, JSON.stringify(payload));
    encoding.writeVarUint8Array(encoder, new Uint8Array([1]));

    expect(decodeAttributedSyncUpdate(decoding.createDecoder(encoding.toUint8Array(encoder)))).toBeUndefined();
  });
});
