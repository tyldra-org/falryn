/**
 * Cross-layer merge and the inspection projection.
 *
 * The identified-list shape has no v0.1 product key, so it is exercised with a
 * fixture registry — the same rule #7 applied when it proved the shapes its
 * catalog had no consumer for.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createRuntimeRedactor, REDACTED } from "../application/index.ts";
import {
  type ConfigurationGenerationRecord,
  type ConfigurationSource,
  configurationKeyPath,
  FIRST_CONFIGURATION_GENERATION,
} from "../domain/index.ts";
import { composeLayers, type LayerInput } from "./composition.ts";
import { enumKey, identifiedArrayKey, objectKey } from "./declaration.ts";
import { inspectGeneration } from "./inspection.ts";
import { createConfigurationRegistry } from "./registry.ts";

const LIST_KEY = identifiedArrayKey({
  path: "fixture.list",
  summary: "A list merged by a declared identity.",
  identityField: "name",
  elementSchema: z.strictObject({ name: z.string().min(1).max(32), enabled: z.boolean() }),
  defaultValue: [{ name: "builtin", enabled: true }],
  maximumItems: 8,
  scopes: ["user", "project", "profile", "environment", "cli"],
  applicationClass: "application-restart",
});

const MODE_KEY = enumKey({
  path: "fixture.mode",
  summary: "A scalar that replaces.",
  allowed: ["fast", "careful"],
  defaultValue: "careful",
  scopes: ["user", "project", "profile", "environment", "cli"],
  applicationClass: "live",
});

const SECRET_KEY = objectKey({
  path: "fixture.secret",
  summary: "A declared-sensitive value.",
  objectSchema: z.strictObject({ token: z.string().min(1).max(64) }),
  defaultValue: { token: "unset" },
  sensitivity: "sensitive",
  scopes: ["user", "project"],
  applicationClass: "live",
});

const DECLARATIONS = [LIST_KEY, MODE_KEY, SECRET_KEY];

function registry() {
  return createConfigurationRegistry({
    declarations: DECLARATIONS,
    redactor: createRuntimeRedactor(),
  });
}

function layer(kind: ConfigurationSource["kind"], values: Record<string, unknown>): LayerInput {
  return {
    source: { kind, file: null, profile: null },
    scope: kind === "user-file" ? "user" : kind === "project-file" ? "project" : "cli",
    values: values as never,
  };
}

function compose(layers: readonly LayerInput[]) {
  const port = registry();
  return {
    port,
    result: composeLayers({
      registry: port,
      declarations: DECLARATIONS,
      redactor: createRuntimeRedactor(),
      layers,
    }),
  };
}

describe("merging an identified list across layers", () => {
  test("a later layer amends a matching element and appends a new one", () => {
    const { result } = compose([
      layer("user-file", { "fixture.list": [{ name: "user", enabled: true }] }),
      layer("project-file", {
        "fixture.list": [
          { name: "builtin", enabled: false },
          { name: "project", enabled: true },
        ],
      }),
    ]);

    expect(result.values["fixture.list"]).toEqual([
      // Amended in place, so the default's position is preserved.
      { name: "builtin", enabled: false },
      { name: "user", enabled: true },
      { name: "project", enabled: true },
    ]);
  });

  test("a fold that would exceed the declared maximum is refused", () => {
    const many = Array.from({ length: 8 }, (_value, index) => ({
      name: `n${index}`,
      enabled: true,
    }));
    const { result } = compose([layer("user-file", { "fixture.list": many })]);

    // Eight is the bound on its own; folded onto a one-element default it is
    // nine, and neither layer stated nine.
    expect(result.issues.map((issue) => issue.kind)).toContain("out-of-range");
  });

  test("a scalar beside it still replaces", () => {
    const { result } = compose([
      layer("user-file", { "fixture.mode": "fast" }),
      layer("project-file", { "fixture.mode": "careful" }),
    ]);
    expect(result.values["fixture.mode"]).toBe("careful");
  });
});

describe("provenance across layers", () => {
  test("the defaults layer owns every key nothing else set", () => {
    const { result } = compose([]);
    for (const entry of result.provenance) {
      expect(entry.source.kind).toBe("built-in-default");
      expect(entry.layerIndex).toBe(0);
      expect(entry.scope).toBeNull();
    }
  });

  test("a default that was replaced is not recorded as an override", () => {
    const { result } = compose([layer("user-file", { "fixture.mode": "fast" })]);
    // Only a real source losing to another is worth showing; every key starts
    // at its default, so recording that would make the list all noise.
    expect(result.overridden).toEqual([]);
  });

  test("each losing source is kept in the order it lost", () => {
    const { result } = compose([
      layer("user-file", { "fixture.mode": "fast" }),
      layer("project-file", { "fixture.mode": "careful" }),
      layer("cli-override", { "fixture.mode": "fast" }),
    ]);

    expect(result.overridden.map((entry) => entry.source.kind)).toEqual([
      "user-file",
      "project-file",
    ]);
    expect(result.provenance.find((entry) => entry.path === "fixture.mode")?.source.kind).toBe(
      "cli-override",
    );
  });
});

describe("the inspection projection", () => {
  function record(): ConfigurationGenerationRecord {
    const { result } = compose([
      layer("user-file", { "fixture.mode": "fast", "fixture.secret": { token: "hunter2" } }),
      layer("project-file", { "fixture.mode": "careful" }),
    ]);
    return {
      generation: FIRST_CONFIGURATION_GENERATION,
      values: result.values,
      provenance: result.provenance,
      overridden: result.overridden,
      sources: [],
      issues: result.issues,
    };
  }

  test("emits every key in canonical path order", () => {
    const port = registry();
    const inspection = inspectGeneration(port, record());
    const paths = inspection.values.map((entry) => String(entry.path));
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("fixture.mode");
  });

  test("names the winning source and what it beat", () => {
    const port = registry();
    const inspection = inspectGeneration(port, record());
    const mode = inspection.values.find((entry) => entry.path === "fixture.mode");

    expect(mode?.value).toBe("careful");
    expect(mode?.source.kind).toBe("project-file");
    expect(mode?.overriddenBy.map((entry) => entry.source.kind)).toEqual(["user-file"]);
  });

  test("shows a declared-sensitive value as its placeholder, never its bytes", () => {
    const port = registry();
    const inspection = inspectGeneration(port, record());
    const secret = inspection.values.find((entry) => entry.path === "fixture.secret");

    expect(secret?.value).toBe(REDACTED);
    expect(JSON.stringify(inspection)).not.toContain("hunter2");
  });

  test("a key that no source set still reports its default source", () => {
    const port = registry();
    const inspection = inspectGeneration(port, record());
    const list = inspection.values.find(
      (entry) => entry.path === configurationKeyPath("fixture.list"),
    );
    expect(list?.source.kind).toBe("built-in-default");
    expect(list?.overriddenBy).toEqual([]);
  });
});
