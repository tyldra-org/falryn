import { describe, expect, test } from "bun:test";

import { type ArtifactRecord, artifactId, CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  ARTIFACT_VIEW_KINDS,
  ARTIFACT_VIEW_VERSION,
  artifactViewLimits,
  artifactViewStatus,
  DEFAULT_ARTIFACT_VIEW_LIMITS,
  encodingNeedsDecode,
  maximumDecodedBytes,
  parseArtifactViewRequest,
  projectArtifactView,
  selectArtifactViewKind,
} from "./artifact-view.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const CREATED = "2026-08-18T12:00:00.000Z";
const FINALIZED = "2026-08-18T12:00:01.000Z";

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: artifactId.from("view-1"),
    digest: DIGEST as ArtifactRecord["digest"],
    mediaType: "text/plain",
    encoding: "identity",
    byteLength: 4,
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    createdAt: CREATED as ArtifactRecord["createdAt"],
    finalizedAt: FINALIZED as ArtifactRecord["finalizedAt"],
    availability: "available",
    ...overrides,
  };
}

const LIMITS = DEFAULT_ARTIFACT_VIEW_LIMITS;

describe("artifact view selection", () => {
  test("names every kind the issue asked for", () => {
    expect([...ARTIFACT_VIEW_KINDS]).toEqual(["code", "diff", "document", "media", "diagnostic"]);
  });

  test("selects from media type and origin, never from bytes", () => {
    expect(selectArtifactViewKind("application/json", "tool-output")).toBe("code");
    expect(selectArtifactViewKind("text/x-diff", "tool-output")).toBe("diff");
    expect(selectArtifactViewKind("text/markdown", "user-supplied")).toBe("document");
    expect(selectArtifactViewKind("image/png", "capture")).toBe("media");
    expect(selectArtifactViewKind("application/pdf", "tool-output")).toBe("media");
    expect(selectArtifactViewKind("text/plain", "diagnostic")).toBe("diagnostic");
    expect(selectArtifactViewKind("application/sarif+json", "tool-output")).toBe("diagnostic");
    expect(selectArtifactViewKind("application/octet-stream", "tool-output")).toBe("media");
  });

  test("does not treat a diagnostic JSON dump as a code viewer", () => {
    expect(selectArtifactViewKind("application/json", "diagnostic")).toBe("diagnostic");
  });
});

describe("artifact view status", () => {
  test("withholds missing, quarantined, and restricted before byte states", () => {
    expect(
      artifactViewStatus({
        availability: "missing",
        sensitivity: "user-content",
        truncated: true,
        transformed: true,
        stale: true,
      }),
    ).toBe("missing");
    expect(
      artifactViewStatus({
        availability: "quarantined",
        sensitivity: "user-content",
        truncated: false,
        transformed: false,
        stale: false,
      }),
    ).toBe("quarantined");
    expect(
      artifactViewStatus({
        availability: "available",
        sensitivity: "restricted",
        truncated: false,
        transformed: false,
        stale: false,
      }),
    ).toBe("redacted");
  });

  test("prefers truncated over transformed so a clipped gzip is not complete", () => {
    expect(
      artifactViewStatus({
        availability: "available",
        sensitivity: "user-content",
        truncated: true,
        transformed: true,
        stale: false,
      }),
    ).toBe("truncated");
    expect(
      artifactViewStatus({
        availability: "available",
        sensitivity: "user-content",
        truncated: false,
        transformed: true,
        stale: false,
      }),
    ).toBe("transformed");
  });
});

describe("an artifact view request", () => {
  test("parses an identity and default limits", () => {
    const parsed = parseArtifactViewRequest({ artifactId: "view-1" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.artifactId).toBe(artifactId.from("view-1"));
    expect(parsed.value.limits.maxViewBytes).toBe(64 * 1024);
  });

  test("refuses an unknown field without echoing it", () => {
    const parsed = parseArtifactViewRequest({ artifactId: "view-1", execute: true });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("execute");
  });

  test("refuses a view budget above the hard ceiling", () => {
    const parsed = artifactViewLimits({ maxViewBytes: 9 * 1024 * 1024 });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok || parsed.error.field).toBe("maxViewBytes");
  });
});

