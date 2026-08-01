import { describe, expect, test } from "bun:test";

import {
  blockingIssues,
  CONFIGURATION_SOURCE_KINDS,
  type ConfigurationIssue,
  configurationKeyPath,
  isBlockingIssue,
  isConfigurationScope,
  isUnlimited,
  MAX_CONFIGURATION_KEY_PATH_LENGTH,
  parseConfigurationKeyPath,
  scopeForSourceKind,
  UNLIMITED,
} from "./configuration.ts";

describe("key paths", () => {
  test("accepts a dotted path of camelCase segments", () => {
    for (const path of ["data.retention", "data.roots.temporaryIngest", "diagnostics.level"]) {
      const parsed = parseConfigurationKeyPath(path);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value as string).toBe(path);
      }
    }
  });

  test("rejects a bare group, which would collide across owners", () => {
    const parsed = parseConfigurationKeyPath("level");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("key-path-malformed");
    }
  });

  test("rejects malformed spellings", () => {
    for (const path of [
      "Data.retention",
      "data..retention",
      "data.retention.",
      "data retention",
      "9data.x",
    ]) {
      expect(parseConfigurationKeyPath(path).ok).toBe(false);
    }
  });

  test("rejects an empty, oversized, or non-string path", () => {
    expect(parseConfigurationKeyPath("")).toEqual({
      ok: false,
      error: { kind: "configuration-key-path", code: "key-path-empty" },
    });
    expect(parseConfigurationKeyPath(`a.${"b".repeat(MAX_CONFIGURATION_KEY_PATH_LENGTH)}`)).toEqual(
      {
        ok: false,
        error: { kind: "configuration-key-path", code: "key-path-too-long" },
      },
    );
    expect(parseConfigurationKeyPath(7)).toEqual({
      ok: false,
      error: { kind: "configuration-key-path", code: "key-path-not-a-string" },
    });
  });

  test("never echoes the rejected text", () => {
    const secret = "sk-live-0123456789";
    const parsed = parseConfigurationKeyPath(secret);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  test("the throwing form is for declaration literals only", () => {
    expect(configurationKeyPath("data.retention") as string).toBe("data.retention");
    expect(() => configurationKeyPath("nope")).toThrow(/key-path-malformed/);
  });
});

describe("scopes and sources", () => {
  test("every source kind names the scope it supplies", () => {
    const scopes = CONFIGURATION_SOURCE_KINDS.map(scopeForSourceKind);
    expect(scopes).toEqual([null, "user", "project", "profile", "environment", "cli"]);
  });

  test("built-in defaults have no scope, because no scope set them", () => {
    expect(scopeForSourceKind("built-in-default")).toBeNull();
  });

  test("recognizes only declared scopes", () => {
    expect(isConfigurationScope("project")).toBe(true);
    expect(isConfigurationScope("global")).toBe(false);
  });
});

describe("limits", () => {
  test("unlimited is a word, not a number", () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(-1)).toBe(false);
  });
});

describe("issue severity", () => {
  const error: ConfigurationIssue = {
    kind: "unknown-key",
    severity: "error",
    path: "data.nope",
  };
  const warning: ConfigurationIssue = {
    kind: "deprecated-key",
    severity: "warning",
    path: "data.old",
    replacement: null,
    removedInSchemaVersion: null,
  };

  test("only an error blocks a document", () => {
    expect(isBlockingIssue(error)).toBe(true);
    expect(isBlockingIssue(warning)).toBe(false);
    expect(blockingIssues([warning, error, warning])).toEqual([error]);
  });
});
