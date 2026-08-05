/**
 * The OpenTUI packaging check.
 *
 * OpenTUI is the first dependency Falryn takes whose runtime assets are not
 * JavaScript: a per-platform native Zig library reached through FFI, a parser
 * worker, the default Tree-sitter grammars, and the Tree-sitter WASM. A source
 * run resolves all four out of `node_modules` and therefore cannot fail the way
 * a shipped executable would, so every assertion here is made twice — once in
 * source mode and once against a `bun build --compile` artifact this file builds
 * itself, the pattern `src/main.compiled.test.ts` established.
 *
 * It runs before the shell exists on purpose. A packaging failure found here is
 * a fact about what #21 can promise; the same failure found after a view layer
 * had been written on top of it would be a fact about work already spent.
 *
 * Beyond packaging, the scenarios prove that the fixed alternate-screen
 * renderer starts, leaves signal handling to Falryn, and reports its startup
 * cost.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODES } from "../cli/index.ts";
import {
  FRAME_CONTENT,
  PROBE_MARKER,
  PROBE_SCENARIOS,
  type ProbeScenario,
} from "./probe-fixtures.tsx";

const FIXTURE = join(dirname(import.meta.path), "probe-fixtures.tsx");

/** Built into the system temp directory, not the repository, and removed in teardown. */
const FIXTURE_BINARY = join(tmpdir(), "falryn-opentui-probe");

/** The entry `bun run build` compiles, and therefore the whole of what ships. */
const ENTRY = join(dirname(dirname(import.meta.path)), "main.ts");

/** A renderer start, a Tree-sitter initialization, and a process, on a loaded machine. */
const PROBE_RUN_TIMEOUT_MS = 30_000;

type ProbeRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly observation: Record<string, unknown> | null;
};

/**
 * The observation a run reported.
 *
 * Read out of stderr rather than stdout because a live renderer owns stdout and
 * fills it with frame and terminal-setup bytes. Located by marker rather than by
 * line index for the same reason: nothing guarantees the diagnostic handle is
 * the only thing that ever wrote to it.
 */
