/**
 * The JSON and JSON Lines projections.
 *
 * The pure-function sections cover the shapes; the last two sections run the
 * same projections through `dispatch` over real services in a temporary home,
 * because "stdout carried only records" and "the terminal record survived the
 * reader leaving" are claims about the composition rather than about a function.
 *
 * The outcome matrix is exercised against staged results, because it covers
 * every declared outcome and effect certainty — including ones no v0.1 path
 * produces. The two a CLI run now does produce, `cancelled` and `timed-out`,
 * are exercised against real runs in `src/cli/dispatch-cancellation.test.ts`
 * and against real processes in `src/cli/process-boundary.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_SCHEMA_VERSION,
  MAX_CONFIGURATION_FILE_BYTES,
  SCHEMA_VERSION_FIELD,
} from "../config/index.ts";
import {
  createStaticEnvironment,
  type EffectCertainty,
  type FalrynError,
  FIRST_SEQUENCE,
  localPath,
  NO_CORRELATION,
  type RuntimeEvent,
  TERMINAL_OUTCOME_KINDS,
  type TerminalOutcome,
  type Timestamp,
} from "../domain/index.ts";
import type { ConfigValidatePayload, DoctorPayload, RunCommandResult } from "./commands.ts";
import { dispatch } from "./dispatch.ts";
import type { GlobalOptions } from "./options.ts";
import { renderJson } from "./render-json.ts";
import { renderJsonl } from "./render-jsonl.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  READ_ONLY_EFFECT,
} from "./result.ts";
import { CLI_SCHEMA_FAMILY, MAX_CLI_RECORD_BYTES, readCliStream } from "./schema.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

/** Token-shaped text the runtime redactor recognizes. Never a real credential. */
const SECRET = "sk-live-ABCDEFGH12345678";

const AT = "2026-01-01T00:00:00.000Z" as Timestamp;

const ESCAPE = "\u001b";

/** A parsed invocation with nothing selected. Only the service graph reads it. */
const DEFAULT_OPTIONS: GlobalOptions = {
  format: "human",
  color: "auto",
  quiet: false,
  verbose: false,
  nonInteractive: false,
  workspace: null,
  addDirs: [],
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};

type ResultOverrides = {
  readonly outcome?: TerminalOutcome;
  readonly errors?: readonly FalrynError[];
};

function resultOf(payload: unknown, overrides: ResultOverrides = {}): RunCommandResult {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command: "doctor",
    outcome: overrides.outcome ?? { kind: "completed" },
    effect: READ_ONLY_EFFECT,
    payload,
    errors: overrides.errors ?? [],
    warnings: [],
    omissions: [],
    truncation: [],
    artifacts: [],
    correlation: NO_CORRELATION,
  } as unknown as RunCommandResult;
}

async function parsedJson(payload: unknown, overrides: ResultOverrides = {}) {
  const rendered = await renderJson({ result: resultOf(payload, overrides), occurredAt: AT });
  expect(rendered.result).toHaveLength(1);
  return JSON.parse(rendered.result[0] ?? "");
}

const EVENT: RuntimeEvent = {
  eventId: "event-1",
  streamId: "configuration",
  sequence: 1,
  kind: "session.started",
  schemaVersion: 1,
  minimumReaderSchemaVersion: 1,
  occurredAt: AT,
  idempotencyKey: "key-1",
  correlation: {
    workspaceId: "w",
    sessionId: "s",
    traceId: "t",
    configurationGeneration: 0,
  },
  payload: {},
} as unknown as RuntimeEvent;

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

