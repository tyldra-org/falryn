/**
 * The human, plain-text, and quiet projections.
 *
 * These are the properties a reader depends on and cannot see for themselves:
 * that stdout carries only the result, that losing colour or losing Unicode
 * loses decoration rather than meaning, that nothing summarized disappears
 * silently, and that a value from a file can never move the cursor.
 *
 * The renderer is pure, so almost everything here is a direct call. The last
 * section runs the same rendering through `dispatch` over real services in a
 * temporary home, because "stdout stayed clean" is a claim about the
 * composition rather than about the function.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ColorLevel,
  type ConfigurationIssue,
  type ConfigurationSourceKind,
  type ConfigurationValue,
  configurationGeneration,
  configurationKeyPath,
  createStaticEnvironment,
  type EffectCertainty,
  type FalrynError,
  type InspectedValue,
  localPath,
  MAX_RELATED_ERRORS,
  NO_CORRELATION,
  type SourceOutcome,
  type SourceReport,
  type SymbolSupport,
  TERMINAL_OUTCOME_KINDS,
  type TerminalOutcome,
} from "../domain/index.ts";
import type {
  ConfigPathPayload,
  ConfigShowPayload,
  ConfigValidatePayload,
  DoctorPayload,
  RunCommandResult,
} from "./commands.ts";
import { dispatch } from "./dispatch.ts";
import type { GlobalOptions } from "./options.ts";
import { renderHuman, renderPlainText, renderQuiet } from "./render-human.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandOmission,
  type CommandTruncation,
  type CommandWarning,
  READ_ONLY_EFFECT,
} from "./result.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

type ResultOverrides = {
  readonly outcome?: TerminalOutcome;
  readonly effect?: CommandEffect;
  readonly errors?: readonly FalrynError[];
  readonly warnings?: readonly CommandWarning[];
  readonly omissions?: readonly CommandOmission[];
  readonly truncation?: readonly CommandTruncation[];
};

/** The payload the named command declares. A mismatch fails to compile. */
type PayloadOf<Command extends RunCommandResult["command"]> = NonNullable<
  Extract<RunCommandResult, { readonly command: Command }>["payload"]
>;

function resultOf<Command extends RunCommandResult["command"]>(
  command: Command,
  payload: PayloadOf<Command> | null,
  overrides: ResultOverrides = {},
): Extract<RunCommandResult, { readonly command: Command }> {
  // The one assertion in this file. Every field below is checked against the
  // shared shape; what the compiler cannot see is that `command` and `payload`
  // pick the same member of the union, which `PayloadOf` already required.
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    outcome: overrides.outcome ?? ({ kind: "completed" } as TerminalOutcome),
    effect: overrides.effect ?? READ_ONLY_EFFECT,
    payload,
    errors: overrides.errors ?? [],
    warnings: overrides.warnings ?? [],
    omissions: overrides.omissions ?? [],
    truncation: overrides.truncation ?? [],
    artifacts: [],
    correlation: NO_CORRELATION,
  } as Extract<RunCommandResult, { readonly command: Command }>;
}

function inspectedValue(
  path: string,
  value: ConfigurationValue,
  kind: ConfigurationSourceKind = "user-file",
): InspectedValue {
  return {
    path: configurationKeyPath(path),
    value,
    source: { kind, file: null, profile: null },
    scope: "user",
    overriddenBy: [],
  };
}

function showPayload(
  values: readonly InspectedValue[],
  usable = true,
  sources: readonly SourceReport[] = [],
): ConfigShowPayload {
  return {
    inspection: {
      generation: configurationGeneration.from(1),
      values,
      sources,
      issues: [],
    },
    usable,
  };
}

/** One source report, as the loader would have produced it. */
function unreadSource(kind: ConfigurationSourceKind, outcome: SourceOutcome): SourceReport {
  return {
    source: {
      kind,
      file: localPath(kind === "user-file" ? "/home/x/falryn.jsonc" : "/work/.falryn/falryn.jsonc"),
      profile: null,
    },
    outcome,
    issues: [],
    declaredKeys: [],
    position: null,
  };
}

