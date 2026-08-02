/**
 * Negative controls over the process boundary.
 *
 * Like `src/sqlite-boundaries.test.ts`, these assert absences, which is the only
 * way to keep a boundary that costs nothing to cross by accident. A
 * `console.log` in a service, a `process.stdout.write` in a renderer, or a
 * `process.exit()` in an error path would each work perfectly on the day it was
 * written, and would each remove a guarantee the whole area exists to provide:
 * that stdout carries only the result, that buffered output is flushed before
 * the process ends, and that one owner picks the exit code.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);

/** The one module allowed to name a host standard handle. */
const HANDLE_ADAPTER = "integrations/host-terminal.ts";

/** The one module that decides which handle carries what. */
const STREAM_OWNER = "cli/streams.ts";

/** The one module that assigns a numeric exit code. */
const EXIT_OWNER = "cli/exit.ts";

/** The composition root, and the only product module that sets an exit status. */
const COMPOSITION_ROOT = "main.ts";

/** This control file names every forbidden token, so it excludes itself. */
const SELF = "cli-boundaries.test.ts";

/**
 * The scenario harness.
 *
 * Not product — it ships in no build — but held to the same rules anyway,
 * because a harness that reached a handle directly would prove nothing about
 * the boundary it exists to exercise.
 */
const HARNESS = "cli/probe-fixtures.ts";

async function sourceFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: SOURCE_ROOT })) {
    files.push(entry);
  }
  return files.sort();
}

async function readSource(file: string): Promise<string> {
  return readFile(`${SOURCE_ROOT}/${file}`, "utf8");
}

/**
 * A file with its comments removed.
 *
 * These controls forbid tokens that the modules they govern have every reason
 * to *name in prose* — `src/main.ts` explains why it does not call
 * `process.exit()`, and explaining it is the point. Matching against code only
 * keeps the control about behavior rather than about wording.
 */
async function readCode(file: string): Promise<string> {
  return (await readSource(file)).replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
}

/** Files that are neither tests nor fixtures — the ones that ship. */
function isProduct(file: string): boolean {
  return !file.endsWith(".test.ts") && !file.endsWith("fixtures.ts");
}

/** Everything held to the boundary's rules: what ships, plus the harness. */
function isGoverned(file: string): boolean {
  return isProduct(file) || file === HARNESS;
}

async function offenders(
  pattern: RegExp,
  allowed: readonly string[],
  scope: (file: string) => boolean = isGoverned,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles()) {
    if (!scope(file) || file === SELF || allowed.includes(file)) {
      continue;
    }
    if (pattern.test(await readCode(file))) {
      found.push(file);
    }
  }
  return found;
}

