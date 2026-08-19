import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_VIEW_VERSION,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  DEFAULT_ARTIFACT_VIEW_LIMITS,
  projectArtifactView,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import { diffTextForHunk, diffViewFrom, hunkCountOfDiffText } from "./diff-view.ts";

const LIMITS = DEFAULT_ARTIFACT_VIEW_LIMITS;

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"c".repeat(64)}`;

function diffView(text: string) {
  const id = artifactId.from("diff-1");
  return projectArtifactView({
    record: {
      artifactId: id,
      digest: DIGEST as never,
      mediaType: "text/x-diff",
      origin: "tool-output",
      encoding: "identity",
      byteLength: text.length,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    bytes: new TextEncoder().encode(text),
    transformed: false,
    truncated: false,
    stale: false,
    limits: LIMITS,
  });
}

describe("diffViewFrom", () => {
  test("projects unified diff bodies", () => {
    const text = "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    const model = diffViewFrom(diffView(text));
    expect(model).toMatchObject({
      mode: "unified",
      hunkCount: 1,
      text,
      withheld: false,
    });
  });

  test("refuses non-diff views", () => {
    const id = artifactId.from("x");
    expect(
      diffViewFrom({
        schemaVersion: ARTIFACT_VIEW_VERSION,
        artifactId: id,
        record: diffView("").record,
        kind: "code",
        status: "complete",
        transformed: false,
        sourceByteLength: 0,
        decodedByteLength: 0,
        viewByteLength: 0,
        body: { kind: "code", language: "text", lineCount: 0, text: "" },
      }),
    ).toBe(null);
  });
});

describe("hunk navigation projection", () => {
  const TWO_HUNKS =
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+A\n@@ -3,1 +3,1 @@\n-b\n+B\n";

  test("counts hunks in text", () => {
    expect(hunkCountOfDiffText(TWO_HUNKS)).toBe(2);
  });

  test("slices to the selected hunk", () => {
    const first = diffTextForHunk(TWO_HUNKS, 0);
    expect(first).toContain("-a\n+A");
    expect(first).not.toContain("-b\n+B");

    const second = diffTextForHunk(TWO_HUNKS, 1);
    expect(second).toContain("-b\n+B");
    expect(second).not.toContain("-a\n+A");
  });
});
