import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const ROOT = dirname(import.meta.path);
const CAPABILITY_LAYERS = new Set([
  "domain",
  "application",
  "integrations",
  "providers",
  "data",
  "config",
]);

function isProduct(path: string): boolean {
  return !/\.(test|compiled)\.tsx?$/.test(path) && !/fixtures\.tsx?$/.test(path);
}

function misplacedModule(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 2 &&
    CAPABILITY_LAYERS.has(parts[0] ?? "") &&
    parts[1] !== "index.ts" &&
    isProduct(path)
  );
}

function outwardApplicationImports(path: string, source: string): readonly string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    const target = relative(ROOT, resolve(ROOT, dirname(path), match[1] ?? ""))
      .replaceAll("\\", "/")
      .split("/")[0];
    if (["integrations", "cli", "tui", "data", "presentation"].includes(target ?? "")) {
      imports.push(match[1] ?? "");
    }
  }
  return imports;
}

describe("source capability ownership", () => {
  test("rejects new flat implementation files while permitting entrypoints and tests", () => {
    expect(misplacedModule("application/workspace-read.ts")).toBe(true);
    expect(misplacedModule("application/workspace/read.ts")).toBe(false);
    expect(misplacedModule("providers/index.ts")).toBe(false);
    expect(misplacedModule("application/integrated-lifecycle.test.ts")).toBe(false);
  });

  test("keeps product implementations under their capability", async () => {
    const misplaced: string[] = [];
    for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: ROOT })) {
      if (misplacedModule(path.replaceAll("\\", "/"))) misplaced.push(path);
    }
    expect(misplaced).toEqual([]);
    expect(await Bun.file(`${ROOT}/domain/index.ts`).exists()).toBe(false);
    expect(await Bun.file(`${ROOT}/application/index.ts`).exists()).toBe(false);
  });

  test("detects host composition in an application module", () => {
    expect(
      outwardApplicationImports(
        "application/authentication/credentials.ts",
        'import { createKeychainCredentialStore } from "../../integrations/index.ts";',
      ),
    ).toEqual(["../../integrations/index.ts"]);
    expect(
      outwardApplicationImports(
        "application/authentication/credentials.ts",
        'import type { SecretResolverPort } from "../../domain/security/index.ts";',
      ),
    ).toEqual([]);
  });

  test("keeps host composition out of application actions", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("application/**/*.ts").scan({ cwd: ROOT })) {
      if (!isProduct(path)) continue;
      const source = (await readFile(resolve(ROOT, path), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const imported of outwardApplicationImports(path, source)) {
        offenders.push(`${path}: ${imported}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
