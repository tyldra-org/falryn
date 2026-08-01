import { describe, expect, test } from "bun:test";

import { createRuntimeRedactor } from "../application/index.ts";
import type {
  ConfigurationIssue,
  ConfigurationLayerContext,
  ConfigurationValue,
} from "../domain/index.ts";
import {
  configurationKeyPath,
  DEFAULT_BUSY_TIMEOUT_MS,
  DIAGNOSTIC_LEVELS,
  MAX_BUSY_TIMEOUT_MS,
  MAX_DEBUG_WINDOW_MS,
  MAX_DIAGNOSTIC_CARDINALITY,
  MAX_RETAINED_DIAGNOSTICS,
  MIN_BUSY_TIMEOUT_MS,
  UNLIMITED,
} from "../domain/index.ts";
import {
  MAX_CLASS_BYTES,
  MAX_RETENTION_MS,
  MIN_CLASS_BYTES,
  MIN_RETENTION_MS,
  RETENTION_CLASSES,
  V0_1_CONFIGURATION_KEYS,
  V0_1_CROSS_FIELD_RULES,
} from "./keys.ts";
import { createConfigurationRegistry } from "./registry.ts";
import { CONFIGURATION_SCHEMA_VERSION, SCHEMA_VERSION_FIELD } from "./schema-family.ts";

const USER_LAYER: ConfigurationLayerContext = { scope: "user", sourceKind: "user-file" };
const PROJECT_LAYER: ConfigurationLayerContext = { scope: "project", sourceKind: "project-file" };

const port = createConfigurationRegistry({
  declarations: V0_1_CONFIGURATION_KEYS,
  crossFieldRules: V0_1_CROSS_FIELD_RULES,
  redactor: createRuntimeRedactor(),
});