const DOCTOR: DoctorPayload = {
  roots: [
    { root: "state", path: "/tmp/falryn/state", resolved: true, viability: "ready", code: null },
    {
      root: "cache",
      path: "/tmp/falryn/cache",
      resolved: true,
      viability: "blocked",
      code: "not-a-directory",
    },
  ],
  rootIssues: [],
  blocked: true,
  databasePath: "/tmp/falryn/state/falryn.sqlite",
  storage: { kind: "present", schemaVersion: 3, expectedVersion: 3, current: true },
  registeredClasses: ["sqliteState"],
  unregisteredClasses: ["extensions"],
  build: { platform: "darwin", architecture: "arm64" },
};

function failure(overrides: Partial<FalrynError> = {}): FalrynError {
  return {
    code: "configuration-invalid",
    category: "configuration",
    message: "The configuration could not be loaded.",
    retryable: false,
    effect: "none",
    cause: null,
    correlation: NO_CORRELATION,
    recovery: ["retry"],
    exitCategory: "user-error",
    related: [],
    relatedDropped: 0,
    recognized: true,
    ...overrides,
  };
}

type RenderOptions = {
  readonly color?: ColorLevel;
  readonly symbols?: SymbolSupport;
  readonly columns?: number | null;
  readonly verbose?: boolean;
};

function human(result: RunCommandResult, options: RenderOptions = {}) {
  return renderHuman({
    result,
    color: options.color ?? "none",
    symbols: options.symbols ?? "unicode",
    columns: options.columns === undefined ? 80 : options.columns,
    verbose: options.verbose ?? false,
  });
}

/**
 * Text with its wrapping undone.
 *
 * Assertions here are about what the renderer says, not about where the width
 * happened to break it, so a phrase is matched against the unwrapped form.
 */
function flat(text: string): string {
  return text.replaceAll("\n", " ");
}

/** The escape character. Nothing on a no-colour path may hold one. */
const ESCAPE = "\u001b";

/** Every select-graphic-rendition sequence this renderer can emit. */
const SGR_SEQUENCE = new RegExp(`${ESCAPE}\\[\\d+m`, "g");

/**
 * Whether any character here could reach the terminal as control.
 *
 * A scan rather than a pattern, because a regular expression naming a control
 * character is itself the thing the linter refuses. Newlines are the layout's
 * own and are not counted.
 */
function holdsControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Outcome and effect                                                          */
/* -------------------------------------------------------------------------- */

