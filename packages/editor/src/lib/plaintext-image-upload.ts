import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type * as Y from 'yjs';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const PENDING_UPLOAD_SCHEME = 'pending-upload://';
export const UPLOAD_FAILED_SCHEME = 'upload-failed://';
export const PLAINTEXT_IMAGE_SWAP_ORIGIN = 'plaintext-image-swap';

interface PlaintextImageUploadOptions {
  uploadFile: (file: File) => Promise<{ path: string }>;
  ytext: Y.Text;
  ydoc: Y.Doc;
  onUploadStart?: () => void;
  onUploadEnd?: () => void;
  onError?: (err: unknown, file: File) => void;
}

function extractImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const seen = new Set<File>();
  const files: File[] = [];

  for (const file of Array.from(data.files)) {
    if (ALLOWED_IMAGE_TYPES.has(file.type) && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }

  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    if (!ALLOWED_IMAGE_TYPES.has(item.type)) continue;
    const file = item.getAsFile();
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }

  return files;
}

function defaultAltFromFilename(name: string): string {
  const base = name.split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

function mintUploadId(): string {
  return crypto.randomUUID();
}

function insertSentinelAtCursor(
  view: EditorView,
  alt: string,
  uuid: string,
): void {
  const markdown = `![${alt}](${PENDING_UPLOAD_SCHEME}${uuid})`;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
    scrollIntoView: true,
  });
}

export function swapSentinelInYText(
  ytext: Y.Text,
  ydoc: Y.Doc,
  needle: string,
  replacement: string,
): boolean {
  const haystack = ytext.toJSON();
  const index = haystack.indexOf(needle);
  if (index < 0) return false;
  ydoc.transact(() => {
    ytext.delete(index, needle.length);
    ytext.insert(index, replacement);
  }, PLAINTEXT_IMAGE_SWAP_ORIGIN);
  return true;
}

async function handleOneUpload(
  file: File,
  uuid: string,
  options: PlaintextImageUploadOptions,
): Promise<void> {
  const sentinelUrl = `${PENDING_UPLOAD_SCHEME}${uuid}`;
  options.onUploadStart?.();
  try {
    const { path } = await options.uploadFile(file);
    swapSentinelInYText(options.ytext, options.ydoc, sentinelUrl, path);
  } catch (err) {
    swapSentinelInYText(
      options.ytext,
      options.ydoc,
      sentinelUrl,
      `${UPLOAD_FAILED_SCHEME}${uuid}`,
    );
    options.onError?.(err, file);
  } finally {
    options.onUploadEnd?.();
  }
}

export function plaintextImageUpload(
  options: PlaintextImageUploadOptions,
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!view.state.facet(EditorView.editable)) return false;
      const files = extractImageFiles(event.clipboardData);
      if (files.length === 0) return false;

      event.preventDefault();
      for (const file of files) {
        const uuid = mintUploadId();
        insertSentinelAtCursor(view, defaultAltFromFilename(file.name), uuid);
        void handleOneUpload(file, uuid, options);
      }
      return true;
    },
    drop(event, view) {
      if (!view.state.facet(EditorView.editable)) return false;
      const files = extractImageFiles(event.dataTransfer);
      if (files.length === 0) return false;

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      event.preventDefault();
      if (pos !== null) {
        view.dispatch({ selection: { anchor: pos } });
      }
      for (const file of files) {
        const uuid = mintUploadId();
        insertSentinelAtCursor(view, defaultAltFromFilename(file.name), uuid);
        void handleOneUpload(file, uuid, options);
      }
      return true;
    },
  });
}
