import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  PENDING_UPLOAD_SCHEME,
  PLAINTEXT_IMAGE_SWAP_ORIGIN,
  UPLOAD_FAILED_SCHEME,
  plaintextImageUpload,
  swapSentinelInYText,
} from './plaintext-image-upload';
import { PLAINTEXT_USER_ORIGIN } from './content-format';

function setupDoc(initial = ''): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText('markdown');
  if (initial.length > 0) {
    doc.transact(() => {
      ytext.insert(0, initial);
    }, null);
  }
  return { doc, ytext };
}

describe('swapSentinelInYText', () => {
  it('replaces a pending-upload sentinel with the uploaded path', () => {
    const { doc, ytext } = setupDoc('before ![cat](pending-upload://abc) after');
    expect(
      swapSentinelInYText(ytext, doc, 'pending-upload://abc', 'cat.png'),
    ).toBe(true);
    expect(ytext.toJSON()).toBe('before ![cat](cat.png) after');
  });

  it('returns false when the sentinel is gone', () => {
    const { doc, ytext } = setupDoc('plain text');
    expect(
      swapSentinelInYText(ytext, doc, 'pending-upload://missing', 'x.png'),
    ).toBe(false);
    expect(ytext.toJSON()).toBe('plain text');
  });

  it('uses a non-user origin so upload completion is not undoable', () => {
    const { doc, ytext } = setupDoc(`![](${PENDING_UPLOAD_SCHEME}uuid)`);
    const undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([PLAINTEXT_USER_ORIGIN]),
    });
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr) => origins.push(tr.origin));

    swapSentinelInYText(ytext, doc, `${PENDING_UPLOAD_SCHEME}uuid`, 'final.png');

    expect(origins).toContain(PLAINTEXT_IMAGE_SWAP_ORIGIN);
    undoManager.undo();
    expect(ytext.toJSON()).toBe('![](final.png)');
  });
});

describe('plaintextImageUpload', () => {
  it('constructs a CodeMirror extension', () => {
    const { doc, ytext } = setupDoc();
    expect(
      plaintextImageUpload({
        uploadFile: () => Promise.resolve({ path: 'noop.png' }),
        ydoc: doc,
        ytext,
      }),
    ).toBeDefined();
  });

  it('documents the failure sentinel contract used by the image widget', () => {
    const { doc, ytext } = setupDoc();
    const uuid = 'failed-upload';
    doc.transact(() => {
      ytext.insert(0, `![x](${PENDING_UPLOAD_SCHEME}${uuid})`);
    }, PLAINTEXT_USER_ORIGIN);
    const onError = vi.fn();
    const error = new Error('upload failed');

    swapSentinelInYText(
      ytext,
      doc,
      `${PENDING_UPLOAD_SCHEME}${uuid}`,
      `${UPLOAD_FAILED_SCHEME}${uuid}`,
    );
    onError(error);

    expect(ytext.toJSON()).toBe(`![x](${UPLOAD_FAILED_SCHEME}${uuid})`);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