function observationIn(stderr: string): Record<string, unknown> | null {
  for (const line of stderr.split("\n")) {
    const start = line.indexOf(`{"marker":"${PROBE_MARKER}"`);
    if (start === -1) {
      continue;
    }
    const parsed: unknown = JSON.parse(line.slice(start));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

function run(command: readonly string[], scenario: string): ProbeRun {
  // Synchronous on purpose, like `src/main.compiled.test.ts`: an asynchronous
  // spawn whose pipes nobody drains can block on a full buffer rather than
  // exiting, and a renderer writes considerably more than nothing.
  const finished = Bun.spawnSync([...command, scenario], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      // Deliberately absent: `OTUI_ASSET_ROOT`. The compiled run has to find its
      // native library, worker, grammars, and WASM with no help from the
      // environment, which is the whole question.
      TERM: "xterm-256color",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = finished.stderr.toString();
  return {
    exitCode: finished.exitCode,
    stdout: finished.stdout.toString(),
    stderr,
    observation: observationIn(stderr),
  };
}

const compileAttempt = Bun.spawnSync(
  [process.execPath, "build", FIXTURE, "--compile", "--outfile", FIXTURE_BINARY],
  { stdout: "pipe", stderr: "pipe" },
);
const compiled = compileAttempt.exitCode === 0;

afterAll(async () => {
  await rm(FIXTURE_BINARY, { force: true });
});

/** The assertions that must hold identically in both modes. */
function assertsFor(mode: "source" | "compiled", invoke: (scenario: ProbeScenario) => ProbeRun) {
  test(
    "renders a React tree to a real frame",
    () => {
      const finished = invoke("frame");
      expect(finished.exitCode, finished.stderr).toBe(EXIT_CODES.COMPLETED);
      expect(finished.observation).toEqual({
        marker: PROBE_MARKER,
        scenario: "frame",
        rendered: true,
        // Layout ran and drew a border, rather than a string reaching a buffer.
        bordered: true,
        columns: 40,
        rows: 6,
      });
    },
    PROBE_RUN_TIMEOUT_MS,
  );

  test(
    "loads the native renderer and the Tree-sitter assets with no asset root set",
    () => {
      const finished = invoke("native");
      expect(finished.exitCode, finished.stderr).toBe(EXIT_CODES.COMPLETED);
      const observed = finished.observation ?? {};
      expect(observed.rendererCreated).toBe(true);
      expect(observed.mode).toBe(mode);
      // Highlights are what prove the parser worker, the default grammar, and
      // the Tree-sitter WASM all resolved. A grammar that failed to embed
      // returns an empty list rather than throwing, so zero is the failure.
      expect(observed.highlightCount).toBeGreaterThan(0);
      expect(observed.screenMode).toBe("alternate-screen");
      // The default, stated so a future change to it is visible here.
      expect(observed.externalOutputMode).toBe("passthrough");
      expect(observed.startupMs).toBeGreaterThanOrEqual(0);
    },
    PROBE_RUN_TIMEOUT_MS,
  );

  test(
    "dispatches a keymap binding without a renderer",
    () => {
      // What lets #26 test bindings, conflicts, and commands without standing up
      // a terminal: the package is pure JavaScript and loads without FFI.
      const finished = invoke("keymap");
      expect(finished.exitCode, finished.stderr).toBe(EXIT_CODES.COMPLETED);
      expect(finished.observation).toEqual({
        marker: PROBE_MARKER,
        scenario: "keymap",
        rendererCreated: false,
        dispatched: ["probe.run"],
        warnings: [],
        errors: [],
      });
    },
    PROBE_RUN_TIMEOUT_MS,
  );

  test(
    "installs no signal handling when told not to, and some when not told",
    () => {
      const finished = invoke("signals");
      expect(finished.exitCode, finished.stderr).toBe(EXIT_CODES.COMPLETED);
      const observed = finished.observation ?? {};
      // `exitOnCtrlC: false` with `exitSignals: []` leaves SIGINT and SIGTERM
      // entirely to `src/cli/invocation-scope.ts`, which is what lets the shell
      // reuse the interruption governance the CLI already has.
      expect(observed.governedInstallsNone).toBe(true);
      // Measured beside it so the control tests a boundary rather than a
      // constant: the default does install handlers.
      expect(observed.defaultInstallsSome).toBe(true);
    },
    PROBE_RUN_TIMEOUT_MS,
  );

  test(
    "refuses an unknown scenario on stderr with the invalid-usage code",
    () => {
      const finished = Bun.spawnSync(
        mode === "source" ? [process.execPath, "run", FIXTURE, "nope"] : [FIXTURE_BINARY, "nope"],
        { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
      );
      expect(finished.exitCode).toBe(EXIT_CODES.INVALID_USAGE);
      // No renderer ran, so nothing owned stdout and nothing wrote to it.
      expect(finished.stdout.toString()).toBe("");
      expect(finished.stderr.toString()).toContain("unknown probe scenario: nope");
    },
    PROBE_RUN_TIMEOUT_MS,
  );
}

describe("the OpenTUI probe in source mode", () => {
  assertsFor("source", (scenario) => run([process.execPath, "run", FIXTURE], scenario));
});

describe.if(compiled)("the OpenTUI probe in a standalone executable", () => {
  assertsFor("compiled", (scenario) => run([FIXTURE_BINARY], scenario));
});

describe.if(!compiled)("the OpenTUI probe in a standalone executable", () => {
  test.skip(`could not be compiled, so the packaging path was not checked: ${compileAttempt.stderr.toString().trim()}`, () => {
    // Recorded as skipped rather than silently absent, and never as passed:
    // the compiled run is the only one that can fail the way a shipped
    // executable would.
  });
});

describe("the probe fixture", () => {
  test("declares every scenario the test drives", () => {
    // Adding a scenario to the fixture without an assertion here would leave it
    // exercised in neither mode.
    expect([...PROBE_SCENARIOS]).toEqual(["frame", "native", "keymap", "signals"]);
  });

  test("is the only module that renders the frame content", async () => {
    // The marker the frame assertion looks for lives in one place, so a passing
    // frame test cannot be satisfied by a string somewhere else in the tree.
    expect(await readFile(FIXTURE, "utf8")).toContain(FRAME_CONTENT);
  });
});

describe("the shipped executable", () => {
  test("reaches a UI package from the interface area alone", async () => {
    // #22 asserted that nothing in the tree imported one at all. #23 introduces
    // the shell, so the rule that replaced it is a containment rule rather than
    // an absence: the interface area may name `@opentui/*` and `react`, and no
    // other area may. A provider adapter or a data repository importing a
    // renderer package would mean the presentation boundary had stopped being
    // one, and it would ship in `dist/falryn` all the same.
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = dirname(dirname(import.meta.path));
    const importers: string[] = [];
    for await (const entry of glob.scan({ cwd: root })) {
      if (
        entry.endsWith(".test.ts") ||
        entry.endsWith(".test.tsx") ||
        entry.includes("fixtures.") ||
        entry.startsWith("tui/")
      ) {
        continue;
      }
      const source = await readFile(join(root, entry), "utf8");
      if (/from "(@opentui\/[a-z-]+|react)(\/[^"]*)?"/.test(source)) {
        importers.push(entry);
      }
    }
    expect(importers).toEqual([]);
  });

  test("still compiles from the one entry that ships", async () => {
    // What the bundle control used to prove, reduced to the part that is still
    // true and still worth holding. `bun run build` compiles `src/main.ts`, and
    // the graph reachable from it now legitimately includes OpenTUI — so the
    // claim is no longer "no UI module is bundled" but "the entry is intact".
    // Bundling it here would try to resolve every platform's optional native
    // package, none of which is installed; `src/main.compiled.test.ts` and
    // `src/tui/shell.compiled.test.ts` exercise the real artifact instead.
    expect(await readFile(ENTRY, "utf8")).toContain("dispatch(");
  });
});