describe("the outcome and its effect", () => {
  const OUTCOMES: readonly TerminalOutcome[] = [
    { kind: "completed" },
    { kind: "failed", effect: "none" },
    { kind: "cancelled", effect: "none" },
    { kind: "timed-out", effect: "none" },
    { kind: "uncertain", effect: "uncertain" },
  ];

  test("renders every outcome kind distinguishably", () => {
    const rendered = OUTCOMES.map(
      (outcome) => human(resultOf("config.path", { sources: [] }, { outcome })).diagnostics,
    );
    expect(new Set(rendered).size).toBe(OUTCOMES.length);
    expect(OUTCOMES.map((outcome) => outcome.kind).sort()).toEqual(
      [...TERMINAL_OUTCOME_KINDS].sort(),
    );
  });

  test("renders every effect certainty distinguishably, and never as the outcome word", () => {
    const certainties: readonly EffectCertainty[] = ["none", "completed", "partial", "uncertain"];
    const rendered = certainties.map(
      (observed) =>
        human(
          resultOf(
            "config.path",
            { sources: [] },
            {
              outcome: { kind: "cancelled", effect: observed },
              effect: { intent: "mutate", observed },
            },
          ),
        ).diagnostics,
    );

    expect(new Set(rendered).size).toBe(certainties.length);
    // Every one of them says "Cancelled". What separates them is the clause
    // after it, which is the entire point of carrying effect separately.
    for (const text of rendered) {
      expect(text).toContain("Cancelled.");
    }
  });

  test("keeps a cancellation that changed nothing apart from one that may have", () => {
    const clean = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          outcome: { kind: "cancelled", effect: "none" },
          effect: { intent: "mutate", observed: "none" },
        },
      ),
    ).diagnostics;
    const dirty = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          outcome: { kind: "cancelled", effect: "uncertain" },
          effect: { intent: "mutate", observed: "uncertain" },
        },
      ),
    ).diagnostics;

    expect(flat(clean)).toContain("nothing outside Falryn changed");
    expect(flat(dirty)).toContain("could not be observed");
    expect(flat(dirty)).toContain("inspect before retrying");
  });

  test("distinguishes a read-only command from one that meant to change something", () => {
    const read = human(resultOf("config.path", { sources: [] })).diagnostics;
    const wrote = human(
      resultOf("config.path", { sources: [] }, { effect: { intent: "mutate", observed: "none" } }),
    ).diagnostics;

    expect(flat(read)).toContain("Read-only");
    expect(flat(wrote)).toContain("A change was requested");
  });

  test("reports success explicitly rather than by saying nothing", () => {
    expect(human(resultOf("config.path", { sources: [] })).diagnostics).toContain("Completed.");
  });

  test("never changes the outcome or the certainty it was given", () => {
    // The property `design/CLI-TUI-AND-PROJECTIONS.md` states: rendering may
    // summarize, but may not alter a canonical outcome.
    for (const outcome of OUTCOMES) {
      const result = resultOf("config.path", { sources: [] }, { outcome });
      const before = JSON.stringify(result);
      human(result);
      renderQuiet(result);
      expect(JSON.stringify(result)).toBe(before);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Stream separation                                                           */
/* -------------------------------------------------------------------------- */

describe("the two texts", () => {
  test("keeps warnings, notices, and errors out of the result", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("diagnostics.level", "debug")]), {
        outcome: { kind: "failed", effect: "none" },
        errors: [failure()],
        warnings: [{ code: "stale-cache", message: "The cache is stale." }],
        omissions: [{ code: "unreadable", message: "One source could not be read.", count: 1 }],
      }),
    );

    expect(rendered.result).toContain("diagnostics.level");
    for (const noise of [
      "The cache is stale.",
      "could not be loaded",
      "could not be read",
      "Failed.",
    ]) {
      expect(rendered.result).not.toContain(noise);
      expect(flat(rendered.diagnostics)).toContain(noise);
    }
  });

  test("gives an empty result rather than a blank line when there is nothing to say", () => {
    expect(renderQuiet(resultOf("doctor", DOCTOR)).result).toBe("");
    expect(
      renderQuiet(resultOf("config.validate", { issues: [], valid: true, unreadSources: [] }))
        .result,
    ).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* Colour and symbols                                                          */
/* -------------------------------------------------------------------------- */

describe("colour", () => {
  test("is absent byte for byte when the level is none", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("diagnostics.level", "debug")]), {
        outcome: { kind: "failed", effect: "uncertain" },
        errors: [failure()],
        warnings: [{ code: "stale", message: "Stale." }],
      }),
    );
    expect(rendered.result).not.toContain(ESCAPE);
    expect(rendered.diagnostics).not.toContain(ESCAPE);
  });

  test("is absent from plain text, which is this renderer with colour forced off", () => {
    const result = resultOf("doctor", DOCTOR, { outcome: { kind: "failed", effect: "none" } });
    const plain = renderPlainText({ result, symbols: "unicode", columns: 80, verbose: false });

    expect(plain.result).not.toContain(ESCAPE);
    expect(plain.diagnostics).not.toContain(ESCAPE);
    // The same renderer, not a second one: forcing the level off reproduces it.
    expect(plain).toEqual(human(result, { color: "none" }));
  });

  test("is never the only carrier of meaning", () => {
    const result = resultOf("config.validate", { issues: [], valid: false, unreadSources: [] });
    const coloured = human(result, { color: "basic" });
    const uncoloured = human(result, { color: "none" });

    expect(coloured.result).toContain(ESCAPE);
    // Strip every escape sequence and the two are the same text.
    expect(coloured.result.replaceAll(SGR_SEQUENCE, "")).toBe(uncoloured.result);
    expect(coloured.diagnostics.replaceAll(SGR_SEQUENCE, "")).toBe(uncoloured.diagnostics);
  });
});

describe("symbols", () => {
  test("carry the same meaning in ASCII as in Unicode", () => {
    const result = resultOf("config.show", showPayload([inspectedValue("a.b", "value")]), {
      outcome: { kind: "timed-out", effect: "partial" },
      errors: [failure()],
      warnings: [{ code: "w", message: "A warning." }],
    });
    const unicode = human(result, { symbols: "unicode" });
    const ascii = human(result, { symbols: "ascii" });

    for (const meaning of ["Timed out.", "A warning.", "The configuration could not be loaded."]) {
      expect(flat(unicode.diagnostics)).toContain(meaning);
      expect(flat(ascii.diagnostics)).toContain(meaning);
    }
    expect(ascii.result).not.toMatch(/[^\p{ASCII}]/u);
    expect(ascii.diagnostics).not.toMatch(/[^\p{ASCII}]/u);
  });

  test("shorten with an ASCII marker when the repertoire is ASCII", () => {
    const long = inspectedValue("a.b", "x".repeat(200));
    expect(
      human(resultOf("config.show", showPayload([long])), { symbols: "ascii" }).result,
    ).toContain("...");
    expect(
      human(resultOf("config.show", showPayload([long])), { symbols: "unicode" }).result,
    ).toContain("…");
  });
});

