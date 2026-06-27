import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export const MESSAGE_SYNC = 0;
export const MESSAGE_SESSION_EVENT = 1;
export const MESSAGE_SYNCED = 2;
export const MESSAGE_ACKED_SYNC_UPDATE = 3;
export const MESSAGE_SYNC_UPDATE_ACK = 4;
export const MESSAGE_ATTRIBUTED_SYNC_UPDATE = 5;

const DOCUMENT_UPDATE_ATTRIBUTION_ORIGIN = Symbol('kb2.document-update-attribution-origin');

export type DocumentSessionEventKind =
  | 'content-persisted'
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

export interface AckedSyncUpdate {
  ackId: string;
  update: Uint8Array;
}

export interface SyncUpdateAck {
  ackId: string;
  ts: number;
}

export type DocumentUpdateAttributionValue =
  | null
  | boolean
  | number
  | string
  | DocumentUpdateAttributionValue[]
  | { [key: string]: DocumentUpdateAttributionValue };

export type DocumentUpdateAttribution = {
  [key: string]: DocumentUpdateAttributionValue;
};

export const LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION = {
  actor: { kind: 'user', id: 'local user', name: 'local user' }
} satisfies DocumentUpdateAttribution;

export const LOCAL_AGENT_DOCUMENT_UPDATE_ATTRIBUTION = {
  actor: { kind: 'mcp_client', id: 'local agent', name: 'local agent', client: 'local agent' }
} satisfies DocumentUpdateAttribution;

export const UNKNOWN_DOCUMENT_UPDATE_ATTRIBUTION = {
  actor: { kind: 'unknown' }
} satisfies DocumentUpdateAttribution;

export interface AttributedSyncUpdate {
  attribution: DocumentUpdateAttribution;
  update: Uint8Array;
}

interface DocumentUpdateAttributionOrigin {
  [DOCUMENT_UPDATE_ATTRIBUTION_ORIGIN]: true;
  attribution: DocumentUpdateAttribution;
  source?: unknown;
}

export function createDocumentUpdateAttributionOrigin(
  attribution: DocumentUpdateAttribution,
  source?: unknown,
): unknown {
  return {
    [DOCUMENT_UPDATE_ATTRIBUTION_ORIGIN]: true,
    attribution,
    ...(source !== undefined ? { source } : {})
  } satisfies DocumentUpdateAttributionOrigin;
}

export function documentUpdateAttributionFromOrigin(
  origin: unknown,
): DocumentUpdateAttribution | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const candidate = origin as Partial<DocumentUpdateAttributionOrigin>;
  if (candidate[DOCUMENT_UPDATE_ATTRIBUTION_ORIGIN] !== true) return undefined;
  return isJsonObject(candidate.attribution) ? candidate.attribution : undefined;
}

export function documentUpdateAttributionSourceFromOrigin(origin: unknown): unknown | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const candidate = origin as Partial<DocumentUpdateAttributionOrigin>;
  if (candidate[DOCUMENT_UPDATE_ATTRIBUTION_ORIGIN] !== true) return undefined;
  return candidate.source;
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

export function encodeAckedSyncUpdate(update: AckedSyncUpdate): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_ACKED_SYNC_UPDATE);
  encoding.writeVarString(encoder, update.ackId);
  encoding.writeVarUint8Array(encoder, update.update);
  return encoding.toUint8Array(encoder);
}

export function decodeAckedSyncUpdate(decoder: decoding.Decoder): AckedSyncUpdate | undefined {
  const ackId = decoding.readVarString(decoder);
  const update = decoding.readVarUint8Array(decoder);
  if (ackId.length === 0) return undefined;
  return { ackId, update };
}

export function encodeSyncUpdateAck(ack: SyncUpdateAck): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC_UPDATE_ACK);
  encoding.writeVarString(encoder, JSON.stringify(ack));
  return encoding.toUint8Array(encoder);
}

export function decodeSyncUpdateAck(decoder: decoding.Decoder): SyncUpdateAck | undefined {
  const parsed = JSON.parse(decoding.readVarString(decoder)) as Partial<SyncUpdateAck>;
  if (typeof parsed.ackId !== 'string' || parsed.ackId.length === 0 || typeof parsed.ts !== 'number') {
    return undefined;
  }
  return { ackId: parsed.ackId, ts: parsed.ts };
}

export function encodeAttributedSyncUpdate(update: AttributedSyncUpdate): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_ATTRIBUTED_SYNC_UPDATE);
  encoding.writeVarString(encoder, JSON.stringify({ attribution: update.attribution }));
  encoding.writeVarUint8Array(encoder, update.update);
  return encoding.toUint8Array(encoder);
}

export function decodeAttributedSyncUpdate(
  decoder: decoding.Decoder,
): AttributedSyncUpdate | undefined {
  const parsed = JSON.parse(decoding.readVarString(decoder)) as { attribution?: unknown };
  const update = decoding.readVarUint8Array(decoder);
  if (!isJsonObject(parsed.attribution)) {
    return undefined;
  }
  return { attribution: parsed.attribution, update };
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
  return kind === 'content-persisted' ||
    kind === 'external-merge' ||
    kind === 'external-change' ||
    kind === 'persist-failure' ||
    kind === 'persist-recovered' ||
    kind === 'doc-moved' ||
    kind === 'doc-deleted';
}

function isJsonObject(value: unknown): value is DocumentUpdateAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is DocumentUpdateAttributionValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === 'object') {
    return isJsonObject(value);
  }
  return false;
}
