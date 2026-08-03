/**
 * Negative controls over the interface area.
 *
 * Like `src/cli-boundaries.test.ts` and `src/sqlite-boundaries.test.ts`, these
 * assert absences. Every one of them guards something that would work perfectly
 * on the day it was written and would remove a guarantee the area exists to
 * provide: that the interface adapts intent rather than doing the work itself,
 * that it never takes the process's exit for itself, and — the one that is
 * easiest to break by accident — that a run which will never open a shell does
 * not load a native renderer to discover that.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const AREA = dirname(import.meta.path);
const SOURCE_ROOT = dirname(AREA);

/** This control file names every forbidden token, so it excludes itself. */
const SELF = "tui-boundaries.test.ts";

/** The pure entrypoint: decisions only, and nothing that loads a renderer. */
const ENTRYPOINT = "index.ts";

/** The modules allowed to reach OpenTUI's runtime. */
const RENDERER_OWNERS = ["renderer-session.ts", "shell.tsx"];

/** The seam in the CLI that launches the shell. */
const LAUNCH_SEAM = "cli/dispatch.ts";

async function areaFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("*.{ts,tsx}");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: AREA })) {
    files.push(entry);
  }
  return files.sort();
}

/** Files that are neither tests nor fixtures — the ones that ship. */
function isProduct(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/fixtures\.tsx?$/.test(file);
}

