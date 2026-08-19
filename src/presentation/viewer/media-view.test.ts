import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VIEW_VERSION,
  type ArtifactView,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import { mediaViewFrom } from "./media-view.ts";

const FIXTURE_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"c".repeat(64)}`;

function mediaView(
  overrides: {
    readonly status?: ArtifactView["status"];
    readonly kind?: "media" | "document";
  } = {},
): ArtifactView {
  const id = artifactId.from("media-1");
  const kind = overrides.kind ?? "media";
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: "image/png",
      origin: "tool-output",
      encoding: "identity",
      byteLength: 8,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind,
    status: overrides.status ?? "complete",
    transformed: false,
    sourceByteLength: 8,
    decodedByteLength: 8,
    viewByteLength: 8,
    body:
      kind === "media"
        ? {
            kind: "media",
            format: "image/png",
            visual: "summary",
            storedByteLength: 8,
            hexPreview: "89 50 4e 47",
          }
        : {
            kind: "document",
            family: "text",
            text: "plain",
          },
  };
}

describe("mediaViewFrom", () => {
  test("projects a media summary artifact", () => {
    const model = mediaViewFrom(mediaView());
    expect(model).toMatchObject({
      format: "image/png",
      storedByteLength: 8,
      hexPreview: "89 50 4e 47",
      withheld: false,
    });
  });

  test("refuses non-media views", () => {
    expect(mediaViewFrom(mediaView({ kind: "document" }))).toBe(null);
  });

  test("notes redaction", () => {
    const model = mediaViewFrom(mediaView({ status: "redacted" }));
    expect(model?.statusNote).toContain("restricted");
  });
});
