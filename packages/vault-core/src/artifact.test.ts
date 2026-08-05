import { describe, expect, it } from "vitest";

import { classifyArtifactPath } from "./artifact.js";

describe("classifyArtifactPath", () => {
  it.each(["photo.png", "nested/PHOTO.JPEG", "still.avif", "anim.apng"])(
    "classifies %s as an image without Node path helpers",
    (path) => {
      expect(classifyArtifactPath(path)).toMatchObject({
        kind: "attachment",
        editable: false,
        preview: "image",
      });
    },
  );

  it.each([".env", "folder/.hidden", "extensionless", "folder/name."])(
    "keeps %s as an unknown download",
    (path) => {
      expect(classifyArtifactPath(path)).toEqual({
        kind: "attachment",
        contentType: "application/octet-stream",
        editable: false,
        preview: "download",
      });
    },
  );
});