/* -------------------------------------------------------------------------- */
/* Injection                                                                   */
/* -------------------------------------------------------------------------- */

describe("untrusted text", () => {
  const HOSTILE = "\u001b[2J\u001b[Hpwned\n\u0007\u009b31m";

  test("is rendered as data in every field it can reach", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("a.b", HOSTILE)]), {
        errors: [failure({ message: HOSTILE, code: HOSTILE })],
        warnings: [{ code: HOSTILE, message: HOSTILE }],
      }),
      { color: "none", columns: 400 },
    );

    for (const text of [rendered.result, rendered.diagnostics]) {
      expect(holdsControl(text)).toBe(false);
    }
    expect(rendered.result).toContain("\\x1b[2J");
  });

  test("cannot forge a line by carrying a newline", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("a.b", "one\nfalryn: two")])),
      { columns: 400 },
    );
    // One heading and one value line. A value that could break the line could
    // write a line the renderer never wrote.
    expect(rendered.result.split("\n")).toHaveLength(2);
  });

  test("is rendered as data in quiet mode too", () => {
    const quiet = renderQuiet(
      resultOf("config.show", showPayload([inspectedValue("a.b", HOSTILE)])),
    );
    expect(quiet.result).not.toContain(ESCAPE);
    expect(quiet.result.split("\n")).toHaveLength(1);
  });

  test("is rendered as data in a path", () => {
    const quiet = renderQuiet(
      resultOf("config.path", { sources: [{ kind: "user-file", path: HOSTILE }] }),
    );
    expect(quiet.result).not.toContain(ESCAPE);
  });
});

/* -------------------------------------------------------------------------- */
/* Truncation                                                                  */
/* -------------------------------------------------------------------------- */

