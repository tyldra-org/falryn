/**
 * The launch decision, across every combination that changes it.
 *
 * This file needs no terminal, no renderer, and no native library, which is the
 * whole reason the decision was written as a pure function. The condition it
 * governs — whether a user's `falryn` opens an interface or prints help — is the
 * one most likely to be wrong on a machine nobody tested on, and it is exactly
 * the kind of thing that becomes untestable the moment it is entangled with the
 * renderer it decides about.
 */

import { describe, expect, test } from "bun:test";
import type { GlobalOptions, OutputFormat } from "../cli/index.ts";
import {
  createStaticEnvironment,
  type ObservedHandles,
  terminalCapabilities,
} from "../domain/index.ts";
import { shellCapabilities } from "./capabilities.ts";
import {
  decideLaunch,
  NON_LAUNCH_REASONS,
  type NonLaunchReason,
  nonLaunchNotice,
} from "./launch.ts";

const INTERACTIVE: ObservedHandles = {
  stdout: { isTty: true, columns: 120, rows: 40 },
  stderr: { isTty: true, columns: 120, rows: 40 },
  stdin: { isTty: true },
};

const DEFAULTS: GlobalOptions = {
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

function record(
  handles: ObservedHandles = INTERACTIVE,
  variables: Readonly<Record<string, string>> = { TERM: "xterm-256color" },
) {
  const environment = createStaticEnvironment(variables);
  return shellCapabilities({ handles: terminalCapabilities(handles, environment), environment });
}

function decide(
  handles: ObservedHandles = INTERACTIVE,
  options: Partial<GlobalOptions> = {},
  variables: Readonly<Record<string, string>> = { TERM: "xterm-256color" },
) {
  return decideLaunch(record(handles, variables), { ...DEFAULTS, ...options });
}

describe("a terminal that can host the shell", () => {
  test("launches, and reports the size it will be laid out against", () => {
    expect(decide()).toEqual({ kind: "launch", columns: 120, rows: 40 });
  });

  test("launches inside a multiplexer, over ssh, and on a plain xterm", () => {
    // None of these is a reason to refuse. They are recorded as hints because
    // they change how rendering behaves, not whether it can happen at all —
    // and a refusal here would lock out most of the terminals Falryn will
    // actually run in.
    for (const variables of [
      { TERM: "screen-256color", TMUX: "/tmp/tmux-501/default,1,0" },
      { TERM: "xterm-256color", SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
      { TERM: "xterm" },
    ]) {
      expect(decide(INTERACTIVE, {}, variables).kind).toBe("launch");
    }
  });

  test("launches in CI when a terminal is genuinely attached", () => {
    // `CI` is a hint about the session, not a fact about the handles. A CI job
    // that allocated a TTY on purpose gets what it asked for; a CI job that did
    // not is already refused by the handles themselves.
    expect(decide(INTERACTIVE, {}, { TERM: "xterm-256color", CI: "true" }).kind).toBe("launch");
  });
});

describe("a run that asked for something else", () => {
  test("reports the format rather than the terminal", () => {
    // Precedence, and it matters: a perfect terminal running `--format json` is
    // a machine run. Reporting `not-a-tty` would send someone to check a handle
    // that was never the problem.
    for (const format of ["json", "jsonl", "quiet"] satisfies OutputFormat[]) {
      expect(decide(INTERACTIVE, { format })).toEqual({
        kind: "declined",
        reason: "machine-format",
      });
    }
  });

  test("reports --non-interactive rather than the terminal", () => {
    expect(decide(INTERACTIVE, { nonInteractive: true })).toEqual({
      kind: "declined",
      reason: "non-interactive",
    });
  });

  test("reports the format even when the terminal would also have refused", () => {
    // The caller's own statement outranks every environmental fact below it, so
    // the reason is stable rather than dependent on which check ran first.
    expect(decide({ ...INTERACTIVE, stdin: { isTty: false } }, { format: "json" })).toEqual({
      kind: "declined",
      reason: "machine-format",
    });
  });
});

describe("the documented override", () => {
  test("refuses the shell when it says off", () => {
    expect(decide(INTERACTIVE, {}, { TERM: "xterm-256color", FALRYN_TUI: "off" })).toEqual({
      kind: "declined",
      reason: "unsupported",
    });
  });

  test("is believed over a terminal that looks perfectly capable", () => {
    // The entire point of an override: detection can be wrong on a terminal
    // nobody has tried, and a user needs a way to say so without a release.
    expect(decide(INTERACTIVE, {}, { TERM: "xterm-256color", FALRYN_TUI: "OFF" }).kind).toBe(
      "declined",
    );
  });

  test("does not refuse on a value this build does not understand", () => {
    // A typo must not turn into a terminal that cannot run Falryn. The caller
    // reports the unrecognized value and carries on with detection.
    expect(decide(INTERACTIVE, {}, { TERM: "xterm-256color", FALRYN_TUI: "sput" }).kind).toBe(
      "launch",
    );
  });

  test("naming a screen mode is not a refusal", () => {
    expect(
      decide(INTERACTIVE, {}, { TERM: "xterm-256color", FALRYN_TUI: "alternate-screen" }).kind,
    ).toBe("launch");
  });
});

describe("handles that cannot carry an interface", () => {
  test("refuses when stdin is not a terminal", () => {
    // No key can arrive, so there is nothing to interact with — `falryn < file`.
    expect(decide({ ...INTERACTIVE, stdin: { isTty: false } })).toEqual({
      kind: "declined",
      reason: "not-a-tty",
    });
  });

  test("refuses when either output handle is captured", () => {
    // `falryn > out` and `falryn 2> log` both put frames somewhere a person is
    // not looking, and stderr is where every diagnostic the shell can still
    // emit has to land.
    for (const handles of [
      { ...INTERACTIVE, stdout: { isTty: false, columns: null, rows: null } },
      { ...INTERACTIVE, stderr: { isTty: false, columns: null, rows: null } },
    ] satisfies ObservedHandles[]) {
      expect(decide(handles)).toEqual({ kind: "declined", reason: "piped-output" });
    }
  });

  test("refuses a dumb terminal", () => {
    expect(decide(INTERACTIVE, {}, { TERM: "dumb" })).toEqual({
      kind: "declined",
      reason: "dumb-terminal",
    });
  });
});

describe("a terminal with no usable size", () => {
  test("refuses rather than substituting one", () => {
    // The failure this guards is `columns ?? 80`: a terminal that reports
    // nothing is not a narrow terminal, and every layout decision taken from a
    // substituted size would be wrong in a way nobody could see.
    expect(decide({ ...INTERACTIVE, stdout: { isTty: true, columns: null, rows: null } })).toEqual({
      kind: "declined",
      reason: "no-dimensions",
    });
  });

  test("refuses zero and absurd dimensions the same way", () => {
    // The domain's own bound already turns both into "no size", so this is
    // asserting that the decision reads that answer rather than the raw number.
    for (const stdout of [
      { isTty: true, columns: 0, rows: 40 },
      { isTty: true, columns: 120, rows: 0 },
      { isTty: true, columns: 10_001, rows: 40 },
    ]) {
      expect(decide({ ...INTERACTIVE, stdout }).kind).toBe("declined");
    }
  });
});

describe("every reason", () => {
  test("has a notice that names the observation", () => {
    for (const reason of NON_LAUNCH_REASONS) {
      const notice = nonLaunchNotice(reason);
      expect(notice.length).toBeGreaterThan(0);
      // Every refusal keeps the behavior the invocation had before the shell
      // existed, and every notice has to say so — a line that only stated a
      // problem would leave the user wondering what they got instead.
      expect(notice).toMatch(/help|skipped/);
    }
  });

  test("is reachable from some combination, so none is a dead branch", () => {
    const reached = new Set<NonLaunchReason>();
    for (const decision of [
      decide(INTERACTIVE, { format: "json" }),
      decide(INTERACTIVE, { nonInteractive: true }),
      decide(INTERACTIVE, {}, { TERM: "xterm", FALRYN_TUI: "off" }),
      decide({ ...INTERACTIVE, stdin: { isTty: false } }),
      decide({ ...INTERACTIVE, stdout: { isTty: false, columns: null, rows: null } }),
      decide(INTERACTIVE, {}, { TERM: "dumb" }),
      decide({ ...INTERACTIVE, stdout: { isTty: true, columns: null, rows: null } }),
    ]) {
      if (decision.kind === "declined") {
        reached.add(decision.reason);
      }
    }
    expect([...reached].sort()).toEqual([...NON_LAUNCH_REASONS].sort());
  });
});
