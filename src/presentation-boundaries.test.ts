/**
 * Negative controls over the shared-projection area.
 *
 * Like `src/cli-boundaries.test.ts`, `src/sqlite-boundaries.test.ts`, and
 * `src/tui/tui-boundaries.test.ts`, these assert absences. The area is new, so
 * it is worth being explicit about what it is *for*: a projection both the
 * terminal interface and the headless renderers can consume, which only works
 * if it is downstream of neither.
 *
 * The controls fall into three groups.
 *
 * **Direction.** This area imports from `src/domain/` and nowhere else. A
 * transcript that could reach a renderer would be a transcript that could only
 * be tested with a terminal attached, and one that could reach the database
 * would be a second read model over sessions.
 *
 * **Purity.** No clock, no randomness, no ambient state. This is the property
 * that makes rebuilding a transcript produce the same transcript rather than a
 * second, differently-informed one — and it is the one that would be broken by
 * a single innocent `Date.now()` in a summary.
 *
 * **No second answers.** The escaping rule, the outcome vocabulary, and the
 * session read model all already have owners. A copy here would be a copy that
 * disagrees with the original the first time either changes.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXPANSION_ROUTES } from "./presentation/index.ts";
import { expansionRoutesFor } from "./presentation/transcript/blocks.ts";
import { everyBlockKind } from "./presentation/transcript/fixtures.ts";

const SOURCE_ROOT = dirname(import.meta.path);
const AREA = join(SOURCE_ROOT, "presentation");

async function areaFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: AREA })) {
    files.push(entry);
  }
  return files.sort();
}

function isProduct(file: string): boolean {
  return !/\.test\.ts$/.test(file) && !/fixtures\.ts$/.test(file);
}

async function readCode(file: string): Promise<string> {
  // Comments stripped, for the reason the sibling controls state: these modules
  // have every reason to *name* a forbidden token in prose, and explaining why
  // they do not call it is the point.
  return (await readFile(join(AREA, file), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

async function productFiles(): Promise<readonly string[]> {
  return (await areaFiles()).filter(isProduct);
}

/**
 * Every file in the area, fixtures and tests included.
 *
 * This control lives one directory up rather than inside the area, so unlike
 * its sibling controls it does not have to exclude itself from the tokens it
 * forbids.
 */
async function everyFile(): Promise<readonly string[]> {
  return areaFiles();
}

describe("the dependency direction", () => {
  test("imports from the domain and from nowhere else in the tree", async () => {
    // One-way and deliberate. An import of the application, data, CLI, or
    // interface area here would invert the direction the whole area exists to
    // establish.
    for (const file of await everyFile()) {
      const source = await readCode(file);
      for (const match of source.matchAll(/from "(\.\.\/[^"]+)"/g)) {
        const target = match[1] ?? "";
        expect({ file, target, allowed: /^(\.\.\/)+domain\//.test(target) }).toEqual({
          file,
          target,
          allowed: true,
        });
      }
    }
  });

  test("names no renderer and no React", async () => {
    // Including in the fixtures. A fixture that imported a renderer would make
    // every consumer of the corpus need a terminal.
    for (const file of await everyFile()) {
      const source = await readCode(file);
      expect({ file, opentui: /from "@opentui\//.test(source) }).toEqual({ file, opentui: false });
      expect({ file, react: /from "react"/.test(source) }).toEqual({ file, react: false });
    }
  });

  test("opens no database, launches no process, and touches no filesystem", async () => {
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of [
        /from "bun:sqlite"/,
        /from "node:fs(\/promises)?"/,
        /from "node:child_process"/,
        /\bBun\.spawn\w*\(/,
        /\b(CREATE\s+TABLE|INSERT\s+INTO|SELECT\s+[\w*]+\s+FROM)\b/i,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("names no host standard handle and reaches no console", async () => {
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({
        file,
        handles: /\b(process\.(stdout|stderr|stdin)|Bun\.(stdout|stderr|stdin))\b/.test(source),
      }).toEqual({ file, handles: false });
      expect({
        file,
        logs: /\bconsole\.(log|info|warn|error|debug|trace|dir|table)\b/.test(source),
      }).toEqual({ file, logs: false });
    }
  });

  test("never takes the process exit for itself", async () => {
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, exits: /\bprocess\.(exit\s*\(|exitCode)/.test(source) }).toEqual({
        file,
        exits: false,
      });
    }
  });
});

describe("purity", () => {
  test("reads no clock and no randomness", async () => {
    // The property that makes a rebuild reproduce the transcript rather than
    // produce a second one. A `Date.now()` in a summary would break it silently
    // and only for the second reader.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of [
        /\bDate\.now\s*\(/,
        /\bnew\s+Date\s*\(/,
        /\bMath\.random\s*\(/,
        /\bperformance\.now\s*\(/,
        /\bcrypto\.randomUUID\s*\(/,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("reads no environment variable", async () => {
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, env: /\b(process\.env|Bun\.env)\b/.test(source) }).toEqual({
        file,
        env: false,
      });
    }
  });
});

describe("no second answers", () => {
  test("writes no escaping rule of its own", async () => {
    // The area applies the domain's sanitizer a line at a time, which is a
    // different *scope* for the same rule. A hand-rolled escape here would be a
    // different rule, and the two would disagree the first time either learned
    // about a new control character.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of [/\bcodePointAt\s*\(/, /\bcharCodeAt\s*\(/]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
    expect(await readCode("transcript/disclosure.ts")).toContain("sanitizeTerminalText");
  });

  test("declares no second outcome vocabulary", async () => {
    // `TerminalOutcome` is the runtime's. A block reports one; it does not
    // define what one is.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of ["TERMINAL_OUTCOME_KINDS =", "EFFECT_CERTAINTIES ="]) {
        expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          found: false,
        });
      }
    }
  });

  test("declares no second session read model", async () => {
    // `readSessionView` and `SessionView` are the data area's. A transcript
    // that grew its own would be two answers to what a session contains.
    for (const file of await everyFile()) {
      const source = await readCode(file);
      for (const forbidden of ["readSessionView", "SessionView"]) {
        expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          found: false,
        });
      }
    }
  });

  test("authors no colour", async () => {
    // A projection is data. A colour here could not be lowered for a
    // 16-colour terminal or removed for a monochrome one.
    for (const file of await everyFile()) {
      expect({ file, colors: /#[0-9a-fA-F]{6}\b/.test(await readCode(file)) }).toEqual({
        file,
        colors: false,
      });
    }
  });
});

describe("the expansion contract", () => {
  test("declares no route that nothing produces", async () => {
    // #351 in this area's terms. A route that is exported, typed, and never
    // returned is not a contract, it is a comment that compiles — and the
    // transcript surface would wire a command to it that nothing reaches.
    const produced = new Set(everyBlockKind().flatMap((block) => expansionRoutesFor(block)));
    expect([...produced].sort()).toEqual([...EXPANSION_ROUTES].sort());
  });
});
