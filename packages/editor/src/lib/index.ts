export { default as PlaintextEditor } from './PlaintextEditor.svelte';
export {
  PLAINTEXT_AGENT_ORIGIN,
  PLAINTEXT_USER_ORIGIN,
} from './content-format';
export type { LivePath, OrgPerson, WikilinkParts } from './markdown-core';
export { parseWikilinkInner, resolveLinkTarget } from './markdown-core';
// Remote-cursor layer. Consumed by presence-to-awareness bridges and tests.
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