describe("JSON", () => {
  test("emits exactly one terminal record", async () => {
    const rendered = await renderJson({ result: resultOf({ ok: true }), occurredAt: AT });
    expect(rendered.result).toHaveLength(1);
    expect(rendered.diagnostics).toBe("");
    expect(await parsedJson({ ok: true })).toMatchObject({
      schemaFamily: CLI_SCHEMA_FAMILY,
      kind: "result",
      terminal: true,
      command: "doctor",
      sequence: FIRST_SEQUENCE,
    });
  });

  test("carries the result's facts without reshaping them", async () => {
    const record = await parsedJson({ roots: ["state"] });
    expect(record.payload).toEqual({ roots: ["state"] });
    expect(record.effect).toEqual({ intent: "none", observed: "none" });
    expect(record.errors).toEqual([]);
    expect(record.artifacts).toEqual([]);
  });

  test("renders every outcome kind and every effect certainty", async () => {
    const certainties: readonly EffectCertainty[] = ["none", "completed", "partial", "uncertain"];
    const seen = new Set<string>();

    for (const kind of TERMINAL_OUTCOME_KINDS) {
      for (const effect of certainties) {
        const outcome = (
          kind === "completed"
            ? { kind }
            : kind === "uncertain"
              ? { kind, effect: "uncertain" }
              : { kind, effect }
        ) as TerminalOutcome;
        const record = await parsedJson(null, { outcome });
        expect(record.outcome).toEqual(outcome);
        seen.add(JSON.stringify(record.outcome));
      }
    }
    // `completed` carries no effect and `uncertain` pins one, so the matrix
    // collapses to the outcomes the domain can actually represent.
    expect(seen.size).toBe(1 + 3 * certainties.length + 1);
  });

  test("refuses an over-bound result with a terminal record, not a trimmed one", async () => {
    const rendered = await renderJson({
      result: resultOf({ blob: "x".repeat(MAX_CLI_RECORD_BYTES) }),
      occurredAt: AT,
    });

    expect(rendered.result).toHaveLength(1);
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record).toMatchObject({
      kind: "refusal",
      terminal: true,
      code: "record-too-large",
      artifact: null,
      artifactError: null,
      maximumBytes: MAX_CLI_RECORD_BYTES,
    });
    // Nothing of the result survived into it, so a consumer cannot mistake the
    // refusal for a partial answer.
    expect(rendered.result[0]).not.toContain("blob");
    expect(rendered.diagnostics).toContain("record-too-large");
  });

  test("spills an over-bound result and carries its handle on the refusal", async () => {
    const rendered = await renderJson({
      result: resultOf({ blob: "x".repeat(MAX_CLI_RECORD_BYTES) }),
      occurredAt: AT,
      storeOverBound: async () => ({ ok: true, artifact: { artifactId: "cli-refusal-1" } }),
    });
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record).toMatchObject({
      kind: "refusal",
      code: "record-too-large",
      artifact: { artifactId: "cli-refusal-1" },
      artifactError: null,
    });
    expect(rendered.result[0]).not.toContain("blob");
  });

  test("still refuses when the store cannot take the spill", async () => {
    const rendered = await renderJson({
      result: resultOf({ blob: "x".repeat(MAX_CLI_RECORD_BYTES) }),
      occurredAt: AT,
      storeOverBound: async () => ({ ok: false, code: "store-unavailable" }),
    });
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record).toMatchObject({
      kind: "refusal",
      code: "record-too-large",
      artifact: null,
      artifactError: "store-unavailable",
    });
    expect(rendered.diagnostics).toContain("store-unavailable");
  });

  test("copies command-produced artifact handles onto the result record", async () => {
    const result = {
      ...resultOf({ ok: true }),
      artifacts: [{ artifactId: "produced-1" }],
    } as RunCommandResult;
    const rendered = await renderJson({ result, occurredAt: AT });
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record.artifacts).toEqual([{ artifactId: "produced-1" }]);
  });

  test("still ends the run when a value cannot be encoded", async () => {
    const rendered = await renderJson({ result: resultOf({ text: "a\ud800b" }), occurredAt: AT });
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record.terminal).toBe(true);
    expect(record.code).toBe("unencodable-text");
  });
});

