export { default as PlaintextEditor } from './PlaintextEditor.svelte';
export {
  PLAINTEXT_AGENT_ORIGIN,
  PLAINTEXT_USER_ORIGIN,
} from './content-format';
export type { LivePath, OrgPerson } from './markdown-core';
export {
  buildPlaintextCursorDecorations,
  decodePlaintextCursor,
  encodePlaintextRelativePosition,
  plaintextCursorConsumer,
  plaintextCursorProducer,
  resolvePlaintextRelativePosition,
  snapshotRemotePlaintextCursors,
  type EncodedRelPos,
  type PlaintextAwarenessCursor,
  type RemotePlaintextCursor,
} from './plaintext-awareness';
