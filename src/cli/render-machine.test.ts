/**
 * The JSON and JSON Lines projections.
 *
 * The pure-function sections cover the shapes; the last two sections run the
 * same projections through `dispatch` over real services in a temporary home,
 * because "stdout carried only records" and "the terminal record survived the
 * reader leaving" are claims about the composition rather than about a function.
 *
 * The outcome matrix is exercised against staged results rather than real
 * cancellations: nothing in this build cancels or times out a CLI run, and the
 * delivery says so rather than implying otherwise.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_SCHEMA_VERSION,
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
import type { RunCommandResult } from "./commands.ts";
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
    correlation: NO_CORRELATION,
  } as unknown as RunCommandResult;
}

function parsedJson(payload: unknown, overrides: ResultOverrides = {}) {
  const rendered = renderJson({ result: resultOf(payload, overrides), occurredAt: AT });
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
  test("emits exactly one terminal record", () => {
    const rendered = renderJson({ result: resultOf({ ok: true }), occurredAt: AT });
    expect(rendered.result).toHaveLength(1);
    expect(rendered.diagnostics).toBe("");
    expect(parsedJson({ ok: true })).toMatchObject({
      schemaFamily: CLI_SCHEMA_FAMILY,
      kind: "result",
      terminal: true,
      command: "doctor",
      sequence: FIRST_SEQUENCE,
    });
  });

  test("carries the result's facts without reshaping them", () => {
    const record = parsedJson({ roots: ["state"] });
    expect(record.payload).toEqual({ roots: ["state"] });
    expect(record.effect).toEqual({ intent: "none", observed: "none" });
    expect(record.errors).toEqual([]);
    expect(record.artifacts).toEqual([]);
  });

  test("renders every outcome kind and every effect certainty", () => {
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
        const record = parsedJson(null, { outcome });
        expect(record.outcome).toEqual(outcome);
        seen.add(JSON.stringify(record.outcome));
      }
    }
    // `completed` carries no effect and `uncertain` pins one, so the matrix
    // collapses to the outcomes the domain can actually represent.
    expect(seen.size).toBe(1 + 3 * certainties.length + 1);
  });

  test("refuses an over-bound result with a terminal record, not a trimmed one", () => {
    const rendered = renderJson({
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
      maximumBytes: MAX_CLI_RECORD_BYTES,
    });
    // Nothing of the result survived into it, so a consumer cannot mistake the
    // refusal for a partial answer.
    expect(rendered.result[0]).not.toContain("blob");
    expect(rendered.diagnostics).toContain("record-too-large");
  });

  test("still ends the run when a value cannot be encoded", () => {
    const rendered = renderJson({ result: resultOf({ text: "a\ud800b" }), occurredAt: AT });
    const record = JSON.parse(rendered.result[0] ?? "");
    expect(record.terminal).toBe(true);
    expect(record.code).toBe("unencodable-text");
  });
});

/* -------------------------------------------------------------------------- */
/* JSON Lines                                                                  */
/* -------------------------------------------------------------------------- */

describe("JSON Lines", () => {
  test("ends in exactly one terminal record", () => {
    const rendered = renderJsonl({
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

  test("is a complete stream with no events at all", () => {
    const reading = readCliStream(
      renderJsonl({ result: resultOf(null), occurredAt: AT, events: [] }).result,
    );
    expect(reading.records).toHaveLength(1);
    expect(reading.terminal?.kind).toBe("result");
  });

  test("numbers records monotonically with no gap", () => {
    const rendered = renderJsonl({
      result: resultOf(null),
      occurredAt: AT,
      events: [EVENT, EVENT, EVENT],
    });
    const reading = readCliStream(rendered.result);
    expect(reading.records.map((record) => Number(record.sequence))).toEqual([1, 2, 3, 4]);
    expect(reading.gaps).toEqual([]);
  });

  test("projects the runtime's own event vocabulary rather than a second one", () => {
    const rendered = renderJsonl({ result: resultOf(null), occurredAt: AT, events: [EVENT] });
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

  test("emits its terminal record even when the result will not encode", () => {
    const rendered = renderJsonl({
      result: resultOf({ blob: "x".repeat(MAX_CLI_RECORD_BYTES) }),
      occurredAt: AT,
      events: [EVENT],
    });
    const reading = readCliStream(rendered.result);
    expect(reading.terminal?.kind).toBe("refusal");
    expect(reading.gaps).toEqual([]);
  });

  test("is byte-identical for equal inputs", () => {
    const one = renderJsonl({ result: resultOf({ a: 1, b: 2 }), occurredAt: AT, events: [EVENT] });
    const other = renderJsonl({
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
  test("is valid JSON on every line", () => {
    const rendered = renderJsonl({
      result: resultOf({ text: "value" }),
      occurredAt: AT,
      events: [EVENT],
    });
    for (const line of rendered.result) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("holds no escape sequence, even when the result carried one", () => {
    // A configuration value carrying ANSI reaches the record as data. What must
    // not happen is the *format* emitting one.
    const record = parsedJson({ text: `${ESCAPE}[31mred${ESCAPE}[0m` });
    const line = renderJson({
      result: resultOf({ text: `${ESCAPE}[31mred` }),
      occurredAt: AT,
    }).result[0];

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

    const code = await dispatch({ argv, streams, services });
    return {
      code,
      out: streams.resultWrites().join(""),
      err: streams.diagnosticWrites().join(""),
    };
  }

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

  test("refuses --color always with a machine format at parse time", async () => {
    // #17's rule, still holding now that the formats are real.
    const { out, code } = await run(["doctor", "--format", "json", "--color", "always"]);
    expect(code).toBe(2);
    expect(out).toBe("");
  });
});
