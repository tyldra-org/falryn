import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VIEW_VERSION,
  type ArtifactView,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import { codeViewFrom } from "./code-view.ts";

const FIXTURE_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"c".repeat(64)}`;

function codeView(
  overrides: {
    readonly status?: ArtifactView["status"];
    readonly transformed?: boolean;
    readonly kind?: "code" | "document";
  } = {},
): ArtifactView {
  const id = artifactId.from("code-1");
  const kind = overrides.kind ?? "code";
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: "text/typescript",
      origin: "tool-output",
      encoding: "identity",
      byteLength: 12,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind,
    status: overrides.status ?? "complete",
    transformed: overrides.transformed ?? false,
    sourceByteLength: 12,
    decodedByteLength: 12,
    viewByteLength: 12,
    body:
      kind === "code"
        ? {
            kind: "code",
            language: "typescript",
            lineCount: 1,
            text: "export const x = 1;",
          }
        : {
            kind: "document",
            family: "text",
            text: "hello",
          },
  };
}

describe("codeViewFrom", () => {
  test("projects a complete code artifact into render-safe data", () => {
    expect(codeViewFrom(codeView())).toEqual({
      artifactId: "code-1",
      language: "typescript",
      status: "complete",
      statusNote: null,
      lineCount: 1,
      text: "export const x = 1;",
      withheld: false,
    });
  });

  test("returns null for non-code views", () => {
    expect(codeViewFrom(codeView({ kind: "document" }))).toBe(null);
  });

  test("names truncation and gzip expansion in the status note", () => {
    expect(codeViewFrom(codeView({ status: "truncated" }))?.statusNote).toContain("bounded prefix");
    expect(codeViewFrom(codeView({ status: "complete", transformed: true }))?.statusNote).toContain(
      "gzip",
    );
  });
});
