/**
 * Test support belongs to tests, never to the product graph.
 *
 * Fixtures can look harmless in an import diff, but carrying one into a product
 * module turns a deterministic test double into an accidental runtime policy.
 * This source-level control discovers every fixture module so a newly added one
 * cannot be missed by a manually maintained exemption list.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);

function isFixtureModule(file: string): boolean {
  return /(?:^|\/)[^/]*fixtures\.tsx?$/.test(file);
}

function isProductSource(file: string): boolean {
  return !file.endsWith(".test.ts") && !file.endsWith(".test.tsx") && !isFixtureModule(file);
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function importsFixture(source: string): boolean {
  return /\b(?:from\s*|import\s*\()\s*["'][^"']*fixtures(?:\.tsx?)?["']/.test(
    withoutComments(source),
  );
}

async function sourceFiles(): Promise<readonly string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  for await (const file of glob.scan({ cwd: SOURCE_ROOT })) {
    files.push(file);
  }
  return files.sort();
}

async function readSource(file: string): Promise<string> {
  return readFile(join(SOURCE_ROOT, file), "utf8");
}

describe("fixture imports", () => {
  test("discovers every test-support module, including the schema matrix", async () => {
    const fixtures = (await sourceFiles()).filter(isFixtureModule);

    expect(fixtures).toContain("schema-fixtures.ts");
    expect(fixtures.length).toBeGreaterThan(0);
  });

  test("detects static and dynamic imports rather than passing by construction", () => {
    expect(importsFixture('import { cases } from "./schema-fixtures.ts";')).toBe(true);
    expect(importsFixture('await import("./schema-fixtures");')).toBe(true);
    expect(importsFixture('import { launch } from "./main.ts";')).toBe(false);
  });

  test("are absent from every product source module", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProductSource(file) || !importsFixture(await readSource(file))) {
        continue;
      }
      offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