function document(body: Record<string, unknown> = {}): Record<string, unknown> {
  return { [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION, ...body };
}

function firstIssue(issues: readonly ConfigurationIssue[]): ConfigurationIssue | undefined {
  return issues[0];
}

describe("the v0.1 catalog", () => {
  test("declares only groups that have a v0.1 consumer", () => {
    const groups = new Set(port.keys().map((descriptor) => descriptor.path.split(".")[0]));
    expect([...groups].sort()).toEqual(["data", "diagnostics"]);
  });

  test("declares no key that could relocate the configuration root", () => {
    // Discovery has to find the configuration root before it can read a key, so
    // a key that moved that root could only be read from the place it left.
    expect(port.describe("data.roots.configuration")).toBeNull();
    expect(port.keys().some((descriptor) => descriptor.path.includes("configuration"))).toBe(false);
  });

  test("declares no alias or deprecation, because no key has a predecessor", () => {
    for (const descriptor of port.keys()) {
      expect(descriptor.aliases).toEqual([]);
      expect(descriptor.deprecation).toBeNull();
    }
  });

  test("gives every bounded key an explicit unit", () => {
    for (const descriptor of port.keys()) {
      if (descriptor.valueType === "integer" || descriptor.valueType === "limit") {
        expect(descriptor.unit).not.toBeNull();
        expect(descriptor.minimum).not.toBeNull();
        expect(descriptor.maximum).not.toBeNull();
      }
    }
  });

  test("gives every key at least one scope and one application class", () => {
    for (const descriptor of port.keys()) {
      expect(descriptor.scopes.length).toBeGreaterThan(0);
      expect(descriptor.applicationClass.length).toBeGreaterThan(0);
      expect(descriptor.introducedInSchemaVersion).toBe(CONFIGURATION_SCHEMA_VERSION);
    }
  });

  test("maps each root override onto a declared environment variable", () => {
    for (const descriptor of port.keys()) {
      if (descriptor.path.startsWith("data.roots.")) {
        expect(descriptor.environmentVariable).toMatch(/^FALRYN_[A-Z_]+$/);
        expect(descriptor.computedDefault).toBe(true);
        expect(descriptor.defaultValue).toBeNull();
      }
    }
  });

  test("declares the SQLite busy timeout with its unit, bounds, and scopes", () => {
    const descriptor = port.describe("data.sqlite.busyTimeoutMs");

    expect(descriptor).toMatchObject({
      valueType: "integer",
      unit: "milliseconds",
      minimum: MIN_BUSY_TIMEOUT_MS,
      maximum: MAX_BUSY_TIMEOUT_MS,
      defaultValue: DEFAULT_BUSY_TIMEOUT_MS,
      scopes: ["user", "environment", "cli"],
      // Applied once when the connection opens, so a change takes effect on the
      // next run rather than on the next operation.
      applicationClass: "application-restart",
      sensitivity: "public",
    });
  });

  test("declares no key that could change SQLite's durability semantics", () => {
    // Journal mode, foreign keys, and `synchronous` are owned centrally on
    // purpose: a user who turned foreign keys off would silently change a
    // guarantee the data owner exists to hold.
    const sqliteKeys = port
      .keys()
      .filter((descriptor) => descriptor.path.startsWith("data.sqlite."))
      .map((descriptor) => String(descriptor.path));
    expect(sqliteKeys).toEqual(["data.sqlite.busyTimeoutMs"]);
  });

  test("declares no key that relocates the database, only the state root", () => {
    // Relocating the database means relocating the `state` root through the
    // existing key, not adding a second path key that could disagree with it.
    expect(port.describe("data.sqlite.path")).toBeNull();
    expect(port.describe("data.roots.state")).not.toBeNull();
  });

  test("declares map merging only for the retention map", () => {
    const merging = port
      .keys()
      .filter((descriptor) => descriptor.merge.kind === "merge-map")
      .map((descriptor) => String(descriptor.path));
    expect(merging).toEqual(["data.retention"]);
  });
});

describe("complete configurations", () => {
  test("the complete default configuration is valid and internally consistent", () => {
    const defaults = port.defaults();
    expect(port.crossValidate(defaults)).toEqual([]);
    for (const descriptor of port.keys()) {
      expect(defaults[descriptor.path]).toEqual(descriptor.defaultValue);
    }
  });

  test("a minimal document declares only its schema version", () => {
    const result = port.validateComplete(document(), USER_LAYER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual(port.defaults());
      expect(result.issues).toEqual([]);
    }
  });

  test("a complete document sets every declared key", () => {
    const result = port.validateComplete(
      document({
        data: {
          roots: {
            state: "/tmp/falryn/state",
            cache: "/tmp/falryn/cache",
            logs: "/tmp/falryn/logs",
            temporaryIngest: "/tmp/falryn/tmp",
            artifacts: "/tmp/falryn/artifacts",
            exports: "/tmp/falryn/exports",
          },
          retention: {
            logs: { maxAgeMs: MIN_RETENTION_MS, maxBytes: MIN_CLASS_BYTES },
            cache: { maxAgeMs: UNLIMITED, maxBytes: MIN_CLASS_BYTES },
            temporaryIngest: { maxAgeMs: MAX_RETENTION_MS, maxBytes: MIN_CLASS_BYTES },
          },
          quotas: { totalMaxBytes: MAX_CLASS_BYTES },
        },
        diagnostics: {
          level: "debug",
          retention: { maxEvents: 10, maxDistinctSeries: 4 },
          debugWindow: { ttlMs: 1_000, maxPreviews: 1 },
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.values).sort()).toEqual(
        port
          .keys()
          .map((descriptor) => descriptor.path)
          .sort(),
      );
      expect(result.values["diagnostics.level"]).toBe("debug");
    }
  });
});

describe("invalid values per declared type, range, and unit", () => {
  test("a root override that is not a path", () => {
    const result = port.validateLayer(document({ data: { roots: { cache: 42 } } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "invalid-type",
      severity: "error",
      path: "data.roots.cache",
      expected: "string",
    });
  });

  test("a diagnostic level that is not one of the declared levels", () => {
    const result = port.validateLayer(document({ diagnostics: { level: "verbose" } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "invalid-value",
      severity: "error",
      path: "diagnostics.level",
      allowed: [...DIAGNOSTIC_LEVELS],
    });
  });

  test("a retention budget above the safe hard maximum is an error, not a clamp", () => {
    const result = port.validateLayer(
      document({ diagnostics: { retention: { maxEvents: MAX_RETAINED_DIAGNOSTICS + 1 } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "out-of-range",
      severity: "error",
      path: "diagnostics.retention.maxEvents",
      unit: "items",
      minimum: 1,
      maximum: MAX_RETAINED_DIAGNOSTICS,
    });
  });

  test("a busy timeout outside its declared range is an error, not a clamp", () => {
    const result = port.validateLayer(
      document({ data: { sqlite: { busyTimeoutMs: MAX_BUSY_TIMEOUT_MS + 1 } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "out-of-range",
      severity: "error",
      path: "data.sqlite.busyTimeoutMs",
      unit: "milliseconds",
      minimum: MIN_BUSY_TIMEOUT_MS,
      maximum: MAX_BUSY_TIMEOUT_MS,
    });
  });

  test("a cardinality bound above the collector's own", () => {
    const result = port.validateLayer(
      document({
        diagnostics: { retention: { maxDistinctSeries: MAX_DIAGNOSTIC_CARDINALITY + 1 } },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)?.kind).toBe("out-of-range");
  });

  test("a debug window longer than one may stay open", () => {
    const result = port.validateLayer(
      document({ diagnostics: { debugWindow: { ttlMs: MAX_DEBUG_WINDOW_MS + 1 } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "out-of-range",
      severity: "error",
      path: "diagnostics.debugWindow.ttlMs",
      unit: "milliseconds",
      minimum: 1_000,
      maximum: MAX_DEBUG_WINDOW_MS,
    });
  });

  test("zero is not a spelling of unlimited", () => {
    const result = port.validateLayer(
      document({ data: { quotas: { totalMaxBytes: 0 } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "out-of-range",
      severity: "error",
      path: "data.quotas.totalMaxBytes",
      unit: "bytes",
      minimum: MIN_CLASS_BYTES,
      maximum: MAX_CLASS_BYTES,
    });
  });

  test("unlimited is spelled out, and anything else is not a limit", () => {
    const accepted = port.validateLayer(
      document({ data: { quotas: { totalMaxBytes: UNLIMITED } } }),
      USER_LAYER,
    );
    expect(accepted.ok).toBe(true);

    const rejected = port.validateLayer(
      document({ data: { quotas: { totalMaxBytes: "none" } } }),
      USER_LAYER,
    );
    expect(rejected.ok).toBe(false);
    expect(firstIssue(rejected.issues)).toEqual({
      kind: "invalid-type",
      severity: "error",
      path: "data.quotas.totalMaxBytes",
      expected: "limit",
    });
  });

  test("a retention age below the shortest one may declare", () => {
    const result = port.validateLayer(
      document({ data: { retention: { logs: { maxAgeMs: 5, maxBytes: MIN_CLASS_BYTES } } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toMatchObject({
      kind: "out-of-range",
      path: "data.retention.logs.maxAgeMs",
    });
  });

  test("an ownership class no owner registers", () => {
    const result = port.validateLayer(
      document({ data: { retention: { credentials: { maxAgeMs: 1, maxBytes: 1 } } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "unknown-key",
      severity: "error",
      path: "data.retention.credentials",
    });
  });

  test("a key that does not exist", () => {
    const result = port.validateLayer(document({ data: { rootz: {} } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "unknown-key",
      severity: "error",
      path: "data.rootz",
    });
  });
});

describe("scope availability", () => {
  test("a project cannot relocate this machine's data roots", () => {
    const result = port.validateLayer(
      document({ data: { roots: { cache: "/tmp/elsewhere" } } }),
      PROJECT_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(firstIssue(result.issues)).toEqual({
      kind: "scope-unavailable",
      severity: "error",
      path: "data.roots.cache",
      scope: "project",
      availableScopes: ["user", "environment", "cli"],
    });
  });

  test("a project may still raise its own diagnostic level", () => {
    const result = port.validateLayer(document({ diagnostics: { level: "debug" } }), PROJECT_LAYER);
    expect(result.ok).toBe(true);
  });
});

describe("cross-field validation", () => {
  test("per-class budgets have to fit inside the total", () => {
    const result = port.validateComplete(
      document({
        data: {
          retention: {
            logs: { maxAgeMs: MIN_RETENTION_MS, maxBytes: 512 * 1_024 * 1_024 },
            cache: { maxAgeMs: UNLIMITED, maxBytes: 512 * 1_024 * 1_024 },
            temporaryIngest: { maxAgeMs: MIN_RETENTION_MS, maxBytes: 512 * 1_024 * 1_024 },
          },
          quotas: { totalMaxBytes: MIN_CLASS_BYTES },
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      kind: "cross-field-conflict",
      severity: "error",
      path: "data.quotas.totalMaxBytes",
      rule: "data.quotas.total-covers-classes",
      relatedPaths: [
        configurationKeyPath("data.quotas.totalMaxBytes"),
        configurationKeyPath("data.retention"),
      ],
    });
  });

  test("a partial retention map keeps the classes it did not mention", () => {
    const defaults = port.defaults()["data.retention"] as Record<string, ConfigurationValue>;
    const result = port.validateComplete(
      document({
        data: { retention: { logs: { maxAgeMs: MIN_RETENTION_MS, maxBytes: MIN_CLASS_BYTES } } },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const retention = result.values["data.retention"] as Record<string, ConfigurationValue>;
      expect(Object.keys(retention).sort()).toEqual([...RETENTION_CLASSES].sort());
      expect(retention.logs).toEqual({ maxAgeMs: MIN_RETENTION_MS, maxBytes: MIN_CLASS_BYTES });
      expect(retention.cache).toEqual(defaults.cache);
      expect(retention.temporaryIngest).toEqual(defaults.temporaryIngest);
    }
  });

  test("a partial retention map is still weighed whole against the total", () => {
    // Only `logs` is set, and on its own it fits. Together with the `cache` and
    // `temporaryIngest` defaults beside it, the claim exceeds the default total
    // — which is exactly the combination a wholesale replace would hide.
    const result = port.validateComplete(
      document({
        data: {
          retention: { logs: { maxAgeMs: MIN_RETENTION_MS, maxBytes: 4 * 1_024 * 1_024 * 1_024 } },
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain("cross-field-conflict");
  });

  test("an unbounded class cannot fit inside a bounded total", () => {
    const result = port.validateComplete(
      document({
        data: {
          retention: { cache: { maxAgeMs: UNLIMITED, maxBytes: UNLIMITED } },
          quotas: { totalMaxBytes: MAX_CLASS_BYTES },
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain("cross-field-conflict");
  });

  test("an unbounded total accommodates anything", () => {
    const result = port.validateComplete(
      document({
        data: {
          retention: { cache: { maxAgeMs: UNLIMITED, maxBytes: UNLIMITED } },
          quotas: { totalMaxBytes: UNLIMITED },
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
  });

  test("every retention class named by the map is a declared class", () => {
    const descriptor = port.describe("data.retention");
    expect(descriptor?.allowedValues).toEqual([...RETENTION_CLASSES]);
  });
});

describe("negative controls", () => {
  test("no rejected value reaches a product-key issue", () => {
    const secret = "ghp_0123456789abcdef0123456789abcdef0123";
    const result = port.validateLayer(
      document({
        data: { roots: { cache: 1 }, quotas: { totalMaxBytes: secret } },
        diagnostics: { level: secret },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });

  test("every declared key is public, so nothing here claims to hold a secret", () => {
    for (const descriptor of port.keys()) {
      expect(descriptor.sensitivity).toBe("public");
    }
  });
});
