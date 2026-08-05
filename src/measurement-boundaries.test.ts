/**
 * Negative controls over the measurement shape.
 *
 * `./measurement-fixtures.ts` says of itself that it ships in no build and that
 * only measurement checks import it. Both were true when it was written and
 * neither was asserted, which is the difference between a guarantee and a
 * comment — and this repository has already paid for that difference once, in
 * the settle predicate that was corrected in one file while eight others went
 * on using the old rule.
 *
 * The area-scoped boundary files exempt a `-fixtures` module by name or by
 * pattern and then hold it to a control: `src/tui/tui-boundaries.test.ts` does
 * exactly that for the harness and for the pseudo-terminal. This module sits at
 * the root of `src/` rather than inside an area, so it falls outside every one
 * of them. These two controls are the ones it would have had.
 *
 * The reason it matters is not tidiness. `measurement-fixtures.ts` is reached
 * from `src/data/measurement.test.ts` and `src/tui/measurement.test.tsx`, and
 * the second of those pulls in a pseudo-terminal, a compiled executable, and
 * OpenTUI's test renderer. A product module importing the report shape would
 * put the first edge of that graph onto a real run.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);

/** The measurement report shape: test support, and it ships in nothing. */
const SHAPE = "measurement-fixtures.ts";

/** This control file names the module it governs, so it excludes itself. */
const SELF = "measurement-boundaries.test.ts";

async function sourceFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: SOURCE_ROOT })) {
    files.push(entry);
  }
  return files.sort();
}

/** Comments stripped, because a module has every reason to name this one in prose. */
async function readCode(file: string): Promise<string> {
  return (await readFile(join(SOURCE_ROOT, file), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

/** Files that are neither tests nor fixtures — the ones that ship. */
function isProduct(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/fixtures\.tsx?$/.test(file);
}

describe("the measurement report shape", () => {
  test("is loaded by checks and by nothing that ships", async () => {
    const files = (await sourceFiles()).filter(isProduct);
    // A control that walks an empty list passes against anything.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file, imports: (await readCode(file)).includes(SHAPE) }).toEqual({
        file,
        imports: false,
      });
    }
  });

  test("is where every measured quantity is reported from", async () => {
    // Named, so a third file that prints its own timing without a platform line
    // shows up here as a difference. The five qualifiers a performance number
    // has to carry are a contract, and a second copy of them is a second
    // opinion about what a result is.
    const consumers: string[] = [];
    for (const file of await sourceFiles()) {
      if (file !== SELF && file !== SHAPE && (await readCode(file)).includes(SHAPE)) {
        consumers.push(file);
      }
    }
    expect(consumers.toSorted()).toEqual(["data/measurement.test.ts", "tui/measurement.test.tsx"]);
  });

  test("declares the gate once, so an ungated measurement cannot exist", async () => {
    // `FALRYN_MEASURE` read anywhere else would be a second answer to whether
    // this run is measuring — and the failure that follows is a measurement
    // that runs during `bun run check` because one file's idea of the gate
    // drifted from the other's.
    //
    // The *read* rather than the name: both measurement files put the variable
    // in a skip notice, so that a run with the gate unset says which command
    // sets it. Matching the word would have failed against a file naming the
    // gate correctly, which is the control being wrong about its own subject.
    const readers: string[] = [];
    for (const file of await sourceFiles()) {
      if (file !== SELF && /process\.env\.FALRYN_MEASURE/.test(await readCode(file))) {
        readers.push(file);
      }
    }
    expect(readers).toEqual([SHAPE]);
  });
});
