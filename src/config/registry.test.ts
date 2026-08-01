import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createRuntimeRedactor, REDACTED } from "../application/index.ts";
import type {
  ConfigurationIssue,
  ConfigurationLayerContext,
  ConfigurationValue,
} from "../domain/index.ts";
import { configurationKeyPath } from "../domain/index.ts";
import { type ConfigurationKeyDeclaration, identifiedArrayKey } from "./declaration.ts";
import {
  FIXTURE_CREDENTIAL_KEY,
  FIXTURE_CROSS_FIELD_RULE,
  FIXTURE_KEYS,
  MARKING_REDACTOR,
} from "./fixtures.ts";
import { createConfigurationRegistry } from "./registry.ts";
import { SCHEMA_VERSION_FIELD } from "./schema-family.ts";

const USER_LAYER: ConfigurationLayerContext = { scope: "user", sourceKind: "user-file" };
const PROJECT_LAYER: ConfigurationLayerContext = { scope: "project", sourceKind: "project-file" };

function registry(redactor = MARKING_REDACTOR) {
  return createConfigurationRegistry({
    declarations: FIXTURE_KEYS,
    crossFieldRules: [FIXTURE_CROSS_FIELD_RULE],
    redactor,
  });
}

function document(body: Record<string, unknown>, schemaVersion = 1): Record<string, unknown> {
  return { [SCHEMA_VERSION_FIELD]: schemaVersion, ...body };
}

/** The identified-list key with nothing to fold onto, for the positive control. */
function emptyDefaultList(maximumItems: number): ConfigurationKeyDeclaration {
  return identifiedArrayKey({
    path: "fixture.list",
    summary: "A list whose default is empty.",
    identityField: "name",
    elementSchema: z.strictObject({ name: z.string().min(1).max(64), enabled: z.boolean() }),
    defaultValue: [],
    maximumItems,
    scopes: ["user", "project"],
    applicationClass: "application-restart",
  });
}

function kinds(issues: readonly ConfigurationIssue[]): readonly string[] {
  return issues.map((issue) => issue.kind);
}

