/**
 * Domain module-boundary controls.
 *
 * The domain is the leaf of Falryn's source-area dependency graph. A cycle
 * inside it can remain erased while every edge is type-only, then become an
 * order-dependent runtime failure when one future import becomes a value.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);

type DomainSources = ReadonlyMap<string, string>;

const IMPORT_FROM = /^(?:import|export)\s+(?:type\s+)?[^;]*?\sfrom\s+["'](\.[^"']+)["'];?$/gm;
const SIDE_EFFECT_IMPORT = /^import\s+["'](\.[^"']+)["'];?$/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["'](\.[^"']+)["']\s*\)/g;

async function domainSources(): Promise<DomainSources> {
  const glob = new Bun.Glob("**/*.ts");
  const entries: [string, string][] = [];
  for await (const file of glob.scan({ cwd: `${SOURCE_ROOT}/domain` })) {
    if (file.endsWith(".test.ts") || file.endsWith("fixtures.ts")) {
      continue;
    }
    entries.push([file, await readFile(`${SOURCE_ROOT}/domain/${file}`, "utf8")]);
  }
  return new Map(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function importedModules(file: string, source: string, sources: DomainSources): readonly string[] {
  const modules = new Set<string>();
  for (const expression of [IMPORT_FROM, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(expression)) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      const imported = normalize(`${dirname(file)}/${specifier}`);
      if (sources.has(imported)) {
        modules.add(imported);
      }
    }
  }
  return [...modules].sort();
}

function cycles(sources: DomainSources): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const path: string[] = [];
  const found: string[][] = [];

  const visit = (file: string): void => {
    const loopStart = path.indexOf(file);
    if (loopStart >= 0) {
      found.push([...path.slice(loopStart), file]);
      return;
    }
    if (visited.has(file)) {
      return;
    }
    const source = sources.get(file);
    if (source === undefined) {
      return;
    }
    path.push(file);
    for (const imported of importedModules(file, source, sources)) {
      visit(imported);
    }
    path.pop();
    visited.add(file);
  };

  for (const file of [...sources.keys()].sort()) {
    visit(file);
  }
  return found;
}

describe("the domain module graph", () => {
  test("contains no import cycle", async () => {
    expect(cycles(await domainSources())).toEqual([]);
  });

  test("detects a reintroduced type-only artifact and blob cycle", async () => {
    const sources = await domainSources();
    const blob = sources.get("blob.ts");
    expect(blob).toBeDefined();

    const reintroduced = blob?.replace('from "./identity.ts"', 'from "./artifact.ts"');
    expect(reintroduced).toBeDefined();
    expect(reintroduced).not.toBe(blob);

    const withCycle = new Map(sources);
    withCycle.set("blob.ts", reintroduced ?? "");
    expect(cycles(withCycle)).toContainEqual(["artifact.ts", "blob.ts", "artifact.ts"]);
  });
});
