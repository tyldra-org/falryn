import { describe, expect, test } from "bun:test";

import {
  assignConfigurationValue,
  createEmptyConfigurationDocument,
  serializeConfigurationDocument,
} from "./document.ts";
import { SCHEMA_VERSION_FIELD } from "./schema-family.ts";

describe("configuration document", () => {
  test("serializes schema version fields first", () => {
    const text = serializeConfigurationDocument({
      diagnostics: { level: "debug" },
      [SCHEMA_VERSION_FIELD]: 1,
      minimumReaderSchemaVersion: 1,
    });
    expect(text.indexOf(SCHEMA_VERSION_FIELD)).toBeLessThan(text.indexOf("diagnostics"));
    expect(text.endsWith("\n")).toBe(true);
  });

  test("assigns nested key paths", () => {
    const document = assignConfigurationValue(
      createEmptyConfigurationDocument(),
      "diagnostics.level",
      "warn",
    );
    expect(document).toEqual({
      schemaVersion: 1,
      minimumReaderSchemaVersion: 1,
      diagnostics: { level: "warn" },
    });
  });

  test("round-trips assigned values through serialize", () => {
    const document = assignConfigurationValue(
      createEmptyConfigurationDocument(),
      "diagnostics.level",
      "error",
    );
    const text = serializeConfigurationDocument(document);
    expect(text).toContain('"level": "error"');
  });
});
