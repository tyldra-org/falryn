/**
 * Negative controls for the providers source area.
 *
 * Providers may depend on `src/domain/` only. They must not pull in CLI, TUI,
 * presentation, data/SQLite, config composition, or vendor SDKs — those would
 * make the normalized contract a second copy of someone else's types.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);
const AREA = join(SOURCE_ROOT, "providers");

async function areaFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: AREA })) {
    files.push(entry);
  }
  return files.sort();
}

function isProduct(file: string): boolean {
  return !/\.test\.tsx?$/.test(file);
}

function isInside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function readCode(file: string): Promise<string> {
  return (await readFile(join(AREA, file), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

describe("providers source-area boundaries", () => {
  test("product modules import only domain (and sibling providers) relatives", async () => {
    const offenders: string[] = [];
    for (const file of (await areaFiles()).filter(isProduct)) {
      const code = await readCode(file);
      for (const match of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier === undefined) {
          continue;
        }
        if (specifier === "zod") {
          continue;
        }
        if (specifier.startsWith(".")) {
          const imported = resolve(dirname(join(AREA, file)), specifier);
          if (isInside(AREA, imported) || isInside(join(SOURCE_ROOT, "domain"), imported)) {
            continue;
          }
        }
        offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("product modules do not name forbidden runtime technologies", async () => {
    const forbidden = [
      /from\s+["']yargs/,
      /from\s+["']react/,
      /from\s+["']@opentui/,
      /from\s+["']bun:sqlite/,
      /from\s+["']openai/,
      /from\s+["']@anthropic/,
      /from\s+["']@google/,
    ];
    const offenders: string[] = [];
    for (const file of (await areaFiles()).filter(isProduct)) {
      const code = await readCode(file);
      for (const pattern of forbidden) {
        if (pattern.test(code)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("domain product modules do not import providers", async () => {
    const domain = join(SOURCE_ROOT, "domain");
    const glob = new Bun.Glob("**/*.ts");
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: domain })) {
      if (/\.test\.ts$/.test(file) || /fixtures\.ts$/.test(file)) {
        continue;
      }
      const code = await readFile(join(domain, file), "utf8");
      if (/from\s+["'][^"']*providers/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