describe("shortening", () => {
  const MANY = Array.from({ length: 120 }, (_, index) =>
    inspectedValue(`section.key${index}`, index),
  );

  test("reports how many it dropped and names a route that exists", () => {
    const rendered = human(resultOf("config.show", showPayload(MANY)));
    expect(flat(rendered.diagnostics)).toContain("Showing 40 of 120 values");
    expect(flat(rendered.diagnostics)).toContain("--verbose");
  });

  test("honours the route it named", () => {
    const rendered = human(resultOf("config.show", showPayload(MANY)), { verbose: true });
    expect(rendered.result.split("\n")).toHaveLength(MANY.length + 1);
    expect(flat(rendered.diagnostics)).not.toContain("Showing");
  });

  test("names no route once verbose is already set", () => {
    const enormous = Array.from({ length: 1_200 }, (_, index) =>
      inspectedValue(`section.key${index}`, index),
    );
    const rendered = human(resultOf("config.show", showPayload(enormous)), {
      verbose: true,
      columns: 400,
    });
    expect(flat(rendered.diagnostics)).toContain("Showing 1000 of 1200 values");
    expect(flat(rendered.diagnostics)).toContain("this build has no wider form");
    expect(flat(rendered.diagnostics)).not.toContain("--verbose");
  });

  test("says when it shortened a value to fit, rather than shortening in silence", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("a.b", "x".repeat(500))])),
      { columns: 400 },
    );
    expect(flat(rendered.diagnostics)).toContain("did not fit");
    expect(flat(rendered.diagnostics)).toContain("--verbose");
  });

  test("names the width, not a flag, when the terminal is what cut the value", () => {
    // `--verbose` raises this renderer's own bound. It does not widen a
    // terminal, so offering it for a width-driven cut would name a route that
    // cannot answer.
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("a.b", "x".repeat(500))])),
      { columns: 40 },
    );
    expect(flat(rendered.diagnostics)).toContain("a wider terminal shows more");
    expect(flat(rendered.diagnostics)).not.toContain("--verbose");
  });

  test("keeps the command's own summary apart from its own", () => {
    const rendered = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          truncation: [{ of: "sessions", shown: 10, total: 400, expansion: "falryn session list" }],
        },
      ),
    );
    expect(flat(rendered.diagnostics)).toContain(
      "The command summarized sessions: 10 of 400 shown.",
    );
    expect(flat(rendered.diagnostics)).toContain("Run 'falryn session list' to see the rest.");
  });

  test("says so plainly when the command declared no expansion route", () => {
    const rendered = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          truncation: [{ of: "sessions", shown: 10, total: 400, expansion: null }],
        },
      ),
    );
    expect(flat(rendered.diagnostics)).toContain("This build offers no way to see the rest.");
  });

  test("reports a declared omission with its count", () => {
    const rendered = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          omissions: [{ code: "unreadable", message: "One source was unreadable.", count: 3 }],
        },
      ),
    );
    expect(flat(rendered.diagnostics)).toContain("The command left out 3 items");
  });

  test("reports a declared omission whose count is not knowable", () => {
    const rendered = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          omissions: [
            { code: "unreadable", message: "Some sources were unreadable.", count: null },
          ],
        },
      ),
    );
    expect(flat(rendered.diagnostics)).toContain("an unknown number of items");
  });

  test("bounds a warning list and counts what it left out", () => {
    const warnings = Array.from({ length: 64 }, (_, index) => ({
      code: `w${index}`,
      message: `Warning ${index}.`,
    }));
    const rendered = human(resultOf("config.path", { sources: [] }, { warnings }));
    expect(flat(rendered.diagnostics)).toContain("Showing 8 of 64 warnings");
    expect(
      human(resultOf("config.path", { sources: [] }, { warnings }), { verbose: true }).diagnostics,
    ).toContain("Warning 63.");
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe("a failure", () => {
  test("keeps its code, category, and recovery visible", () => {
    const rendered = human(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "none" },
        errors: [failure()],
      }),
    );
    expect(flat(rendered.diagnostics)).toContain("The configuration could not be loaded.");
    expect(flat(rendered.diagnostics)).toContain("configuration-invalid");
    expect(flat(rendered.diagnostics)).toContain("configuration");
    expect(flat(rendered.diagnostics)).toContain("Recovery: retry");
  });

  test("falls back to the effect's documented recovery when it declared none", () => {
    const rendered = human(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "uncertain" },
        errors: [failure({ recovery: [], effect: "uncertain" })],
      }),
    );
    // `recoveryForEffect("uncertain")`, consumed rather than restated here.
    expect(flat(rendered.diagnostics)).toContain("Recovery: inspect-state");
  });

  test("folds its companions when concise and unfolds them when verbose", () => {
    const error = failure({
      related: [failure({ message: "The cache could not be cleaned up." })],
    });
    const concise = human(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "none" },
        errors: [error],
      }),
    );
    const verbose = human(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "none" },
        errors: [error],
      }),
      { verbose: true },
    );

    expect(flat(concise.diagnostics)).toContain("1 further failure accompanied this one");
    expect(flat(concise.diagnostics)).toContain("--verbose");
    expect(flat(concise.diagnostics)).not.toContain("The cache could not be cleaned up.");
    expect(flat(verbose.diagnostics)).toContain("The cache could not be cleaned up.");
  });

  test("reports companions the runtime itself dropped", () => {
    const rendered = human(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "none" },
        errors: [
          failure({
            related: Array.from({ length: MAX_RELATED_ERRORS }, () => failure()),
            relatedDropped: 7,
          }),
        ],
      }),
    );
    expect(flat(rendered.diagnostics)).toContain("7 accompanying failures were not kept.");
  });

  test("is reported as observed when this build did not recognize it", () => {
    const rendered = human(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "none" },
        errors: [failure({ recognized: false, code: "from-a-newer-build" })],
      }),
    );
    expect(flat(rendered.diagnostics)).toContain("did not recognize this failure");
    expect(flat(rendered.diagnostics)).toContain("from-a-newer-build");
  });

  test("appears alongside a payload when the read partly succeeded", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("a.b", 1)], false), {
        outcome: { kind: "failed", effect: "none" },
        errors: [failure()],
      }),
    );
    expect(rendered.result).toContain("a.b");
    expect(flat(rendered.diagnostics)).toContain("last configuration that loaded");
    expect(flat(rendered.diagnostics)).toContain("The configuration could not be loaded.");
  });
});

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

