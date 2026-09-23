import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { syncDependencyPins } from "./dependency-pin-sync.ts";
import { DIRECT_DEPENDENCY_POLICY } from "./repository-integrity.ts";

const integritySource = readFileSync(join(import.meta.dir, "repository-integrity.ts"), "utf8");
const biomeSource = readFileSync(join(import.meta.dir, "../../biome.json"), "utf8");

function manifest(overrides: Record<string, string> = {}): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  const result = {
    dependencies: {} as Record<string, string>,
    devDependencies: {} as Record<string, string>,
  };
  for (const policy of DIRECT_DEPENDENCY_POLICY) {
    result[policy.group][policy.name] = overrides[policy.name] ?? policy.version;
  }
  return result;
}

function pinOf(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`name: "${escaped}",\\s*group: "[^"]+",\\s*version: "([^"]+)"`).exec(
    source,
  )?.[1];
}

describe("dependency pin sync", () => {
  test("leaves matching pins and the Biome schema unchanged", () => {
    const result = syncDependencyPins({ manifest: manifest(), integritySource, biomeSource });

    expect(result.changed).toEqual([]);
    expect(result.integritySource).toBe(integritySource);
    expect(result.biomeSource).toBe(biomeSource);
  });

  test("updates only the bumped version fields", () => {
    const result = syncDependencyPins({
      manifest: manifest({ openai: "99.1.0", zod: "99.2.3-beta.1" }),
      integritySource,
      biomeSource,
    });

    expect(result.changed).toHaveLength(2);
    expect(pinOf(result.integritySource, "openai")).toBe("99.1.0");
    expect(pinOf(result.integritySource, "zod")).toBe("99.2.3-beta.1");
    const untouched = DIRECT_DEPENDENCY_POLICY.find((policy) => policy.name === "react");
    expect(pinOf(result.integritySource, "react")).toBe(untouched?.version);
    expect(result.integritySource.split("\n").length).toBe(integritySource.split("\n").length);
  });

  test("moves the Biome schema with the Biome pin", () => {
    const result = syncDependencyPins({
      manifest: manifest({ "@biomejs/biome": "9.9.9" }),
      integritySource,
      biomeSource,
    });

    expect(pinOf(result.integritySource, "@biomejs/biome")).toBe("9.9.9");
    expect(result.biomeSource).toContain("https://biomejs.dev/schemas/9.9.9/schema.json");
    expect(result.changed).toHaveLength(2);
  });

  test("refuses ranges, unknown packages and group moves", () => {
    expect(() =>
      syncDependencyPins({
        manifest: manifest({ openai: "^99.1.0" }),
        integritySource,
        biomeSource,
      }),
    ).toThrow("not an exact version");

    const unknown = manifest();
    unknown.dependencies["left-pad"] = "1.3.0";
    expect(() => syncDependencyPins({ manifest: unknown, integritySource, biomeSource })).toThrow(
      "no reviewed policy entry",
    );

    const moved = manifest();
    moved.devDependencies.zod = moved.dependencies.zod as string;
    delete moved.dependencies.zod;
    expect(() => syncDependencyPins({ manifest: moved, integritySource, biomeSource })).toThrow(
      "reviewed for dependencies",
    );
  });

  test("refuses malformed input instead of writing a partial result", () => {
    expect(() => syncDependencyPins({ manifest: null, integritySource, biomeSource })).toThrow(
      "not an object",
    );
    expect(() =>
      syncDependencyPins({ manifest: manifest(), integritySource: "export {};", biomeSource }),
    ).toThrow("no direct-dependency policy entries");
  });
});
