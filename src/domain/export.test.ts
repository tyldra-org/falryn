import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  artifactMemberName,
  EXPORT_FORMAT,
  EXPORT_OMISSION_REASONS,
  EXPORT_SCHEMA_FAMILIES,
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
import { RUNTIME_EVENT_SCHEMA_FAMILY, RUNTIME_EVENT_SCHEMA_VERSION } from "./limits.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    minimumCompatibleSchemaVersion: MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
    schemaFamilies: [
      { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION },
    ],
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

describe("the schema families a manifest declares", () => {
  function refusal(schemaFamilies: unknown): readonly string[] {
    const parsed = parseExportManifest(manifest({ schemaFamilies }));
    expect(parsed.ok).toBe(false);
    return parsed.ok ? [] : parsed.error.map((issue) => issue.path);
  }

  test("round-trips the family list a package carries", () => {
    const parsed = parseExportManifest(manifest());
    expect(parsed.ok && parsed.value.schemaFamilies).toEqual([
      { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION },
    ]);
  });

  test("is refused when the field is absent, because a package always carries records", () => {
    const absent = manifest();
    delete absent.schemaFamilies;
    const parsed = parseExportManifest(absent);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok || parsed.error.map((issue) => issue.path)).toContain("schemaFamilies");
  });

  test("is refused when the list is empty", () => {
    expect(refusal([])).toContain("schemaFamilies");
  });

  test("is refused when the family is outside the accepted vocabulary", () => {
    // An unknown family is refused here rather than negotiated; a reader that
    // can open a family it does not have is a different outcome entirely.
    expect(refusal([{ family: "falryn.invented", schemaVersion: 1 }])).toContain(
      "schemaFamilies.0.family",
    );
  });

  test("is refused when one family is declared twice", () => {
    const twice = [
      { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: 1 },
      { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: 2 },
    ];
    expect(refusal(twice)).toContain("schemaFamilies");
  });

  test("is refused when a version is not a positive integer", () => {
    for (const schemaVersion of [0, -1, 1.5]) {
      expect(refusal([{ family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion }])).toContain(
        "schemaFamilies.0.schemaVersion",
      );
    }
  });

  test("is refused when an entry is not an object", () => {
    expect(refusal([RUNTIME_EVENT_SCHEMA_FAMILY])).toContain("schemaFamilies.0");
  });

  test("reports a path and a code and never the rejected value", () => {
    const parsed = parseExportManifest(
      manifest({ schemaFamilies: [{ family: "falryn.secret-looking-name", schemaVersion: 1 }] }),
    );
    const issues = parsed.ok ? [] : parsed.error;
    expect(issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(issues)).not.toContain("secret-looking-name");
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

  test("name the runtime-event family from its own source owner", () => {
    // Imported rather than restated: a second literal in the export path is a
    // copy that can drift from the one `limits.ts` owns.
    expect(EXPORT_SCHEMA_FAMILIES).toEqual([RUNTIME_EVENT_SCHEMA_FAMILY]);
  });
});