describe("config show", () => {
  test("says so explicitly when nothing is set", () => {
    expect(human(resultOf("config.show", showPayload([]))).result).toBe(
      "No configuration values are set.",
    );
  });

  test("says so explicitly when there is no configuration at all", () => {
    expect(human(resultOf("config.show", null)).result).toBe("No configuration to show.");
  });

  test("names the generation and the winning source of each value", () => {
    const rendered = human(
      resultOf(
        "config.show",
        showPayload([
          inspectedValue("diagnostics.level", "debug", "cli-override"),
          inspectedValue("limits.bytes", 4096),
        ]),
      ),
    );
    expect(rendered.result).toContain("Configuration (generation 1)");
    expect(rendered.result).toContain("[cli-override]");
    expect(rendered.result).toContain("4096");
  });

  test("keeps a skipped source off stdout and on stderr", () => {
    const rendered = human(
      resultOf(
        "config.show",
        showPayload([inspectedValue("limits.bytes", 4096)], true, [
          unreadSource("user-file", "unreadable"),
        ]),
      ),
    );

    // `falryn config show > file` must still produce a file containing the
    // configuration and nothing else, so the notice goes to the other stream.
    expect(rendered.result).not.toContain("falryn.jsonc");
    expect(flat(rendered.diagnostics)).toContain("could not be read and was skipped");
  });

  test("says nothing about a source that is absent or empty", () => {
    const rendered = human(
      resultOf(
        "config.show",
        showPayload([inspectedValue("limits.bytes", 4096)], true, [
          unreadSource("user-file", "absent"),
          unreadSource("project-file", "empty"),
        ]),
      ),
    );
    expect(flat(rendered.diagnostics)).not.toContain("skipped");
  });
});

describe("config path", () => {
  test("lists the sources in precedence order", () => {
    const rendered = human(
      resultOf("config.path", {
        sources: [
          { kind: "user-file", path: "/home/x/config.jsonc" },
          { kind: "project-file", path: "/work/falryn.jsonc" },
        ],
      } satisfies ConfigPathPayload),
    );
    const lines = rendered.result.split("\n");
    expect(lines[1]).toContain("/home/x/config.jsonc");
    expect(lines[2]).toContain("/work/falryn.jsonc");
  });

  test("says so explicitly when none resolve", () => {
    expect(human(resultOf("config.path", { sources: [] })).result).toBe(
      "No configuration sources resolve for this invocation.",
    );
  });
});

describe("config validate", () => {
  const ISSUES: readonly ConfigurationIssue[] = [
    { kind: "unknown-key", severity: "error", path: "diagnostics.levl" },
    { kind: "invalid-type", severity: "error", path: "limits.bytes", expected: "integer" },
    {
      kind: "out-of-range",
      severity: "error",
      path: "limits.bytes",
      unit: "bytes",
      minimum: 1,
      maximum: 1024,
    },
    { kind: "invalid-value", severity: "error", path: "diagnostics.level", allowed: ["debug"] },
    {
      kind: "alias-resolved",
      severity: "warning",
      path: "old.key",
      canonical: configurationKeyPath("new.key"),
    },
  ];

  test("puts the verdict on stdout and the issues on stderr", () => {
    const rendered = human(
      resultOf("config.validate", {
        issues: ISSUES,
        valid: false,
        unreadSources: [],
      } satisfies ConfigValidatePayload),
    );
    expect(rendered.result).toContain("Configuration is not usable: 5 issues.");
    expect(rendered.result).not.toContain("diagnostics.levl");
    expect(flat(rendered.diagnostics)).toContain("no setting by this name exists.");
    expect(flat(rendered.diagnostics)).toContain("expected integer.");
    expect(flat(rendered.diagnostics)).toContain(
      "must be at least 1 bytes and at most 1024 bytes.",
    );
    expect(flat(rendered.diagnostics)).toContain("must be one of debug.");
    expect(flat(rendered.diagnostics)).toContain("is an old spelling of new.key");
  });

  test("reports a valid configuration explicitly", () => {
    expect(
      human(resultOf("config.validate", { issues: [], valid: true, unreadSources: [] })).result,
    ).toContain("Configuration is valid.");
  });

  test("never calls a configuration valid when a source could not be read", () => {
    const rendered = human(
      resultOf("config.validate", {
        issues: [],
        valid: true,
        unreadSources: [unreadSource("user-file", "unreadable")],
      } satisfies ConfigValidatePayload),
    );

    // The question asked was whether the configuration is right. Answering the
    // easier question — whether what loaded is usable — is the defect.
    expect(rendered.result).not.toContain("Configuration is valid.");
    expect(rendered.result).toContain("Configuration loaded without 1 source");
    expect(flat(rendered.diagnostics)).toContain(
      "The user-file configuration source could not be read and was skipped: /home/x/falryn.jsonc.",
    );
  });

  test("says which repair each unread source needs", () => {
    const rendered = human(
      resultOf("config.validate", {
        issues: [],
        valid: true,
        unreadSources: [
          unreadSource("user-file", "oversized"),
          unreadSource("project-file", "malformed-encoding"),
        ],
      } satisfies ConfigValidatePayload),
      { columns: 200 },
    );

    expect(rendered.result).toContain("Configuration loaded without 2 sources");
    expect(flat(rendered.diagnostics)).toContain("is larger than this build reads");
    expect(flat(rendered.diagnostics)).toContain("is not valid UTF-8 text");
  });
});