describe("the key registry", () => {
  test("reports every declared key at its default", () => {
    const port = registry();
    const defaults = port.defaults();
    expect(Object.keys(defaults).sort()).toEqual(
      FIXTURE_KEYS.map((declaration) => declaration.descriptor.path).sort(),
    );
    expect(defaults["fixture.scalar"]).toBe(10);
  });

  test("describes a key by its canonical path and not by an alias", () => {
    const port = registry();
    expect(String(port.describe("fixture.mode")?.path)).toBe("fixture.mode");
    expect(port.describe("fixture.missing")).toBeNull();
  });

  test("refuses to build two keys on one path", () => {
    expect(() =>
      createConfigurationRegistry({
        declarations: [...FIXTURE_KEYS, ...FIXTURE_KEYS],
        redactor: MARKING_REDACTOR,
      }),
    ).toThrow(/duplicate configuration key path/);
  });

  test("declares a merge behavior for every key, so composition never guesses", () => {
    for (const descriptor of registry().keys()) {
      expect(["replace", "merge-map", "merge-by-identity"]).toContain(descriptor.merge.kind);
      if (descriptor.merge.kind === "merge-by-identity") {
        expect(descriptor.merge.identityField.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("validating a layer", () => {
  test("accepts a document and reports values under canonical paths", () => {
    const result = registry().validateLayer(
      document({ fixture: { scalar: 3, mode: "fast" } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual({ "fixture.scalar": 3, "fixture.mode": "fast" });
      expect(result.issues).toEqual([]);
    }
  });

  test("rejects a document that is not an object", () => {
    const result = registry().validateLayer("schemaVersion: 1", USER_LAYER);
    expect(result.ok).toBe(false);
    expect(kinds(result.issues)).toEqual(["invalid-type"]);
  });

  test("rejects an unknown key rather than mapping it onto a known one", () => {
    const result = registry().validateLayer(document({ fixture: { scalr: 3 } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { kind: "unknown-key", severity: "error", path: "fixture.scalr" },
    ]);
  });

  test("rejects an unknown top-level group", () => {
    const result = registry().validateLayer(document({ providers: { openai: {} } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ kind: "unknown-key", severity: "error", path: "providers" }]);
  });

  test("resolves a deprecated spelling to its canonical path, visibly", () => {
    const result = registry().validateLayer(
      document({ fixture: { legacyMode: "fast" } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual({ "fixture.mode": "fast" });
      expect(result.issues).toEqual([
        {
          kind: "alias-resolved",
          severity: "warning",
          path: "fixture.legacyMode",
          canonical: configurationKeyPath("fixture.mode"),
        },
      ]);
    }
  });

  test("accepts a deprecated key and names its replacement", () => {
    const result = registry().validateLayer(document({ fixture: { legacyBudget: 4 } }), USER_LAYER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toEqual([
        {
          kind: "deprecated-key",
          severity: "warning",
          path: "fixture.legacyBudget",
          replacement: configurationKeyPath("fixture.scalar"),
          removedInSchemaVersion: 2,
        },
      ]);
    }
  });

  test("refuses a key that this scope may not set", () => {
    const result = registry().validateLayer(
      document({ fixture: { legacyBudget: 4 } }),
      PROJECT_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      kind: "scope-unavailable",
      severity: "error",
      path: "fixture.legacyBudget",
      scope: "project",
      availableScopes: ["user"],
    });
  });

  test("reports a wrong shape as a type issue", () => {
    const result = registry().validateLayer(document({ fixture: { scalar: "3" } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { kind: "invalid-type", severity: "error", path: "fixture.scalar", expected: "integer" },
    ]);
  });

  test("reports a value past its bound with the bound, in its unit", () => {
    const result = registry().validateLayer(document({ fixture: { scalar: 101 } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: "out-of-range",
        severity: "error",
        path: "fixture.scalar",
        unit: "items",
        minimum: 0,
        maximum: 100,
      },
    ]);
  });

  test("reports an unknown option with the options that exist", () => {
    const result = registry().validateLayer(document({ fixture: { mode: "quick" } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: "invalid-value",
        severity: "error",
        path: "fixture.mode",
        allowed: ["fast", "careful"],
      },
    ]);
  });
});

describe("declared value shapes", () => {
  test("treats a map's entries as its value, not as further key paths", () => {
    const result = registry().validateLayer(
      document({ fixture: { map: { alpha: { weight: 7 } } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["fixture.map"]).toEqual({ alpha: { weight: 7 } });
    }
  });

  test("rejects a map entry outside the declared class set", () => {
    const result = registry().validateLayer(
      document({ fixture: { map: { gamma: { weight: 1 } } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { kind: "unknown-key", severity: "error", path: "fixture.map.gamma" },
    ]);
  });

  test("reports a bound violated inside a map entry at its full path", () => {
    const result = registry().validateLayer(
      document({ fixture: { map: { alpha: { weight: 5_000 } } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: "out-of-range",
        severity: "error",
        path: "fixture.map.alpha.weight",
        unit: null,
        minimum: null,
        maximum: 1_000,
      },
    ]);
  });

  test("accepts an identified list and keeps its order", () => {
    const result = registry().validateLayer(
      document({
        fixture: {
          list: [
            { name: "one", enabled: true },
            { name: "two", enabled: false },
          ],
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["fixture.list"]).toEqual([
        { name: "one", enabled: true },
        { name: "two", enabled: false },
      ]);
    }
  });

  test("rejects a repeated identity, because merging it would be ambiguous", () => {
    const result = registry().validateLayer(
      document({
        fixture: {
          list: [
            { name: "one", enabled: true },
            { name: "one", enabled: false },
          ],
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: "duplicate-identity",
        severity: "error",
        path: "fixture.list",
        identityField: "name",
      },
    ]);
  });
});

describe("version skew inside a document", () => {
  test("drops an unknown key from a newer producer and names both versions", () => {
    const result = registry().validateLayer(
      document({ fixture: { scalar: 3, futureKey: "whatever" } }, 4),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual({ "fixture.scalar": 3 });
      expect(result.issues).toEqual([
        {
          kind: "ignored-forward-key",
          severity: "warning",
          path: "fixture.futureKey",
          observedSchemaVersion: 4,
          readerSchemaVersion: 1,
        },
      ]);
    }
  });

  test("rejects the whole document when a newer producer required a newer reader", () => {
    const result = registry().validateLayer(
      { schemaVersion: 4, minimumReaderSchemaVersion: 4, fixture: { scalar: 3 } },
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: "unsupported-schema-version",
        severity: "error",
        path: "minimumReaderSchemaVersion",
        observedSchemaVersion: 4,
        minimumCompatibleVersion: 4,
        readerSchemaVersion: 1,
      },
    ]);
  });
});

describe("cross-field validation", () => {
  test("accepts a combination that is possible", () => {
    const result = registry().validateComplete(
      document({ fixture: { scalar: 9, legacyBudget: 4 } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
  });

  test("rejects an impossible combination at compose time, not at use time", () => {
    const result = registry().validateComplete(
      document({ fixture: { scalar: 2, legacyBudget: 9 } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      kind: "cross-field-conflict",
      severity: "error",
      path: "fixture.legacyBudget",
      rule: "fixture.budget-fits-scalar",
      relatedPaths: [
        configurationKeyPath("fixture.legacyBudget"),
        configurationKeyPath("fixture.scalar"),
      ],
    });
  });

  test("fills defaults so a rule sees a complete value", () => {
    const result = registry().validateComplete(document({}), USER_LAYER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.values).sort()).toEqual(
        FIXTURE_KEYS.map((declaration) => declaration.descriptor.path).sort(),
      );
    }
  });

  test("folding over defaults obeys the declared merge, not a blanket replace", () => {
    const result = registry().validateComplete(
      document({ fixture: { map: { alpha: { weight: 9 } } } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // `beta` is untouched by the document and has to survive it: replacing the
      // map wholesale would silently drop a default the user never mentioned.
      expect(result.values["fixture.map"]).toEqual({
        alpha: { weight: 9 },
        beta: { weight: 2 },
      });
    }
  });

  test("an identified element is amended in place and a new one appended", () => {
    const result = registry().validateComplete(
      document({
        fixture: {
          list: [
            { name: "second", enabled: false },
            { name: "third", enabled: true },
          ],
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["fixture.list"]).toEqual([
        { name: "builtin", enabled: true },
        { name: "second", enabled: false },
        { name: "third", enabled: true },
      ]);
    }
  });

  test("a fold that exceeds the key's declared maximum is rejected", () => {
    const port = registry();
    const maximum = port.describe("fixture.list")?.maximum ?? 0;
    // At the bound on its own, and every name new — so the fold appends the
    // default's entries on top of a list that was already full.
    const list = Array.from({ length: maximum }, (_value, index) => ({
      name: `fresh-${index}`,
      enabled: true,
    }));

    expect(port.validateLayer(document({ fixture: { list } }), USER_LAYER).ok).toBe(true);

    const result = port.validateComplete(document({ fixture: { list } }), USER_LAYER);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      kind: "out-of-range",
      severity: "error",
      path: "fixture.list",
      unit: "items",
      minimum: 0,
      maximum,
    });
  });

  test("the same layer folded onto an empty default is accepted", () => {
    const port = createConfigurationRegistry({
      declarations: FIXTURE_KEYS.map((declaration) =>
        declaration.descriptor.path === "fixture.list"
          ? emptyDefaultList(declaration.descriptor.maximum ?? 16)
          : declaration,
      ),
      redactor: MARKING_REDACTOR,
    });
    const maximum = port.describe("fixture.list")?.maximum ?? 0;
    const list = Array.from({ length: maximum }, (_value, index) => ({
      name: `fresh-${index}`,
      enabled: true,
    }));

    const result = port.validateComplete(document({ fixture: { list } }), USER_LAYER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.values["fixture.list"] as readonly unknown[]).length).toBe(maximum);
    }
  });

  test("amending existing identities stays within the bound however tight it is", () => {
    // Nothing is appended, so the folded length equals the default's. A rule
    // that counted the inputs instead of the result would reject this.
    const result = registry().validateComplete(
      document({
        fixture: {
          list: [
            { name: "builtin", enabled: false },
            { name: "second", enabled: false },
          ],
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["fixture.list"]).toEqual([
        { name: "builtin", enabled: false },
        { name: "second", enabled: false },
      ]);
    }
  });

  test("a fold within its bound is untouched by the recheck", () => {
    const result = registry().validateComplete(
      document({ fixture: { list: [{ name: "third", enabled: true }] } }),
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.values["fixture.list"] as readonly unknown[]).length).toBe(3);
      expect(result.issues).toEqual([]);
    }
  });

  test("a scalar still replaces outright", () => {
    const result = registry().validateComplete(document({ fixture: { scalar: 7 } }), USER_LAYER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["fixture.scalar"]).toBe(7);
    }
  });

  test("each key naming a cross-field dependency names a declared key", () => {
    const port = registry();
    for (const descriptor of port.keys()) {
      for (const dependency of descriptor.crossFieldDependencies) {
        expect(port.describe(dependency)).not.toBeNull();
      }
    }
  });
});

describe("rendering a value", () => {
  test("withholds a declared-sensitive value whatever it contains", () => {
    expect(registry().render("fixture.secretBundle", { token: "hunter2" })).toBe("<withheld>");
  });

  test("shows a credential reference as presence, never as content", () => {
    const rendered = registry().render("fixture.credential", {
      storeKind: "operating-system-keychain",
      locator: "falryn/provider/openai",
      consumer: "openai",
      accountLabel: "work",
    });
    expect(rendered).toEqual({
      storeKind: "operating-system-keychain",
      consumer: "openai",
      accountLabel: "work",
      locator: "<withheld>",
      present: true,
    });
  });

  test("withholds a secret-named field even under a public key", () => {
    const rendered = registry().render("fixture.endpoint", {
      url: "https://example.invalid",
      apiKey: "sk-live-0123456789",
    });
    expect(rendered).toEqual({ url: "https://example.invalid", apiKey: "<withheld>" });
  });

  test("withholds a value whose key nothing declared", () => {
    expect(registry().render("fixture.unheardOf", "anything")).toBe("<withheld>");
  });

  test("uses the runtime redactor's rules rather than a second set", () => {
    const port = registry(createRuntimeRedactor());
    const rendered = port.render("fixture.endpoint", {
      url: "https://user:hunter2@example.invalid",
      apiKey: "sk-live-0123456789",
    });
    expect(rendered).toEqual({
      url: `https://${REDACTED}@example.invalid`,
      apiKey: REDACTED,
    });
    expect(port.render("fixture.secretBundle", { token: "hunter2" })).toBe(REDACTED);
  });
});

describe("negative controls", () => {
  test("no rejected value reaches any issue", () => {
    const secret = "sk-live-0123456789abcdef";
    const result = registry().validateLayer(
      document({
        fixture: {
          scalar: secret,
          mode: secret,
          map: { alpha: { weight: secret } },
          list: [{ name: secret, enabled: secret }],
        },
      }),
      USER_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });

  test("an unknown key's own name is bounded rather than echoed unbounded", () => {
    const long = "x".repeat(400);
    const result = registry().validateLayer(document({ [long]: 1 }), USER_LAYER);
    expect(result.ok).toBe(false);
    const [issue] = result.issues;
    expect(issue?.kind).toBe("unknown-key");
    expect(issue?.path.length).toBe(120);
  });

  test("rendering never returns the credential locator", () => {
    const port = registry(createRuntimeRedactor());
    const locator = "falryn/provider/secret-locator";
    const rendered: ConfigurationValue = port.render("fixture.credential", {
      storeKind: "operating-system-keychain",
      locator,
      consumer: "openai",
      accountLabel: null,
    });
    expect(JSON.stringify(rendered)).not.toContain(locator);
    expect(FIXTURE_CREDENTIAL_KEY.descriptor.sensitivity).toBe("credential-reference");
  });
});
