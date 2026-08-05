export type ArtifactKind = "text" | "attachment";

export type ArtifactPreview =
  | "markdown"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "download";

export interface ArtifactInfo {
  kind: ArtifactKind;
  contentType: string;
  editable: boolean;
  preview: ArtifactPreview;
}

const TEXT_ARTIFACT_EXTENSIONS: Record<
  string,
  { contentType: string; preview: ArtifactPreview }
> = {
  ".md": { contentType: "text/markdown; charset=utf-8", preview: "markdown" },
  ".markdown": { contentType: "text/markdown; charset=utf-8", preview: "markdown" },
  ".mdown": { contentType: "text/markdown; charset=utf-8", preview: "markdown" },
  ".mkdn": { contentType: "text/markdown; charset=utf-8", preview: "markdown" },
  ".txt": { contentType: "text/plain; charset=utf-8", preview: "text" },
  ".log": { contentType: "text/plain; charset=utf-8", preview: "text" },
  ".csv": { contentType: "text/csv; charset=utf-8", preview: "text" },
  ".tsv": { contentType: "text/tab-separated-values; charset=utf-8", preview: "text" },
  ".html": { contentType: "text/html; charset=utf-8", preview: "text" },
  ".htm": { contentType: "text/html; charset=utf-8", preview: "text" },
  ".css": { contentType: "text/css; charset=utf-8", preview: "text" },
  ".js": { contentType: "text/javascript; charset=utf-8", preview: "text" },
  ".jsx": { contentType: "text/javascript; charset=utf-8", preview: "text" },
  ".ts": { contentType: "text/typescript; charset=utf-8", preview: "text" },
  ".tsx": { contentType: "text/typescript; charset=utf-8", preview: "text" },
  ".json": { contentType: "application/json; charset=utf-8", preview: "text" },
  ".yml": { contentType: "application/yaml; charset=utf-8", preview: "text" },
  ".yaml": { contentType: "application/yaml; charset=utf-8", preview: "text" },
  ".xml": { contentType: "application/xml; charset=utf-8", preview: "text" },
  ".toml": { contentType: "application/toml; charset=utf-8", preview: "text" },
  ".ini": { contentType: "text/plain; charset=utf-8", preview: "text" },
  ".sh": { contentType: "text/x-shellscript; charset=utf-8", preview: "text" },
  ".py": { contentType: "text/x-python; charset=utf-8", preview: "text" },
  ".rb": { contentType: "text/x-ruby; charset=utf-8", preview: "text" },
  ".go": { contentType: "text/x-go; charset=utf-8", preview: "text" },
  ".rs": { contentType: "text/x-rust; charset=utf-8", preview: "text" },
  ".java": { contentType: "text/x-java-source; charset=utf-8", preview: "text" },
  ".c": { contentType: "text/x-c; charset=utf-8", preview: "text" },
  ".cpp": { contentType: "text/x-c++; charset=utf-8", preview: "text" },
  ".h": { contentType: "text/x-c; charset=utf-8", preview: "text" },
  ".hpp": { contentType: "text/x-c++; charset=utf-8", preview: "text" },
};

const ATTACHMENT_ARTIFACT_EXTENSIONS: Record<
  string,
  { contentType: string; preview: ArtifactPreview }
> = {
  ".png": { contentType: "image/png", preview: "image" },
  ".jpg": { contentType: "image/jpeg", preview: "image" },
  ".jpeg": { contentType: "image/jpeg", preview: "image" },
  ".gif": { contentType: "image/gif", preview: "image" },
  ".webp": { contentType: "image/webp", preview: "image" },
  ".avif": { contentType: "image/avif", preview: "image" },
  ".apng": { contentType: "image/apng", preview: "image" },
  ".svg": { contentType: "application/octet-stream", preview: "download" },
  ".mp3": { contentType: "audio/mpeg", preview: "audio" },
  ".wav": { contentType: "audio/wav", preview: "audio" },
  ".ogg": { contentType: "audio/ogg", preview: "audio" },
  ".flac": { contentType: "audio/flac", preview: "audio" },
  ".m4a": { contentType: "audio/mp4", preview: "audio" },
  ".aac": { contentType: "audio/aac", preview: "audio" },
  ".mp4": { contentType: "video/mp4", preview: "video" },
  ".webm": { contentType: "video/webm", preview: "video" },
  ".mov": { contentType: "video/quicktime", preview: "video" },
  ".m4v": { contentType: "video/x-m4v", preview: "video" },
  ".pdf": { contentType: "application/pdf", preview: "pdf" },
  ".zip": { contentType: "application/zip", preview: "download" },
  ".gz": { contentType: "application/gzip", preview: "download" },
  ".tgz": { contentType: "application/gzip", preview: "download" },
  ".tar": { contentType: "application/x-tar", preview: "download" },
};

function artifactExtension(relPath: string): string {
  const leaf = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = leaf.lastIndexOf(".");
  return dot <= 0 ? "" : leaf.slice(dot).toLowerCase();
}

export function classifyArtifactPath(relPath: string): ArtifactInfo {
  const extension = artifactExtension(relPath);
  const text = TEXT_ARTIFACT_EXTENSIONS[extension];
  if (text) {
    return {
      kind: "text",
      contentType: text.contentType,
      editable: true,
      preview: text.preview,
    };
  }

  const attachment = ATTACHMENT_ARTIFACT_EXTENSIONS[extension];
  if (attachment) {
    return {
      kind: "attachment",
      contentType: attachment.contentType,
      editable: false,
      preview: attachment.preview,
    };
  }

  return {
    kind: "attachment",
    contentType: "application/octet-stream",
    editable: false,
    preview: "download",
  };
}