describe("doctor", () => {
  test("reports the roots, the database, and the ownership classes", () => {
    const rendered = human(resultOf("doctor", DOCTOR), { columns: 100 });
    expect(rendered.result).toContain("darwin arm64");
    expect(rendered.result).toContain("/tmp/falryn/state");
    expect(rendered.result).toContain("schema 3 of 3, current");
    expect(rendered.result).toContain("unregistered: extensions");
  });

  test("puts what it found on stderr", () => {
    const rendered = human(
      resultOf("doctor", {
        ...DOCTOR,
        rootIssues: ["override-outside-home"],
        storage: { kind: "unreadable", code: "corrupt" },
      }),
    );
    expect(flat(rendered.diagnostics)).toContain("The cache data root cannot hold data");
    expect(flat(rendered.diagnostics)).toContain("A data-root override was refused");
    expect(flat(rendered.diagnostics)).toContain("The database could not be read");
  });

  test("says so explicitly when it collected nothing", () => {
    expect(human(resultOf("doctor", null)).result).toBe("No diagnostics could be collected.");
  });
});

/* -------------------------------------------------------------------------- */
/* Quiet                                                                       */
/* -------------------------------------------------------------------------- */

describe("quiet", () => {
  test("emits one key=value line per set value, in the inspection's order", () => {
    const quiet = renderQuiet(
      resultOf(
        "config.show",
        showPayload([
          inspectedValue("diagnostics.level", "debug"),
          inspectedValue("limits.bytes", 4096),
          inspectedValue("never.set", null),
        ]),
      ),
    );
    expect(quiet.result).toBe("diagnostics.level=debug\nlimits.bytes=4096");
  });

  test("emits one path per line, in precedence order", () => {
    const quiet = renderQuiet(
      resultOf("config.path", {
        sources: [
          { kind: "user-file", path: "/a" },
          { kind: "project-file", path: "/b" },
        ],
      }),
    );
    expect(quiet.result).toBe("/a\n/b");
  });

  test("emits nothing for a verdict command, and its findings on stderr", () => {
    const validate = renderQuiet(
      resultOf("config.validate", {
        issues: [{ kind: "unknown-key", severity: "error", path: "a.b" }],
        valid: false,
        unreadSources: [],
      }),
    );
    expect(validate.result).toBe("");
    expect(flat(validate.diagnostics)).toContain("error: a.b: no setting by this name exists.");

    const doctor = renderQuiet(resultOf("doctor", DOCTOR));
    expect(doctor.result).toBe("");
    expect(flat(doctor.diagnostics)).toContain("The cache data root cannot hold data");
  });

  test("reports an unread source on stderr from both config commands", () => {
    const unread = [unreadSource("user-file", "unreadable")];

    const validate = renderQuiet(
      resultOf("config.validate", { issues: [], valid: true, unreadSources: unread }),
    );
    expect(validate.result).toBe("");
    expect(flat(validate.diagnostics)).toContain("could not be read and was skipped");

    const show = renderQuiet(
      resultOf("config.show", showPayload([inspectedValue("limits.bytes", 4096)], true, unread)),
    );
    // Quiet stdout is still only the values a caller asked for, and the notice
    // is still delivered rather than dropped for being inconvenient.
    expect(show.result).toBe("limits.bytes=4096");
    expect(flat(show.diagnostics)).toContain("could not be read and was skipped");
  });

  test("still reports a failure on stderr", () => {
    const quiet = renderQuiet(
      resultOf("config.show", null, {
        outcome: { kind: "failed", effect: "none" },
        errors: [failure()],
      }),
    );
    expect(quiet.result).toBe("");
    expect(quiet.diagnostics).toBe(
      "error: configuration-invalid: The configuration could not be loaded.",
    );
  });

  test("emits no heading, no label, no warning, and no colour", () => {
    const quiet = renderQuiet(
      resultOf("config.show", showPayload([inspectedValue("a.b", 1)]), {
        warnings: [{ code: "w", message: "A warning." }],
      }),
    );
    expect(quiet.result).toBe("a.b=1");
    expect(quiet.diagnostics).toBe("");
    expect(quiet.result).not.toContain(ESCAPE);
  });

  test("is not bounded, because a shortened primary result is a different answer", () => {
    const many = Array.from({ length: 500 }, (_, index) => inspectedValue(`s.k${index}`, index));
    expect(renderQuiet(resultOf("config.show", showPayload(many))).result.split("\n")).toHaveLength(
      500,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Width                                                                       */
/* -------------------------------------------------------------------------- */

describe("width", () => {
  test("wraps rather than truncating to an unreadable width", () => {
    const rendered = human(
      resultOf(
        "config.path",
        { sources: [] },
        {
          outcome: { kind: "timed-out", effect: "partial" },
          effect: { intent: "mutate", observed: "partial" },
        },
      ),
      { columns: 24 },
    );
    expect(rendered.diagnostics.split("\n").length).toBeGreaterThan(1);
    expect(flat(rendered.diagnostics)).toContain("inspect before retrying");
  });

  test("clamps a width below the narrowest usable one rather than looping on it", () => {
    for (const columns of [0, 1, 3]) {
      const rendered = human(resultOf("doctor", DOCTOR), { columns });
      expect(rendered.result.length).toBeGreaterThan(0);
    }
  });

  test("uses the declared default when the handle reported no width", () => {
    const absent = human(resultOf("doctor", DOCTOR), { columns: null });
    expect(absent).toEqual(human(resultOf("doctor", DOCTOR), { columns: 80 }));
  });

  test("measures a wide value by display width", () => {
    const rendered = human(
      resultOf("config.show", showPayload([inspectedValue("a.b", "日本語".repeat(60))])),
      { columns: 80 },
    );
    for (const line of rendered.result.split("\n")) {
      // Two cells per ideograph. Measuring by length would overflow by half.
      expect(line.length).toBeLessThan(80);
    }
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

  async function run(argv: readonly string[]) {
    const home = await mkdtemp(join(tmpdir(), "falryn-render-"));
    homes.push(home);
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv,
      streams,
      services: (globals: GlobalOptions) =>
        createServiceProvider(globals, {
          home: localPath(home),
          platform: "darwin",
          environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
        }),
    });
    return { code, out: streams.resultWrites().join(""), err: streams.diagnosticWrites().join("") };
  }

  test("keeps a human-format run's stdout free of everything but the result", async () => {
    const { out, err } = await run(["config", "show"]);
    expect(out).not.toContain("Completed.");
    expect(err).toContain("Completed.");
    expect(out).not.toContain(ESCAPE);
  });

  test("emits no ANSI on a handle that is not a terminal", async () => {
    const { out, err } = await run(["doctor"]);
    expect(out).not.toContain(ESCAPE);
    expect(err).not.toContain(ESCAPE);
  });

  test("writes nothing to stdout for a quiet verdict command", async () => {
    const { out, code } = await run(["--format", "quiet", "doctor"]);
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  test("writes only the primary result to stdout in quiet mode", async () => {
    const { out } = await run(["--format", "quiet", "config", "path"]);
    for (const line of out.split("\n").filter((entry) => entry !== "")) {
      expect(line.startsWith("/")).toBe(true);
    }
  });

  test("lets no rendered human text reach stdout in a machine format", async () => {
    // #19 owns these arms. Until then they must not leak this renderer's text
    // into a stream a parser is reading.
    for (const format of ["json", "jsonl"]) {
      const { out } = await run(["--format", format, "doctor"]);
      expect(out).not.toContain("Falryn diagnostics");
      expect(() => JSON.parse(out.trim())).not.toThrow();
    }
  });
});