async function readCode(file: string): Promise<string> {
  // Comments stripped, for the reason `src/cli-boundaries.test.ts` states: these
  // modules have every reason to *name* a forbidden token in prose, and
  // explaining why they do not call it is the point.
  return (await readFile(join(AREA, file), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

async function productFiles(): Promise<readonly string[]> {
  return (await areaFiles()).filter((file) => isProduct(file) && file !== SELF);
}

/**
 * A file with every type-only import and export removed.
 *
 * `import type` and `export type` are erased under `verbatimModuleSyntax`, so
 * they put nothing on the module graph and cost nothing to load. The controls
 * below are about what a run *executes*, so naming a renderer's types has to
 * read as what it is — free — while importing its values does not.
 */
function withoutTypeImports(source: string): string {
  return source.replaceAll(/\b(?:import|export)\s+type\s[\s\S]*?from\s+"[^"]*";/g, "");
}

async function readValues(file: string): Promise<string> {
  return withoutTypeImports(await readCode(file));
}

describe("the cost of not launching", () => {
  test("keeps every OpenTUI runtime import out of the entrypoint's graph", async () => {
    // The load-bearing control of this whole area. `src/cli/dispatch.ts` imports
    // `src/tui/index.ts` on every invocation, so anything that entrypoint pulls
    // in is paid for by `falryn config show --format json` in a container with
    // no terminal. A value import of `@opentui/core` here would make that run
    // load a native Zig library through FFI to answer a question about a
    // settings file — and would break outright on a platform with no prebuilt
    // binary, for a capability the run never asked for.
    const reachable = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (reachable.has(file)) {
        return;
      }
      reachable.add(file);
      // Type-only edges are not followed: they are erased before anything runs,
      // so a module reached only through one is never loaded at all.
      const source = await readValues(file);
      for (const match of source.matchAll(/from "\.\/([\w-]+\.tsx?)"/g)) {
        const target = match[1];
        if (target !== undefined) {
          await visit(target);
        }
      }
    };
    await visit(ENTRYPOINT);

    for (const file of reachable) {
      const source = await readValues(file);
      expect({ file, imports: /from "@opentui\//.test(source) }).toEqual({
        file,
        imports: false,
      });
      expect({ file, imports: /from "react"/.test(source) }).toEqual({ file, imports: false });
      // No JSX either, and this is not redundant with the two above: the
      // `jsxImportSource` pragma makes every `.tsx` file import
      // `@opentui/react/jsx-runtime` in its *emitted* output, with nothing in
      // the source naming it. A component reachable from this entrypoint would
      // load the reconciler on a run that never renders anything.
      expect({ file, jsx: file.endsWith(".tsx") }).toEqual({ file, jsx: false });
    }
  });

  test("reaches the shell from the CLI only through a dynamic import", async () => {
    // A static `import { runShell } from "../tui/shell.tsx"` would put the whole
    // renderer on the module graph of every invocation and undo the control
    // above without touching this area at all.
    const seam = (await readFile(join(SOURCE_ROOT, LAUNCH_SEAM), "utf8"))
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/[^\n]*/g, "");
    expect(seam).toContain('await import("../tui/shell.tsx")');
    expect(seam).not.toMatch(/^import\s[^;]*from "\.\.\/tui\/(?!index\.ts)/m);
  });

  test("names the renderer's runtime in the modules that own it, and no others", async () => {
    for (const file of await productFiles()) {
      const owns = RENDERER_OWNERS.includes(file);
      expect({ file, imports: /from "@opentui\//.test(await readValues(file)) }).toEqual({
        file,
        imports: owns,
      });
    }
  });
});

describe("the interface area", () => {
  test("never takes the process exit for itself", async () => {
    // Interface code skipping cleanup to exit sooner is how a user's terminal is
    // left in raw mode with the alternate screen up. The status is resolved by
    // the one table and the loop is allowed to drain.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, exits: /\bprocess\.exit\s*\(/.test(source) }).toEqual({ file, exits: false });
      expect({ file, sets: /\bprocess\.exitCode\b/.test(source) }).toEqual({ file, sets: false });
    }
  });

  test("names no host standard handle", async () => {
    // `src/integrations/host-terminal.ts` owns them. The renderer is handed the
    // handles by OpenTUI itself; a module here reaching for one directly would
    // be a second owner of what stdout carries.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({
        file,
        handles: /\b(process\.(stdout|stderr|stdin)|Bun\.(stdout|stderr|stdin))\b/.test(source),
      }).toEqual({ file, handles: false });
    }
  });

  test("reaches no console method", async () => {
    for (const file of await productFiles()) {
      expect({
        file,
        logs: /\bconsole\.(log|info|warn|error|debug|trace|dir|table)\b/.test(await readCode(file)),
      }).toEqual({ file, logs: false });
    }
  });

  test("opens no database, launches no process, and touches no filesystem", async () => {
    // The ownership boundary, asserted rather than described. A view model
    // arrives; the work behind it happens somewhere else.
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

  test("writes no exit table and no escape sequence of its own", async () => {
    // Two owners already exist: `src/cli/exit.ts` picks the number, and
    // `src/cli/render-human.ts` is the one module entitled to emit an escape.
    // OpenTUI's `destroy()` owns every sequence this area needs.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, table: source.includes("EXIT_CODES = ") }).toEqual({ file, table: false });
      expect({ file, escapes: source.includes("\\u001b[") }).toEqual({ file, escapes: false });
    }
  });

  test("recomputes no terminal capability the domain already derives", async () => {
    // The record extends the domain's facts. A colour or symbol derivation here
    // would be a second answer to whether this terminal can draw a character.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of ["function colorLevelFor", "function symbolSupportFor", "NO_COLOR"]) {
        expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          found: false,
        });
      }
    }
  });

  test("substitutes no width for a terminal that reports none", async () => {
    // The failure this guards is `columns ?? 80`. A terminal that reports
    // nothing is not a narrow terminal.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, substituted: /\b(columns|rows)[^\n]*\?\?\s*[1-9]/.test(source) }).toEqual({
        file,
        substituted: false,
      });
    }
  });

  test("registers exactly one participant for restore-terminal", async () => {
    // A second one would be a second answer to whether the terminal was given
    // back, and the two would disagree on the escalated-interrupt path.
    const owners: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes('phase: "restore-terminal"')) {
        owners.push(file);
      }
    }
    expect(owners).toEqual(["shutdown.ts"]);
  });
});
