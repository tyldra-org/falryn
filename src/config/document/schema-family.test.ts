import { describe, expect, test } from "bun:test";

import {
  CONFIGURATION_MINIMUM_SCHEMA_VERSION,
  CONFIGURATION_SCHEMA_FAMILY,
  CONFIGURATION_SCHEMA_VERSION,
  evaluateSchemaVersion,
  MINIMUM_READER_FIELD,
  SCHEMA_VERSION_FIELD,
} from "./schema-family.ts";

describe("the falryn.configuration schema family", () => {
  test("names itself and starts at version one", () => {
    expect(CONFIGURATION_SCHEMA_FAMILY).toBe("falryn.configuration");
    expect(CONFIGURATION_SCHEMA_VERSION).toBe(1);
    expect(CONFIGURATION_MINIMUM_SCHEMA_VERSION).toBe(1);
  });

  test("accepts a document written by this build", () => {
    expect(evaluateSchemaVersion({ [SCHEMA_VERSION_FIELD]: 1 })).toEqual({
      kind: "current",
      schemaVersion: 1,
    });
  });

  test("requires a declared version rather than inferring one", () => {
    for (const document of [
      {},
      { schemaVersion: 0 },
      { schemaVersion: "1" },
      { schemaVersion: 1.5 },
    ]) {
      const verdict = evaluateSchemaVersion(document);
      expect(verdict.kind).toBe("rejected");
      if (verdict.kind === "rejected") {
        expect(verdict.issue.kind).toBe("invalid-schema-version");
      }
    }
  });

  test("tolerates a newer document that added only optional data", () => {
    expect(evaluateSchemaVersion({ [SCHEMA_VERSION_FIELD]: 4 })).toEqual({
      kind: "forward-compatible",
      schemaVersion: 4,
    });
  });

  test("rejects a newer document that requires a newer reader, and says which", () => {
    const verdict = evaluateSchemaVersion({
      [SCHEMA_VERSION_FIELD]: 4,
      [MINIMUM_READER_FIELD]: 3,
    });
    expect(verdict).toEqual({
      kind: "rejected",
      issue: {
        kind: "unsupported-schema-version",
        severity: "error",
        path: MINIMUM_READER_FIELD,
        observedSchemaVersion: 4,
        minimumCompatibleVersion: 3,
        readerSchemaVersion: 1,
      },
    });
  });

  test("accepts a newer document whose required floor this build meets", () => {
    expect(evaluateSchemaVersion({ [SCHEMA_VERSION_FIELD]: 4, [MINIMUM_READER_FIELD]: 1 })).toEqual(
      { kind: "forward-compatible", schemaVersion: 4 },
    );
  });

  test("rejects a document older than the oldest version this build reads", () => {
    const verdict = evaluateSchemaVersion(
      { [SCHEMA_VERSION_FIELD]: 2 },
      { readerSchemaVersion: 5, minimumSupportedVersion: 3 },
    );
    expect(verdict).toEqual({
      kind: "rejected",
      issue: {
        kind: "retired-schema-version",
        severity: "error",
        path: SCHEMA_VERSION_FIELD,
        observedSchemaVersion: 2,
        minimumSupportedVersion: 3,
      },
    });
  });

  test("rejects a malformed reader floor rather than ignoring it", () => {
    const verdict = evaluateSchemaVersion({
      [SCHEMA_VERSION_FIELD]: 1,
      [MINIMUM_READER_FIELD]: "two",
    });
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") {
      expect(verdict.issue).toEqual({
        kind: "invalid-schema-version",
        severity: "error",
        path: MINIMUM_READER_FIELD,
      });
    }
  });
});
