export { default as PlaintextEditor } from './PlaintextEditor.svelte';
export {
  PLAINTEXT_AGENT_ORIGIN,
  PLAINTEXT_USER_ORIGIN,
} from './content-format';
export type { LivePath, OrgPerson, WikilinkParts } from './markdown-core';
export { parseWikilinkInner, resolveLinkTarget } from './markdown-core';
// Remote-cursor layer (cloud-014 part-6). Consumed by the cloud's
// presence→awareness bridge (`cloud-plaintext-awareness.ts`) and its tests.
export {
  encodePlaintextRelativePosition,
  decodePlaintextCursor,
  dedupePlaintextCursors,
  snapshotRemotePlaintextCursors,
  buildPlaintextCursorDecorations,
  plaintextCursorProducer,
  plaintextCursorConsumer,
} from './plaintext-awareness';
export type {
  PlaintextAwarenessCursor,
  AwarenessCursor,
  EncodedRelPos,
  RemotePlaintextCursor,
} from './plaintext-awareness';