describe("the artifact view projection", () => {
  test("projects code with a language from the media type", () => {
    const view = projectArtifactView({
      record: record({ mediaType: "application/typescript", byteLength: 21 }),
      bytes: new TextEncoder().encode("export const n = 1;\n"),
      transformed: false,
      truncated: false,
      stale: false,
      limits: LIMITS,
    });
    expect(view.schemaVersion).toBe(ARTIFACT_VIEW_VERSION);
    expect(view.kind).toBe("code");
    expect(view.status).toBe("complete");
    expect(view.body).toMatchObject({ kind: "code", language: "typescript", lineCount: 1 });
  });

  test("counts unified diff hunks without claiming a side-by-side layout", () => {
    const text = "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    const view = projectArtifactView({
      record: record({ mediaType: "text/x-diff", byteLength: text.length }),
      bytes: new TextEncoder().encode(text),
      transformed: false,
      truncated: false,
      stale: false,
      limits: LIMITS,
    });
    expect(view.kind).toBe("diff");
    expect(view.body).toMatchObject({ kind: "diff", mode: "unified", hunkCount: 1 });
  });

  test("marks markdown as a document, not as code", () => {
    const view = projectArtifactView({
      record: record({ mediaType: "text/markdown", byteLength: 8 }),
      bytes: new TextEncoder().encode("# Title\n"),
      transformed: false,
      truncated: false,
      stale: false,
      limits: LIMITS,
    });
    expect(view.body).toMatchObject({ kind: "document", family: "markdown" });
  });

  test("summarizes media without decoding pixels", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = projectArtifactView({
      record: record({ mediaType: "image/png", byteLength: bytes.byteLength }),
      bytes,
      transformed: false,
      truncated: false,
      stale: false,
      limits: LIMITS,
    });
    expect(view.body).toMatchObject({
      kind: "media",
      format: "image/png",
      visual: "summary",
    });
    expect(view.body?.kind === "media" && view.body.hexPreview.startsWith("89 50 4e 47")).toBe(
      true,
    );
  });

  test("parses a diagnostic JSON body without treating metadata as payload", () => {
    const text = JSON.stringify({
      level: "error",
      code: "queue-full",
      subsystem: "scheduler",
      message: "bounded",
    });
    const view = projectArtifactView({
      record: record({
        mediaType: "application/json",
        origin: "diagnostic",
        byteLength: text.length,
      }),
      bytes: new TextEncoder().encode(text),
      transformed: false,
      truncated: false,
      stale: false,
      limits: LIMITS,
    });
    expect(view.body).toMatchObject({
      kind: "diagnostic",
      parsed: true,
      level: "error",
      code: "queue-full",
      subsystem: "scheduler",
    });
  });

  test("withholds restricted bytes even when they were supplied", () => {
    const view = projectArtifactView({
      record: record({ sensitivity: "restricted" }),
      bytes: new TextEncoder().encode("secret"),
      transformed: false,
      truncated: false,
      stale: false,
      limits: LIMITS,
    });
    expect(view.status).toBe("redacted");
    expect(view.body).toBeNull();
  });

  test("clips the view body at the declared budget", () => {
    const limits = artifactViewLimits({ maxViewBytes: 4 });
    expect(limits.ok).toBe(true);
    if (!limits.ok) {
      return;
    }
    const view = projectArtifactView({
      record: record({ byteLength: 12 }),
      bytes: new TextEncoder().encode("hello world!"),
      transformed: false,
      truncated: true,
      stale: false,
      limits: limits.value,
    });
    expect(view.status).toBe("truncated");
    expect(view.body?.kind === "document" && view.body.text).toBe("hell");
  });
});

describe("gzip decode bounds", () => {
  test("caps decoded bytes by both the absolute ceiling and the ratio", () => {
    const limits = artifactViewLimits({ maxDecodedBytes: 1000, maxDecompressionRatio: 2 });
    expect(limits.ok).toBe(true);
    if (!limits.ok) {
      return;
    }
    expect(maximumDecodedBytes(10, limits.value)).toBe(20);
    expect(maximumDecodedBytes(800, limits.value)).toBe(1000);
  });

  test("only gzip needs a decode this owner applies", () => {
    expect(encodingNeedsDecode("gzip")).toBe(true);
    expect(encodingNeedsDecode("identity")).toBe(false);
  });
});
