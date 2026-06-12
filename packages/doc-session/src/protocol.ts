import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const MESSAGE_SYNC = 0;
export const MESSAGE_SESSION_EVENT = 1;
export const MESSAGE_SYNCED = 2;

export type DocumentSessionEventKind =
  | 'external-merge'
  | 'external-change'
  | 'persist-failure'
  | 'persist-recovered'
  | 'doc-moved'
  | 'doc-deleted';

export interface DocumentSessionEvent {
  kind: DocumentSessionEventKind;
  path: string;
  ts: number;
  fromPath?: string;
  toPath?: string;
}

export function encodeSessionEvent(event: DocumentSessionEvent): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SESSION_EVENT);
  encoding.writeVarString(encoder, JSON.stringify(event));
  return encoding.toUint8Array(encoder);
}

export function encodeSyncedMessage(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNCED);
  return encoding.toUint8Array(encoder);
}

export function decodeSessionEvent(
  decoder: decoding.Decoder,
): DocumentSessionEvent | undefined {
  const parsed = JSON.parse(decoding.readVarString(decoder)) as Partial<DocumentSessionEvent>;

  if (
    !isSessionEventKind(parsed.kind) ||
    typeof parsed.path !== 'string' ||
    typeof parsed.ts !== 'number' ||
    (parsed.fromPath !== undefined && typeof parsed.fromPath !== 'string') ||
    (parsed.toPath !== undefined && typeof parsed.toPath !== 'string')
  ) {
    return undefined;
  }

  return {
    kind: parsed.kind,
    path: parsed.path,
    ts: parsed.ts,
    ...(parsed.fromPath !== undefined ? { fromPath: parsed.fromPath } : {}),
    ...(parsed.toPath !== undefined ? { toPath: parsed.toPath } : {}),
  };
}

function isSessionEventKind(kind: unknown): kind is DocumentSessionEventKind {
  return kind === 'external-merge' ||
    kind === 'external-change' ||
    kind === 'persist-failure' ||
    kind === 'persist-recovered' ||
    kind === 'doc-moved' ||
    kind === 'doc-deleted';
}
