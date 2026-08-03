/**
 * The process boundary, measured on real processes.
 *
 * Every claim this area makes is about a *process*: what it exits with, what
 * reaches its stdout, whether it survives a reader that leaves, and whether it
 * blocks on input that is not there. None of those are observable in-process,
 * so each is asserted by spawning and reading back.
 *
 * Both modes are covered, because they are the two ways Falryn runs and they do
 * not have to agree by construction: `bun run src/...` interprets, and
 * `bun build --compile` produces the standalone shape Falryn ships in. The
 * compiled half is what proves the boundary survives packaging; it compiles the
 * probe once and reuses the executable for every scenario.
 *
 * `src/cli/probe-fixtures.ts` is the entry both modes run. No command exists
 * yet, so it stands in for one — see the fixture's own note.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EMITTABLE_EXIT_CODES, EXIT_CODES, type ExitCode, UNEMITTABLE_EXIT_CODES } from "./exit.ts";
import { MAX_TIMEOUT_MS } from "./options.ts";
import { type OutcomeScenario, STREAM_RECORD_COUNT } from "./probe-fixtures.ts";
import { readCliStream } from "./schema.ts";

const PROBE_ENTRY = join(dirname(import.meta.path), "probe-fixtures.ts");

/** Bounds a hung child. The assertions are on output and status, never on elapsed time. */
const PROBE_TIMEOUT_MS = 30_000;

const temporary = await mkdtemp(join(tmpdir(), "falryn-boundary-"));
const COMPILED_PROBE = join(temporary, "falryn-probe");

const compiled = Bun.spawnSync(
  [process.execPath, "build", PROBE_ENTRY, "--compile", "--outfile", COMPILED_PROBE],
  { stdout: "pipe", stderr: "pipe" },
);

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

type Mode = { readonly name: string; readonly command: readonly string[] };

const SOURCE: Mode = { name: "source", command: [process.execPath, "run", PROBE_ENTRY] };
const COMPILED: Mode = { name: "compiled", command: [COMPILED_PROBE] };

/** A clean environment, so a developer's own shell cannot decide a capability. */
function probeEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { PATH: process.env.PATH ?? "", ...overrides };
}

type Run = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