/* -------------------------------------------------------------------------- */
/* JSON Lines                                                                  */
/* -------------------------------------------------------------------------- */

describe("JSON Lines", () => {
  test("ends in exactly one terminal record", async () => {
    const rendered = await renderJsonl({
      result: resultOf({ ok: true }),
      occurredAt: AT,
      events: [EVENT, EVENT],
    });
    const reading = readCliStream(rendered.result);

    expect(reading.records).toHaveLength(3);
    expect(reading.records.filter((record) => record.terminal)).toHaveLength(1);
    expect(reading.terminal?.kind).toBe("result");
    expect(reading.records[reading.records.length - 1]?.terminal).toBe(true);
  });

  test("is a complete stream with no events at all", async () => {
    const reading = readCliStream(
      (await renderJsonl({ result: resultOf(null), occurredAt: AT, events: [] })).result,
    );
    expect(reading.records).toHaveLength(1);
    expect(reading.terminal?.kind).toBe("result");
  });

  test("numbers records monotonically with no gap", async () => {
    const rendered = await renderJsonl({
      result: resultOf(null),
      occurredAt: AT,
      events: [EVENT, EVENT, EVENT],
    });
    const reading = readCliStream(rendered.result);
    expect(reading.records.map((record) => Number(record.sequence))).toEqual([1, 2, 3, 4]);
    expect(reading.gaps).toEqual([]);
  });

  test("projects the runtime's own event vocabulary rather than a second one", async () => {
    const rendered = await renderJsonl({ result: resultOf(null), occurredAt: AT, events: [EVENT] });
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record.kind).toBe("event");
    expect(record.terminal).toBe(false);
    // The wire form the codec owns, carried whole.
    expect(record.event).toMatchObject({
      kind: "session.started",
      eventId: "event-1",
      schemaVersion: 1,
    });
  });

  test("emits its terminal record even when the result will not encode", async () => {
    const rendered = await renderJsonl({
      result: resultOf({ blob: "x".repeat(MAX_CLI_RECORD_BYTES) }),
      occurredAt: AT,
      events: [EVENT],
    });
    const reading = readCliStream(rendered.result);
    expect(reading.terminal?.kind).toBe("refusal");
    expect(reading.gaps).toEqual([]);
  });

  test("is byte-identical for equal inputs", async () => {
    const one = await renderJsonl({
      result: resultOf({ a: 1, b: 2 }),
      occurredAt: AT,
      events: [EVENT],
    });
    const other = await renderJsonl({
      result: resultOf({ b: 2, a: 1 }),
      occurredAt: AT,
      events: [EVENT],
    });
    expect(one.result).toEqual(other.result);
  });
});

/* -------------------------------------------------------------------------- */
/* Purity of machine output                                                    */
/* -------------------------------------------------------------------------- */

