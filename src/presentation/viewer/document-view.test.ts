import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VIEW_VERSION,
  type ArtifactView,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import { documentViewFrom } from "./document-view.ts";

const FIXTURE_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"c".repeat(64)}`;

function documentView(
  overrides: {
    readonly status?: ArtifactView["status"];
    readonly transformed?: boolean;
    readonly kind?: "document" | "code";
  } = {},
): ArtifactView {
  const id = artifactId.from("doc-1");
  const kind = overrides.kind ?? "document";
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: "text/markdown",
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
    transformed: overrides.transformed ?? false,
    sourceByteLength: 8,
    decodedByteLength: 8,
    viewByteLength: 8,
    body:
      kind === "document"
        ? {
            kind: "document",
            family: "markdown",
            text: "# Title\n",
          }
        : {
            kind: "code",
            language: "typescript",
            lineCount: 1,
            text: "x",
          },
  };
}

describe("documentViewFrom", () => {
  test("projects a document artifact", () => {
    const model = documentViewFrom(documentView());
    expect(model).toMatchObject({
      family: "markdown",
      text: "# Title\n",
      withheld: false,
    });
  });

  test("refuses non-document views", () => {
    expect(documentViewFrom(documentView({ kind: "code" }))).toBe(null);
  });

  test("notes truncation", () => {
    const model = documentViewFrom(documentView({ status: "truncated" }));
    expect(model?.statusNote).toContain("bounded prefix");
  });
});