describe("a host standard handle", () => {
  const HANDLES = /\b(process\.(stdout|stderr|stdin)|Bun\.(stdout|stderr|stdin))\b/;

  test("is named only in the adapter that owns it", async () => {
    // A second module holding a handle would be a second answer to what stdout
    // carries, what gets flushed, and what happens when the reader leaves.
    expect(await offenders(HANDLES, [HANDLE_ADAPTER])).toEqual([]);
  });

  test("is named in that adapter, so this control is testing something", async () => {
    expect(HANDLES.test(await readSource(HANDLE_ADAPTER))).toBe(true);
  });

  test("is reached by product code only through the stream owner", async () => {
    // The adapter builds the ports; this module decides which port carries the
    // result and which carries the diagnostics.
    // `integrations/index.ts` is the layer's entrypoint and re-exports the
    // factory; re-exporting is not composing.
    expect(await offenders(/\bcreateHostOutputStream\(/, [HANDLE_ADAPTER, STREAM_OWNER])).toEqual(
      [],
    );
    expect(await readSource(STREAM_OWNER)).toContain("createHostOutputStream");
  });
});

describe("diagnostic text", () => {
  test("never reaches a console method, on any path", async () => {
    // `console.log` writes to stdout behind the boundary's back: it is not
    // bounded, not flushed with everything else, and not visible to the control
    // above. A single one would put a notice into a consumer's parsed result.
    expect(await offenders(/\bconsole\.(log|info|warn|error|debug|trace|dir|table)\b/, [])).toEqual(
      [],
    );
  });
});

describe("the process exit", () => {
  test("is never taken by calling process.exit()", async () => {
    // `process.exit()` abandons whatever the loop was draining, which is
    // exactly the buffered output the flush contract exists to deliver. The
    // status is set and the loop is allowed to finish.
    expect(await offenders(/\bprocess\.exit\s*\(/, [])).toEqual([]);
  });

  test("is set in the composition root and the harness, and nowhere else", async () => {
    const setters = await offenders(/\bprocess\.exitCode\b/, [COMPOSITION_ROOT, HARNESS]);
    expect(setters).toEqual([]);
    expect(await readSource(COMPOSITION_ROOT)).toContain("process.exitCode");
  });

  test("resolves through the one table", async () => {
    // A second table would be a second published contract, and the numbers in
    // it would drift the first time one of them changed.
    const tables: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isGoverned(file) || file === SELF) {
        continue;
      }
      if ((await readSource(file)).includes("export const EXIT_CODES")) {
        tables.push(file);
      }
    }
    expect(tables).toEqual([EXIT_OWNER]);
  });

  test("is never written as a bare number in the composition root", async () => {
    const source = await readSource(COMPOSITION_ROOT);
    const assignment = source.slice(source.indexOf("process.exitCode"));
    // `process.exitCode = ... ? 0 : 1` is what this replaced. A literal here
    // would be the CLI's published contract restated by a module that does not
    // own it.
    expect(assignment).not.toMatch(/process\.exitCode\s*=\s*\d/);
  });
});

describe("the stream ports", () => {
  test("are declared exactly once each", async () => {
    const outputs: string[] = [];
    const inputs: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF) {
        continue;
      }
      const source = await readSource(file);
      if (source.includes("OutputStreamPort = {")) {
        outputs.push(file);
      }
      if (source.includes("InputStreamPort = {")) {
        inputs.push(file);
      }
    }
    expect(outputs).toEqual(["domain/terminal.ts"]);
    expect(inputs).toEqual(["domain/terminal.ts"]);
  });

  test("keep their in-memory doubles in the domain, as doubles", async () => {
    // Neither deleted nor promoted to a fallback: they are what lets everything
    // above the boundary be tested without a handle.
    const source = await readSource("domain/terminal.ts");
    expect(source).toContain("export function createRecordingOutputStream");
    expect(source).toContain("export function createStaticInputStream");
  });
});

describe("terminal capability", () => {
  test("is derived in one place, from the environment port", async () => {
    const derivers: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF) {
        continue;
      }
      if ((await readSource(file)).includes("export function colorLevelFor")) {
        derivers.push(file);
      }
    }
    expect(derivers).toEqual(["domain/terminal.ts"]);
  });

  test("substitutes no width for a handle that reports none", async () => {
    const source = await readSource("domain/terminal.ts");
    // The failure this guards: `columns ?? 80`. A non-TTY treated as a narrow
    // terminal makes every layout decision taken from it wrong.
    expect(source).not.toMatch(/columns[^\n]*\?\?\s*\d/);
    expect(await readSource(HANDLE_ADAPTER)).not.toMatch(/columns[^\n]*\?\?\s*\d/);
  });
});

describe("the CLI area", () => {
  test("is reached through its entrypoint, not by deep import", async () => {
    const deep: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isGoverned(file) || file === SELF || file.startsWith("cli/")) {
        continue;
      }
      if (/from "\.\/cli\/(?!index\.ts)/.test(await readSource(file))) {
        deep.push(file);
      }
    }
    expect(deep).toEqual([]);
  });

  test("owns no command, option, or output format yet", async () => {
    // The non-goals, asserted rather than remembered. Parsing is #17's and
    // rendering is #18's and #19's; this area moves bytes and picks a number.
    for (const file of ["cli/exit.ts", "cli/streams.ts", "cli/index.ts"]) {
      const source = await readSource(file);
      expect(source).not.toMatch(/\b(yargs|hideBin|commandDir)\b/);
    }
  });
});