describe("machine output", () => {
  test("is valid JSON on every line", async () => {
    const rendered = await renderJsonl({
      result: resultOf({ text: "value" }),
      occurredAt: AT,
      events: [EVENT],
    });
    for (const line of rendered.result) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("holds no escape sequence, even when the result carried one", async () => {
    // A configuration value carrying ANSI reaches the record as data. What must
    // not happen is the *format* emitting one.
    const record = await parsedJson({ text: `${ESCAPE}[31mred${ESCAPE}[0m` });
    const line = (
      await renderJson({
        result: resultOf({ text: `${ESCAPE}[31mred` }),
        occurredAt: AT,
      })
    ).result[0];

    expect(record.payload.text).toContain("[31m");
    // JSON escapes it as \u001b, so the raw byte never appears on the wire.
    expect(line).not.toContain(ESCAPE);
    expect(line).toContain("\\u001b");
  });
});

/* -------------------------------------------------------------------------- */
/* Through dispatch                                                            */
/* -------------------------------------------------------------------------- */

describe("through dispatch", () => {
  const homes: string[] = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
  });

  async function run(
    argv: readonly string[],
    options: {
      readonly document?: Record<string, unknown>;
      readonly closeAfterBytes?: number;
      /** Arranges the configuration root itself, for a source that will not read. */
      readonly prepare?: (configurationRoot: string) => Promise<void>;
    } = {},
  ) {
    const home = await mkdtemp(join(tmpdir(), "falryn-machine-"));
    homes.push(home);

    const streams = createRecordingCliStreams({
      // A terminal that advertises full colour. Machine output must contain
      // none of it regardless.
      capabilities: {
        stdout: { isTty: true, columns: 120, rows: 40, color: "truecolor", symbols: "unicode" },
        stderr: { isTty: true, columns: 120, rows: 40, color: "truecolor", symbols: "unicode" },
        stdin: { isTty: false },
      },
      ...(options.closeAfterBytes === undefined
        ? {}
        : { closeResultAfterBytes: options.closeAfterBytes }),
    });

    const services = (globals: GlobalOptions) =>
      createServiceProvider(globals, {
        home: localPath(home),
        platform: "darwin",
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: home, FORCE_COLOR: "3" }),
      });

    if (options.document !== undefined) {
      const root = services(DEFAULT_OPTIONS)().configurationRoot;
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, CONFIGURATION_FILE_NAME),
        JSON.stringify({
          [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION,
          ...options.document,
        }),
      );
    }

    if (options.prepare !== undefined) {
      const root = services(DEFAULT_OPTIONS)().configurationRoot;
      await mkdir(root, { recursive: true });
      await options.prepare(root);
    }

    const code = await dispatch({ argv, streams, services });
    return {
      code,
      out: streams.resultWrites().join(""),
      err: streams.diagnosticWrites().join(""),
    };
  }

  /** A configuration file that exists and cannot be read, in three ways. */
  const UNREADABLE = {
    /** A directory where the file should be. */
    directory: async (root: string) => {
      await mkdir(join(root, CONFIGURATION_FILE_NAME), { recursive: true });
    },
    /** Past the 256 KiB bound, and carrying a secret it must never emit. */
    oversized: async (root: string) => {
      await writeFile(
        join(root, CONFIGURATION_FILE_NAME),
        `{"provider":{"credential":"${SECRET}"}}${" ".repeat(MAX_CONFIGURATION_FILE_BYTES)}`,
      );
    },
    /** Not valid UTF-8, with the same secret among the bytes. */
    misEncoded: async (root: string) => {
      await writeFile(
        join(root, CONFIGURATION_FILE_NAME),
        Buffer.concat([
          Buffer.from(`{"c":"${SECRET}"`),
          Buffer.from([0xff, 0xfe]),
          Buffer.from("}"),
        ]),
      );
    },
  };

  test("carries an unread configuration source into every contract and the exit status", async () => {
    const validate = async (argv: readonly string[]) =>
      run(argv, { prepare: UNREADABLE.directory });

    const human = await validate(["config", "validate"]);
    expect(human.out).not.toContain("Configuration is valid.");
    expect(human.err).toContain("could not be read and was skipped");
    // The verdict of a diagnostic is its exit status, and this configuration is
    // not the one its author wrote.
    expect(human.code).toBe(3);

    const quiet = await validate(["config", "validate", "--format", "quiet"]);
    expect(quiet.out).toBe("");
    expect(quiet.err).toContain("could not be read and was skipped");
    expect(quiet.code).toBe(3);

    for (const format of ["json", "jsonl"]) {
      const machine = await validate(["config", "validate", "--format", format]);
      const reading = readCliStream(machine.out.split("\n"));
      const terminal = reading.terminal as { payload?: ConfigValidatePayload } | null;

      expect(terminal?.payload?.unreadSources[0]).toMatchObject({
        outcome: "unreadable",
        source: { kind: "user-file" },
      });
      // `valid` still answers only whether an issue blocks what loaded.
      expect(terminal?.payload?.valid).toBe(true);
      expect(machine.code).toBe(3);
    }
  });

  test("tells oversized and mis-encoded apart, and keeps both at exit 3", async () => {
    for (const [prepare, outcome] of [
      [UNREADABLE.oversized, "oversized"],
      [UNREADABLE.misEncoded, "malformed-encoding"],
    ] as const) {
      const machine = await run(["config", "validate", "--format", "json"], { prepare });
      const terminal = readCliStream(machine.out.split("\n")).terminal as {
        payload?: ConfigValidatePayload;
      } | null;

      expect(terminal?.payload?.unreadSources[0]?.outcome).toBe(outcome);
      expect(machine.code).toBe(3);
    }
  });

  test("reports the same source from config show, and still exits zero", async () => {
    for (const argv of [
      ["config", "show"],
      ["config", "show", "--format", "quiet"],
    ]) {
      const shown = await run(argv, { prepare: UNREADABLE.directory });

      // The values it displayed did load, and displaying them is the purpose.
      expect(shown.code).toBe(0);
      expect(shown.err).toContain("could not be read and was skipped");
      // And stdout still carries only the configuration.
      expect(shown.out).not.toContain("skipped");
      expect(shown.out.length).toBeGreaterThan(0);
    }
  });

  test("emits no byte of a document it could not read, in any format", async () => {
    // The read produced these bytes for nobody in the oversized case and
    // produced undecodable ones in the other. Neither may reach a surface.
    for (const prepare of [UNREADABLE.oversized, UNREADABLE.misEncoded]) {
      for (const argv of [
        ["config", "validate"],
        ["config", "validate", "--format", "quiet"],
        ["config", "validate", "--format", "json"],
        ["config", "show", "--format", "jsonl"],
      ]) {
        const { out, err } = await run(argv, { prepare });
        expect(out).not.toContain(SECRET);
        expect(out).not.toContain("sk-live");
        expect(err).not.toContain(SECRET);
        expect(err).not.toContain("sk-live");
      }
    }
  });

  test("writes one parseable record for --format json", async () => {
    const { out, err } = await run(["doctor", "--format", "json"]);
    const lines = out.split("\n").filter((line) => line !== "");

    expect(lines).toHaveLength(1);
    const reading = readCliStream(lines);
    expect(reading.terminal?.kind).toBe("result");
    expect(reading.refusals).toEqual([]);
    // Nothing but the record. A diagnostic on stdout is what corrupts a parse.
    expect(err).toBe("");
  });

  test("writes a real lifecycle and one terminal record for --format jsonl", async () => {
    const { out } = await run(["config", "show", "--format", "jsonl"]);
    const reading = readCliStream(out.split("\n"));

    // `config show` appends a configuration generation event, so this is the
    // lifecycle the run actually produced rather than one staged for it.
    expect(reading.records.length).toBeGreaterThanOrEqual(2);
    expect(reading.records[0]?.kind).toBe("event");
    expect(reading.terminal?.kind).toBe("result");
    expect(reading.gaps).toEqual([]);
    expect(reading.refusals).toEqual([]);
  });

  test("emits no ANSI under a forced-colour environment", async () => {
    for (const format of ["json", "jsonl"]) {
      const { out, err } = await run(["config", "show", "--format", format]);
      expect(out).not.toContain(ESCAPE);
      expect(err).not.toContain(ESCAPE);
    }
  });

  test("leaks no secret from a configuration that contains one", async () => {
    // The realistic leak: a token pasted under a key that does not exist. The
    // load is refused, and the refusal must report the path and the constraint
    // without echoing what was written there.
    for (const format of ["json", "jsonl"]) {
      const { out, err } = await run(["config", "show", "--format", format], {
        document: { provider: { credential: SECRET } },
      });
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("sk-live");
      expect(err).not.toContain(SECRET);
    }
  });

  test("stops on whole records when the reader leaves", async () => {
    // `falryn ... --format jsonl | head -1`. The bound admits the lifecycle
    // record and refuses the larger terminal one, so this exercises a reader
    // that left partway through rather than one that never read anything.
    const whole = await run(["config", "show", "--format", "jsonl"]);
    const full = readCliStream(whole.out.split("\n"));
    expect(full.records).toHaveLength(2);

    const firstLine = whole.out.split("\n")[0] ?? "";
    const { out, code } = await run(["config", "show", "--format", "jsonl"], {
      closeAfterBytes: firstLine.length + 1,
    });

    const partial = readCliStream(out.split("\n"));
    // Whole lines only. A record cut in half is what a consumer's parser
    // reports as corruption rather than as an early end.
    expect(partial.records).toHaveLength(1);
    expect(partial.refusals).toEqual([]);
    // And the run does not claim a terminal record it never delivered.
    expect(partial.terminal).toBeNull();
    // The reader left on purpose, so the run keeps the code its work earned.
    expect(code).toBe(0);
  });

  test("carries a blocked root into every output contract, and into the exit status", async () => {
    // The finding has to survive all four projections: a diagnostic that
    // reports a fault in one format and health in another is worse than one
    // that reports nothing.
    const home = await mkdtemp(join(tmpdir(), "falryn-viability-"));
    homes.push(home);
    const stateFile = join(home, "state-file");
    await writeFile(stateFile, "not a directory");

    const services = (globals: GlobalOptions) =>
      createServiceProvider(globals, {
        home: localPath(home),
        platform: "darwin",
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: stateFile }),
      });

    async function doctor(argv: readonly string[]) {
      const streams = createRecordingCliStreams();
      const code = await dispatch({ argv, streams, services });
      return {
        code,
        out: streams.resultWrites().join(""),
        err: streams.diagnosticWrites().join(""),
      };
    }

    const human = await doctor(["doctor"]);
    expect(human.err).toContain("cannot hold data");
    expect(human.out).not.toContain("no database has been created yet");
    expect(human.code).toBe(1);

    const quiet = await doctor(["doctor", "--format", "quiet"]);
    expect(quiet.out).toBe("");
    expect(quiet.err).toContain("cannot hold data");
    expect(quiet.code).toBe(1);

    for (const format of ["json", "jsonl"]) {
      const machine = await doctor(["doctor", "--format", format]);
      const reading = readCliStream(machine.out.split("\n"));
      const terminal = reading.terminal as { payload?: DoctorPayload } | null;
      const state = terminal?.payload?.roots.find((entry) => entry.root === "state");

      expect(state?.viability).toBe("blocked");
      expect(state?.code).toBe("not-a-directory");
      expect(terminal?.payload?.storage).toEqual({
        kind: "undetermined",
        reason: "state-root-not-viable",
      });
      expect(machine.code).toBe(1);
    }
  });

  test("leaves an advisory-only run at exit zero in every contract", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-viability-"));
    homes.push(home);
    const services = (globals: GlobalOptions) =>
      createServiceProvider(globals, {
        home: localPath(home),
        platform: "darwin",
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: join(home, "not-created-yet") }),
      });

    for (const argv of [
      ["doctor"],
      ["doctor", "--format", "quiet"],
      ["doctor", "--format", "json"],
    ]) {
      const streams = createRecordingCliStreams();
      // Unregistered ownership classes are advisory and always present here,
      // so this also proves an advisory finding does not reach the status.
      expect(await dispatch({ argv, streams, services })).toBe(0);
    }
  });

  test("refuses --color always with a machine format at parse time", async () => {
    // #17's rule, still holding now that the formats are real.
    const { out, code } = await run(["doctor", "--format", "json", "--color", "always"]);
    expect(code).toBe(2);
    expect(out).toBe("");
  });
});