function run(
  mode: Mode,
  scenario: string,
  options: {
    readonly stdin?: string | null;
    readonly env?: Record<string, string>;
    /** The command line a `dispatch-*` scenario runs. */
    readonly argv?: readonly string[];
  } = {},
): Run {
  // Synchronous on purpose: an asynchronous spawn whose pipes nobody drains can
  // block on a full buffer rather than exiting, which is the opposite of what
  // these assertions are about.
  const finished = Bun.spawnSync([...mode.command, scenario, ...(options.argv ?? [])], {
    env: options.env ?? probeEnvironment(),
    // `null` models a handle nothing is attached to; a string is piped input.
    stdin:
      options.stdin === undefined || options.stdin === null ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: finished.exitCode,
    stdout: finished.stdout.toString(),
    stderr: finished.stderr.toString(),
  };
}

/**
 * Spawns a scenario, waits for it to say it is ready, and interrupts it.
 *
 * Readiness is the probe's own notice rather than a delay, so the signal can
 * never arrive before the work it is meant to interrupt has begun. That is the
 * difference between testing cancellation and testing a scheduler.
 */
async function interrupt(mode: Mode, argv: readonly string[]): Promise<Run> {
  const child = Bun.spawn([...mode.command, ...argv], {
    env: probeEnvironment({ HOME: temporary, FALRYN_STATE_DIR: temporary }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const errors = child.stderr.getReader();
  const decoder = new TextDecoder();
  let notices = "";
  while (!notices.includes("ready")) {
    const chunk = await errors.read();
    if (chunk.done) {
      throw new Error(`probe exited before signalling readiness: ${notices}`);
    }
    notices += decoder.decode(chunk.value);
  }

  child.kill("SIGINT");
  const stdout = await new Response(child.stdout).text();
  // The rest of stderr, read from the same reader that watched for readiness.
  while (true) {
    const chunk = await errors.read();
    if (chunk.done) {
      break;
    }
    notices += decoder.decode(chunk.value);
  }
  await child.exited;

  return { exitCode: child.exitCode ?? -1, stdout, stderr: notices };
}

/** The two formats a consumer parses. Both must end in exactly one record. */
const MACHINE_FORMATS = ["json", "jsonl"] as const;

/**
 * Each outcome scenario, and the code it must produce on a real run.
 *
 * Total over `OutcomeScenario` rather than partial: adding a scenario to the
 * harness fails to compile here until its expected code is stated. A partial
 * map would accept the new name and silently stop asserting a code.
 */
const CODE_BY_SCENARIO: Readonly<Record<OutcomeScenario, ExitCode>> = {
  completed: EXIT_CODES.COMPLETED,
  failed: EXIT_CODES.OPERATION_FAILED,
  "invalid-input": EXIT_CODES.INVALID_USAGE,
  configuration: EXIT_CODES.CONFIGURATION,
  authentication: EXIT_CODES.AUTHENTICATION,
  integration: EXIT_CODES.UNAVAILABLE,
  uncertain: EXIT_CODES.UNCERTAIN_EFFECT,
  "cancelled-partial": EXIT_CODES.UNCERTAIN_EFFECT,
  internal: EXIT_CODES.INTERNAL,
  unrecognized: EXIT_CODES.INTERNAL,
  "timed-out": EXIT_CODES.TIMED_OUT,
  cancelled: EXIT_CODES.CANCELLED,
};

describe("the compiled probe", () => {
  test("built, so the compiled half of this file is testing something", () => {
    // A failure here is a packaging failure: `src/cli/` did not survive
    // `bun build --compile`, which is exactly the regression this file exists
    // to catch.
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
  });
});

for (const mode of [SOURCE, COMPILED]) {
  describe(`the exit table in ${mode.name} mode`, () => {
    for (const [scenario, expected] of Object.entries(CODE_BY_SCENARIO)) {
      test(
        `exits ${expected} for ${scenario}`,
        () => {
          expect(run(mode, scenario).exitCode).toBe(expected);
        },
        PROBE_TIMEOUT_MS,
      );
    }

    test(
      "produces every code this build declares reachable, and no other",
      () => {
        const produced = new Set(
          Object.keys(CODE_BY_SCENARIO).map((scenario) => run(mode, scenario).exitCode),
        );
        // The unknown-scenario path is the only remaining reachable code path
        // and it resolves through the same table.
        produced.add(run(mode, "no-such-scenario").exitCode);

        expect([...produced].sort((left, right) => left - right)).toEqual([
          ...EMITTABLE_EXIT_CODES,
        ]);
        for (const unreachable of UNEMITTABLE_EXIT_CODES) {
          // Declared so later owners attach to it. A v0.1 build emitting one
          // would be a claim about behavior that does not exist.
          expect(produced.has(unreachable)).toBe(false);
        }
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "resolves an unusable invocation to invalid usage",
      () => {
        const finished = run(mode, "no-such-scenario");
        expect(finished.exitCode).toBe(EXIT_CODES.INVALID_USAGE);
        // Even the complaint about the invocation stays off stdout.
        expect(finished.stdout).toBe("");
        expect(finished.stderr).toContain("unknown scenario");
      },
      PROBE_TIMEOUT_MS,
    );
  });

  describe(`stdout purity in ${mode.name} mode`, () => {
    test(
      "carries the result and never a diagnostic, on every scenario",
      () => {
        for (const scenario of Object.keys(CODE_BY_SCENARIO)) {
          const finished = run(mode, scenario);
          // Every stdout line parses as the selected result format. A progress
          // notice or a warning on this handle would fail here rather than in a
          // consumer's parser.
          for (const line of finished.stdout.split("\n").filter((entry) => entry.length > 0)) {
            expect(() => JSON.parse(line)).not.toThrow();
          }
          expect(finished.stderr).toContain(`scenario: ${scenario}`);
          expect(finished.stdout).not.toContain("scenario:");
        }
      },
      PROBE_TIMEOUT_MS,
    );
  });

  describe(`a reader that leaves in ${mode.name} mode`, () => {
    test(
      "ends the process normally, with no stack trace and no complaint",
      async () => {
        // The reproduction from the issue, run for real: the probe writes far
        // more records than the reader takes.
        const script = `${mode.command.map((part) => `'${part}'`).join(" ")} stream | head -1`;
        const piped = Bun.spawnSync(["/bin/sh", "-c", script], {
          env: probeEnvironment(),
          stdout: "pipe",
          stderr: "pipe",
        });

        const stderr = piped.stderr.toString();
        expect(piped.exitCode).toBe(EXIT_CODES.COMPLETED);
        expect(piped.stdout.toString().split("\n").filter(Boolean)).toHaveLength(1);
        // No stack, and nothing said about a reader that stopped listening on
        // purpose. `EPIPE` reaching the default handler would fail both.
        expect(stderr).not.toContain("EPIPE");
        expect(stderr).not.toMatch(/\bat\s+\S+:\d+:\d+/);
        expect(stderr.trim()).toBe("streaming");
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "writes every record when the reader stays",
      () => {
        const finished = run(mode, "stream");
        const lines = finished.stdout.split("\n").filter(Boolean);
        expect(lines).toHaveLength(STREAM_RECORD_COUNT + 1);
        expect(JSON.parse(lines.at(-1) ?? "{}")).toEqual({ kind: "terminal", status: "completed" });
      },
      PROBE_TIMEOUT_MS,
    );
  });

  describe(`stdin in ${mode.name} mode`, () => {
    test(
      "reads piped input to the declared encoding",
      () => {
        const finished = run(mode, "stdin", { stdin: "hello" });
        expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
        expect(JSON.parse(finished.stdout)).toMatchObject({
          stdin: "text",
          text: "hello",
          bytes: 5,
        });
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "never blocks when nothing is attached",
      () => {
        // `</dev/null`: connected, and closed with nothing. It resolves rather
        // than waiting, which is the whole defence against a headless run
        // hanging on interaction that is never coming.
        const finished = run(mode, "stdin", { stdin: null });
        expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
        expect(JSON.parse(finished.stdout)).toMatchObject({ stdin: "empty", stdinIsTty: false });
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "reports an over-bound read as invalid input rather than truncating it",
      () => {
        const finished = run(mode, "stdin", {
          stdin: "x".repeat(2 * 1024 * 1024),
        });
        expect(finished.exitCode).toBe(EXIT_CODES.INVALID_USAGE);
        expect(JSON.parse(finished.stdout)).toEqual({ stdin: "too-large" });
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "reports invalid UTF-8 as invalid input",
      () => {
        const finished = Bun.spawnSync([...mode.command, "stdin"], {
          env: probeEnvironment(),
          // A lone continuation byte: bytes that are not the declared encoding.
          stdin: Buffer.from([0x41, 0x80, 0x42]),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(finished.exitCode).toBe(EXIT_CODES.INVALID_USAGE);
        expect(JSON.parse(finished.stdout.toString())).toEqual({ stdin: "invalid-encoding" });
      },
      PROBE_TIMEOUT_MS,
    );
  });

  describe(`terminal capability in ${mode.name} mode`, () => {
    test(
      "never treats a piped stdout as a narrow terminal",
      () => {
        const finished = run(mode, "stdin", {
          stdin: null,
          env: probeEnvironment({ TERM: "xterm-256color", COLUMNS: "40" }),
        });

        // Piped: not a terminal, no size, no colour. A substituted 80 here
        // would be a width belonging to a terminal these bytes never reach.
        expect(JSON.parse(finished.stdout)).toMatchObject({
          stdoutIsTty: false,
          stdoutColumns: null,
          stdoutColor: "none",
        });
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "honours a forced colour request against a piped handle",
      () => {
        const finished = run(mode, "stdin", {
          stdin: null,
          env: probeEnvironment({ FORCE_COLOR: "3" }),
        });
        expect(JSON.parse(finished.stdout)).toMatchObject({ stdoutColor: "truecolor" });
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "refuses colour when NO_COLOR is set, whatever else asks for it",
      () => {
        const finished = run(mode, "stdin", {
          stdin: null,
          env: probeEnvironment({ NO_COLOR: "1", FORCE_COLOR: "3", TERM: "xterm-256color" }),
        });
        expect(JSON.parse(finished.stdout)).toMatchObject({ stdoutColor: "none" });
      },
      PROBE_TIMEOUT_MS,
    );
  });

  describe(`an interrupt in ${mode.name} mode`, () => {
    test(
      "requests cancellation and still emits the terminal record",
      async () => {
        const { stdout, exitCode } = await interrupt(mode, ["interrupt"]);
        const lines = stdout.split("\n").filter(Boolean);
        // Every record is whole. Cancellation lands between records, never
        // inside one, so nothing here is a truncated fragment.
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
        // Exactly one terminal record, and it is last.
        expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
          kind: "terminal",
          status: "cancelled",
        });
        expect(lines.filter((line) => line.includes(`"terminal"`))).toHaveLength(1);
        expect(exitCode).toBe(EXIT_CODES.CANCELLED);
      },
      PROBE_TIMEOUT_MS,
    );
  });

  describe(`a governed invocation in ${mode.name} mode`, () => {
    for (const format of MACHINE_FORMATS) {
      test(
        `exits ${EXIT_CODES.CANCELLED} on an interrupt and emits one terminal record as ${format}`,
        async () => {
          const { stdout, exitCode } = await interrupt(mode, [
            "dispatch-interrupt",
            "doctor",
            "--format",
            format,
          ]);
          const reading = readCliStream(stdout.split("\n"));

          // One terminal record, whatever stopped the run. A consumer waiting
          // for an answer gets one rather than a stream that simply ends.
          expect(reading.records.filter((record) => record.terminal)).toHaveLength(1);
          expect(reading.terminal?.kind).toBe("result");
          expect(reading.gaps).toEqual([]);
          expect(reading.refusals).toEqual([]);
          expect((reading.terminal as { outcome?: unknown } | null)?.outcome).toEqual({
            kind: "cancelled",
            effect: "none",
          });
          expect(exitCode).toBe(EXIT_CODES.CANCELLED);
        },
        PROBE_TIMEOUT_MS,
      );

      test(
        `exits ${EXIT_CODES.TIMED_OUT} on an expired deadline and emits one terminal record as ${format}`,
        () => {
          const finished = run(mode, "dispatch-timeout", {
            argv: ["doctor", "--timeout", "50", "--format", format],
          });
          const reading = readCliStream(finished.stdout.split("\n"));

          expect(reading.records.filter((record) => record.terminal)).toHaveLength(1);
          expect((reading.terminal as { outcome?: unknown } | null)?.outcome).toEqual({
            kind: "timed-out",
            effect: "none",
          });
          expect(finished.exitCode).toBe(EXIT_CODES.TIMED_OUT);
        },
        PROBE_TIMEOUT_MS,
      );
    }

    test(
      "exits 8 rather than 130 when the interrupted run had already changed something",
      async () => {
        // Effect certainty outranks the outcome. A consumer reading `130` may
        // retry freely; one reading `8` has to inspect first, and this run is
        // the second kind.
        const { stdout, exitCode } = await interrupt(mode, [
          "dispatch-interrupt-partial",
          "doctor",
          "--format",
          "json",
        ]);
        const terminal = readCliStream(stdout.split("\n")).terminal as {
          outcome?: unknown;
          effect?: { observed: string };
        } | null;

        expect(terminal?.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
        expect(terminal?.effect?.observed).toBe("uncertain");
        expect(exitCode).toBe(EXIT_CODES.UNCERTAIN_EFFECT);
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "keeps quiet stdout empty on a cancelled run",
      async () => {
        const { stdout, stderr, exitCode } = await interrupt(mode, [
          "dispatch-interrupt",
          "doctor",
          "--format",
          "quiet",
        ]);

        // The verdict is the exit status under quiet, and stdout carries the
        // primary result only — of which a stopped run has none.
        expect(stdout).toBe("");
        expect(stderr).toContain("ready");
        expect(exitCode).toBe(EXIT_CODES.CANCELLED);
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "leaves a run that finished within its deadline completed",
      () => {
        const finished = run(mode, "dispatch-run", {
          argv: ["doctor", "--timeout", String(MAX_TIMEOUT_MS), "--format", "json"],
        });
        const terminal = readCliStream(finished.stdout.split("\n")).terminal as {
          outcome?: unknown;
          payload?: unknown;
        } | null;

        expect(terminal?.outcome).toEqual({ kind: "completed" });
        expect(terminal?.payload).not.toBeNull();
        expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "still refuses a --timeout above the declared maximum as invalid usage",
      () => {
        const finished = run(mode, "dispatch-run", {
          argv: ["doctor", "--timeout", String(MAX_TIMEOUT_MS + 1)],
        });

        expect(finished.exitCode).toBe(EXIT_CODES.INVALID_USAGE);
        expect(finished.stdout).toBe("");
        expect(finished.stderr).toContain("timeout");
      },
      PROBE_TIMEOUT_MS,
    );

    test(
      "never waits for input, so --non-interactive is honoured",
      () => {
        // Nothing in this build prompts, and the option is carried rather than
        // consumed. What is asserted is the property it names: a run with no
        // stdin attached answers instead of blocking.
        const finished = run(mode, "dispatch-run", {
          argv: ["doctor", "--non-interactive", "--format", "json"],
          stdin: null,
        });
        expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      },
      PROBE_TIMEOUT_MS,
    );
  });
}
