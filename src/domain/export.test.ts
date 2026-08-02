import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  artifactMemberName,
  EXPORT_FORMAT,
  EXPORT_OMISSION_REASONS,
  EXPORT_SCHEMA_VERSION,
  type ExportManifest,
  exportName,
  isCompatible,
  MAX_EXPORT_NAME_LENGTH,
  MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
  parseExportManifest,
  RECORDS_MEMBER,
  selectedSessions,
  summarize,
} from "./export.ts";
import { sessionId } from "./identity.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    minimumCompatibleSchemaVersion: MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
    createdAt: "2026-07-31T12:00:00.000Z",
    createdBy: "falryn/0.0.0",
    selection: { kind: "sessions", sessions: 1, includesSensitive: false },
    counts: {
      sessions: 1,
      turns: 2,
      modelAttempts: 0,
      invocations: 1,
      events: 4,
      artifacts: 1,
    },
    members: [
      { name: RECORDS_MEMBER, kind: "records", byteLength: 128, digest: DIGEST },
      {
        name: artifactMemberName(DIGEST as never),
        kind: "artifact",
        byteLength: 9,
        digest: DIGEST,
      },
    ],
    omissions: [{ artifactId: "a2", reason: "restricted-sensitivity" }],
    ...overrides,
  };
}

describe("the export name", () => {
  test("accepts a file-safe name and refuses anything that reaches a path", () => {
    expect(exportName.parse("session-export.2026-07-31").ok).toBe(true);
    for (const candidate of ["..", ".hidden", "a/b", "a\\b", "-leading", "", "a b"]) {
      expect(exportName.parse(candidate).ok).toBe(false);
    }
  });

  test("is bounded, because it becomes a file name", () => {
    expect(exportName.parse("a".repeat(MAX_EXPORT_NAME_LENGTH)).ok).toBe(true);
    expect(exportName.parse("a".repeat(MAX_EXPORT_NAME_LENGTH + 1)).ok).toBe(false);
  });

  test("reports a code and never the rejected value", () => {
    const rejected = exportName.parse("../escape");
    expect(rejected.ok || rejected.error).toEqual({
      kind: "identity",
      code: "identifier-illegal-character",
      identity: "exportName",
    });
  });
});

describe("a manifest read back out of a package", () => {
  test("becomes a manifest when every field is what it claims", () => {
    const parsed = parseExportManifest(manifest());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.members).toHaveLength(2);
  });

  test("is refused when the file is not a Falryn export at all", () => {
    // The format literal is checked by the same parser that refuses a
    // malformed manifest, so neither answer carries the rejected bytes.
    const parsed = parseExportManifest(manifest({ format: "zip" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok || parsed.error.map((issue) => issue.path)).toContain("format");
  });

  test("is refused when a member declares a digest that is not one", () => {
    const parsed = parseExportManifest(
      manifest({
        members: [{ name: RECORDS_MEMBER, kind: "records", byteLength: 1, digest: "deadbeef" }],
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  test("is refused when an omission reason is invented", () => {
    const parsed = parseExportManifest(
      manifest({ omissions: [{ artifactId: "a2", reason: "because" }] }),
    );
    expect(parsed.ok).toBe(false);
  });

  test("reports a path and an issue code and never the rejected value", () => {
    const parsed = parseExportManifest(manifest({ createdAt: "yesterday-ish" }));
    const issues = parsed.ok ? [] : parsed.error;
    expect(issues.map((issue) => issue.path)).toEqual(["createdAt"]);
    expect(JSON.stringify(issues)).not.toContain("yesterday-ish");
  });

  test("accepts a package with no members and no omissions", () => {
    // An export of a database with no artifacts is a real package, not a
    // malformed one — and until a producer lands it is the only kind.
    const parsed = parseExportManifest(manifest({ members: [], omissions: [] }));
    expect(parsed.ok).toBe(true);
  });
});

describe("compatibility", () => {
  function withVersions(schemaVersion: number, minimum: number): ExportManifest {
    const parsed = parseExportManifest(
      manifest({ schemaVersion, minimumCompatibleSchemaVersion: minimum }),
    );
    if (!parsed.ok) {
      throw new Error("expected a manifest");
    }
    return parsed.value;
  }

  test("is decided by what the package requires, not by what it is", () => {
    // A package newer than this reader is still readable when it says so.
    expect(isCompatible(withVersions(7, 1), EXPORT_SCHEMA_VERSION)).toBe(true);
    expect(isCompatible(withVersions(7, 7), EXPORT_SCHEMA_VERSION)).toBe(false);
  });

  test("accepts a package this build wrote", () => {
    expect(
      isCompatible(
        withVersions(EXPORT_SCHEMA_VERSION, MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION),
        EXPORT_SCHEMA_VERSION,
      ),
    ).toBe(true);
  });
});

describe("the selection", () => {
  test("summarizes without carrying the sessions it named", () => {
    const summary = summarize(
      { kind: "sessions", sessionIds: [sessionId.from("s1")], includeSensitive: true },
      1,
    );
    expect(summary).toEqual({ kind: "sessions", sessions: 1, includesSensitive: true });
  });

  test("names no sessions for a range, which is what a range means", () => {
    expect(
      selectedSessions({
        kind: "range",
        startedAfter: null,
        startedBefore: null,
        includeSensitive: false,
      }),
    ).toEqual([]);
  });
});

describe("the declared vocabularies", () => {
  test("cover every reason an artifact can be left out", () => {
    expect([...EXPORT_OMISSION_REASONS].sort()).toEqual([
      "bytes-missing",
      "bytes-quarantined",
      "restricted-sensitivity",
      "sensitive-not-selected",
    ]);
  });
});
