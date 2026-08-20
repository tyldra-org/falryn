import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VIEW_VERSION,
  type ArtifactView,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import { diagnosticViewFrom } from "./diagnostic-view.ts";

const FIXTURE_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"d".repeat(64)}`;

function diagnosticView(
  overrides: {
    readonly status?: ArtifactView["status"];
    readonly kind?: "diagnostic" | "code";
  } = {},
): ArtifactView {
  const id = artifactId.from("diag-1");
  const kind = overrides.kind ?? "diagnostic";
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: "application/vnd.falryn.diagnostic+json",
      origin: "diagnostic",
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
      kind === "diagnostic"
        ? {
            kind: "diagnostic",
            parsed: true,
            level: "error",
            code: "provider-unreachable",
            subsystem: "provider",
            text: '{"level":"error"}',
          }
        : {
            kind: "code",
            language: "typescript",
            lineCount: 1,
            text: "x",
          },
  };
}

describe("diagnosticViewFrom", () => {
  test("projects parsed diagnostic facts", () => {
    const model = diagnosticViewFrom(diagnosticView());
    expect(model).toMatchObject({
      parsed: true,
      level: "error",
      code: "provider-unreachable",
      subsystem: "provider",
      withheld: false,
    });
  });

  test("refuses non-diagnostic views", () => {
    expect(diagnosticViewFrom(diagnosticView({ kind: "code" }))).toBe(null);
  });

  test("notes truncation", () => {
    const model = diagnosticViewFrom(diagnosticView({ status: "truncated" }));
    expect(model?.statusNote).toContain("bounded prefix");
  });
});
