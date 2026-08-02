import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_AVAILABILITIES,
  ARTIFACT_ENCODINGS,
  ARTIFACT_ORIGINS,
  ARTIFACT_SENSITIVITIES,
  type ArtifactRecord,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  isReadable,
  isTemporaryArtifactName,
  MAX_ARTIFACT_ID_LENGTH,
  parseArtifactRecord,
  temporaryArtifactName,
} from "./artifact.ts";

const HEX = "a".repeat(64);
const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${HEX}`;

function record(overrides: Partial<ArtifactRecord> = {}): Record<string, unknown> {
  return {
    artifactId: "artifact-1",
    digest: DIGEST,
    mediaType: "text/plain",
    encoding: "identity",
    byteLength: 12,
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    finalizedAt: "2026-07-31T12:00:01.000Z",
    availability: "available",
    ...overrides,
  };
}

describe("the artifact identity", () => {
  test("accepts a file-safe name", () => {
    expect(artifactId.parse("capture_01.log-2").ok).toBe(true);
  });

  test("refuses anything that could reach a path component", () => {
    // Narrower than every other Falryn identity on purpose: this one names an
    // in-flight file.
    for (const candidate of ["..", ".hidden", "a/b", "a\\b", "-leading", "", "a b"]) {
      expect(artifactId.parse(candidate).ok).toBe(false);
    }
  });

  test("refuses one longer than the declared bound", () => {
    expect(artifactId.parse("a".repeat(MAX_ARTIFACT_ID_LENGTH)).ok).toBe(true);
    expect(artifactId.parse("a".repeat(MAX_ARTIFACT_ID_LENGTH + 1)).ok).toBe(false);
  });

  test("reports a code and never the rejected value", () => {
    const rejected = artifactId.parse("../escape");
    expect(rejected.ok).toBe(false);
    expect(rejected.ok || rejected.error).toEqual({
      kind: "identity",
      code: "identifier-illegal-character",
      identity: "artifactId",
    });
  });
});

describe("the content digest", () => {
  test("carries the function that produced it", () => {
    expect(contentDigest.parse(DIGEST).ok).toBe(true);
    // Bare hexadecimal does not say what produced it, so it cannot be
    // re-verified by a build that learns a second algorithm.
    expect(contentDigest.parse(HEX).ok).toBe(false);
  });

  test("refuses the wrong length, uppercase, and a wrong algorithm", () => {
    expect(contentDigest.parse(`${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(63)}`).ok).toBe(false);
    expect(contentDigest.parse(`${CONTENT_DIGEST_ALGORITHM}:${"A".repeat(64)}`).ok).toBe(false);
    expect(contentDigest.parse(`sha-1:${"a".repeat(64)}`).ok).toBe(false);
  });
});

describe("a stored artifact row", () => {
  test("becomes a record when every field is what it claims", () => {
    const parsed = parseArtifactRecord(record());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.byteLength).toBe(12);
  });

  test("is refused when a closed union carries an unknown member", () => {
    for (const field of ["encoding", "origin", "sensitivity", "availability"]) {
      const parsed = parseArtifactRecord(record({ [field]: "invented" } as never));
      expect(parsed.ok).toBe(false);
      expect(parsed.ok || parsed.error.map((issue) => issue.path)).toContain(field);
    }
  });

  test("is refused when finalized time and availability disagree", () => {
    // Half-finalized is the state the schema and this parser both refuse: a row
    // that is `available` with no finalized time claims a moment that never
    // happened.
    expect(parseArtifactRecord(record({ finalizedAt: null } as never)).ok).toBe(false);
    expect(parseArtifactRecord(record({ availability: "reserved" } as never)).ok).toBe(false);
    expect(
      parseArtifactRecord(record({ availability: "reserved", finalizedAt: null } as never)).ok,
    ).toBe(true);
  });

  test("is refused when a media type is not one", () => {
    expect(parseArtifactRecord(record({ mediaType: "plain" } as never)).ok).toBe(false);
    expect(parseArtifactRecord(record({ mediaType: "text/" } as never)).ok).toBe(false);
  });

  test("reports a path and an issue code and never the rejected value", () => {
    const parsed = parseArtifactRecord(record({ digest: "not-a-digest" } as never));
    expect(parsed.ok).toBe(false);
    const issues = parsed.ok ? [] : parsed.error;
    expect(issues.map((issue) => issue.path)).toEqual(["digest"]);
    expect(JSON.stringify(issues)).not.toContain("not-a-digest");
  });
});

describe("readability", () => {
  test("is exactly the available state", () => {
    for (const availability of ARTIFACT_AVAILABILITIES) {
      const parsed = parseArtifactRecord(
        record({
          availability,
          finalizedAt: availability === "reserved" ? null : "2026-07-31T12:00:01.000Z",
        } as never),
      );
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && isReadable(parsed.value)).toBe(availability === "available");
    }
  });
});

describe("the temporary ingest naming convention", () => {
  test("round-trips an identity", () => {
    const name = temporaryArtifactName(artifactId.from("capture-1"));
    expect(name).toBe("artifact-capture-1.part");
    expect(isTemporaryArtifactName(name)).toBe(true);
  });

  test("claims only entries it could have written", () => {
    for (const name of ["ingest-1.part", "artifact-.part", "artifact-x", "artifact-../x.part"]) {
      expect(isTemporaryArtifactName(name)).toBe(false);
    }
  });
});

describe("the declared vocabularies", () => {
  test("stay closed and non-empty, because the schema constrains them", () => {
    for (const vocabulary of [
      ARTIFACT_SENSITIVITIES,
      ARTIFACT_ORIGINS,
      ARTIFACT_ENCODINGS,
      ARTIFACT_AVAILABILITIES,
    ]) {
      expect(vocabulary.length).toBeGreaterThan(0);
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });
});
