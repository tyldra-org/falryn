import { describe, expect, test } from "bun:test";

import {
  type EffectCertainty,
  ERROR_CATEGORIES,
  type ErrorCategory,
  EXIT_CATEGORIES,
  type ExitCategory,
  type FalrynError,
  NO_CORRELATION,
  RUNTIME_EMITTED_CATEGORIES,
  type TerminalOutcome,
} from "../domain/index.ts";
import {
  DECLARED_EXIT_CODES,
  EMITTABLE_EXIT_CODES,
  EXIT_CODES,
  type ExitCode,
  exitCodeForError,
  resolveExitCode,
  SHELL_RESERVED_EXIT_CODES,
  UNEMITTABLE_EXIT_CODES,
} from "./exit.ts";

function failure(overrides: Partial<FalrynError> = {}): FalrynError {
  return {
    code: "test",
    category: "internal",
    message: "something failed",
    retryable: false,
    effect: "none",
    cause: null,
    correlation: NO_CORRELATION,
    recovery: [],
    exitCategory: "runtime-error",
    related: [],
    relatedDropped: 0,
    recognized: true,
    ...overrides,
  };
}

const FAILED: TerminalOutcome = { kind: "failed", effect: "none" };

describe("the frozen table", () => {
  test("declares exactly the thirteen codes this delivery froze", () => {
    expect(DECLARED_EXIT_CODES).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 70, 124, 130]);
  });

  test("never assigns a code the shell owns", () => {
    for (const reserved of SHELL_RESERVED_EXIT_CODES) {
      // 126, 127, and 128 mean "could not run Falryn". A Falryn outcome that
      // produced one would be indistinguishable from Falryn not existing.
      expect(DECLARED_EXIT_CODES).not.toContain(reserved);
    }
  });

  test("keeps every code inside the range a process may exit with", () => {
    for (const code of DECLARED_EXIT_CODES) {
      expect(Number.isInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThan(256);
    }
  });
});

describe("a completed run", () => {
  test("exits zero", () => {
    expect(resolveExitCode({ outcome: { kind: "completed" }, error: null })).toBe(
      EXIT_CODES.COMPLETED,
    );
  });

  test("exits zero even when a failure was carried alongside the completion", () => {
    // The outcome decides. A completed run that collected a non-fatal failure
    // along the way still completed, and reporting the failure is the result's
    // job rather than the exit status's.
    expect(
      resolveExitCode({
        outcome: { kind: "completed" },
        error: failure({ category: "configuration", exitCategory: "user-error" }),
      }),
    ).toBe(0);
  });
});

describe("effect certainty", () => {
  test("outranks the outcome that carried it", () => {
    // The whole reason effect is carried separately from outcome. A caller that
    // read 130 and retried would repeat a change that already happened.
    expect(
      resolveExitCode({ outcome: { kind: "cancelled", effect: "partial" }, error: null }),
    ).toBe(EXIT_CODES.UNCERTAIN_EFFECT);
    expect(
      resolveExitCode({ outcome: { kind: "cancelled", effect: "uncertain" }, error: null }),
    ).toBe(8);
    expect(
      resolveExitCode({ outcome: { kind: "timed-out", effect: "uncertain" }, error: null }),
    ).toBe(8);
    expect(
      resolveExitCode({ outcome: { kind: "uncertain", effect: "uncertain" }, error: null }),
    ).toBe(8);
  });

  test("outranks the error's own category", () => {
    expect(
      resolveExitCode({
        outcome: { kind: "failed", effect: "uncertain" },
        error: failure({ category: "configuration", exitCategory: "user-error" }),
      }),
    ).toBe(8);
  });

  test("is read from the error when the outcome recorded less", () => {
    // An outcome that recorded no effect over an error that observed an
    // uncertain one would lose the only fact the retry decision needs.
    expect(
      resolveExitCode({
        outcome: FAILED,
        error: failure({ category: "data", exitCategory: "user-error", effect: "uncertain" }),
      }),
    ).toBe(8);
  });

  test("leaves a fully-applied or absent effect alone", () => {
    for (const effect of ["none", "completed"] satisfies EffectCertainty[]) {
      expect(resolveExitCode({ outcome: { kind: "cancelled", effect }, error: null })).toBe(
        EXIT_CODES.CANCELLED,
      );
      expect(resolveExitCode({ outcome: { kind: "timed-out", effect }, error: null })).toBe(
        EXIT_CODES.TIMED_OUT,
      );
    }
  });
});

describe("a failure", () => {
  test("with no error attached says only that it failed", () => {
    expect(resolveExitCode({ outcome: FAILED, error: null })).toBe(EXIT_CODES.OPERATION_FAILED);
  });

  test("resolves through its category when the exit category permits it", () => {
    const expected: Readonly<Record<ErrorCategory, ExitCode>> = {
      bootstrap: EXIT_CODES.UNAVAILABLE,
      configuration: EXIT_CODES.CONFIGURATION,
      authentication: EXIT_CODES.AUTHENTICATION,
      provider: EXIT_CODES.PROVIDER_OR_NETWORK,
      context: EXIT_CODES.OPERATION_FAILED,
      tool: EXIT_CODES.WORKSPACE_OR_TOOL,
      workspace: EXIT_CODES.WORKSPACE_OR_TOOL,
      process: EXIT_CODES.OPERATION_FAILED,
      integration: EXIT_CODES.UNAVAILABLE,
      data: EXIT_CODES.INVALID_USAGE,
      cancellation: EXIT_CODES.CANCELLED,
      internal: EXIT_CODES.INTERNAL,
    };

    for (const category of ERROR_CATEGORIES) {
      expect(exitCodeForError(failure({ category, exitCategory: "runtime-error" }))).toBe(
        expected[category],
      );
      expect(exitCodeForError(failure({ category, exitCategory: "user-error" }))).toBe(
        expected[category],
      );
    }
  });

  test("is internal whenever the exit category says so, whatever the category", () => {
    for (const category of ERROR_CATEGORIES) {
      // A surface reporting 2 for an internal failure would send the user off
      // to check input that was never the problem.
      expect(exitCodeForError(failure({ category, exitCategory: "internal" }))).toBe(
        EXIT_CODES.INTERNAL,
      );
    }
  });

  test("is cancelled whenever the exit category says so", () => {
    for (const category of ERROR_CATEGORIES) {
      expect(exitCodeForError(failure({ category, exitCategory: "cancelled" }))).toBe(
        EXIT_CODES.CANCELLED,
      );
    }
  });

  test("this build does not recognize resolves to internal and nothing else", () => {
    for (const category of ERROR_CATEGORIES) {
      for (const exitCategory of EXIT_CATEGORIES satisfies readonly ExitCategory[]) {
        // Preserved as observed, never reinterpreted onto a category-specific
        // code it was never entitled to.
        expect(exitCodeForError(failure({ category, exitCategory, recognized: false }))).toBe(
          EXIT_CODES.INTERNAL,
        );
      }
    }
  });

  test("resolves the same whether asked through the outcome or the error alone", () => {
    const error = failure({ category: "authentication", exitCategory: "user-error" });
    expect(resolveExitCode({ outcome: FAILED, error })).toBe(exitCodeForError(error));
  });
});

describe("what this build can actually emit", () => {
  test("is derived from the categories the runtime emits", () => {
    // Derived rather than listed, so a category joining the emitted set widens
    // this in the same commit instead of leaving a stale claim behind.
    expect(EMITTABLE_EXIT_CODES).toEqual([0, 1, 2, 3, 4, 5, 8, 70, 124, 130]);
    for (const category of RUNTIME_EMITTED_CATEGORIES) {
      expect(EMITTABLE_EXIT_CODES).toContain(
        exitCodeForError(failure({ category, exitCategory: "runtime-error" })),
      );
    }
  });

  test("reaches 124 and 130 from a command, not only from a staged outcome", () => {
    // Both were declared and emittable before anything produced them. A
    // `--timeout` that expires and an interrupt now do, through the scope an
    // invocation runs under — proven on real processes in
    // `src/cli/process-boundary.test.ts`, and resolved here.
    expect(resolveExitCode({ outcome: { kind: "timed-out", effect: "none" }, error: null })).toBe(
      EXIT_CODES.TIMED_OUT,
    );
    expect(resolveExitCode({ outcome: { kind: "cancelled", effect: "none" }, error: null })).toBe(
      EXIT_CODES.CANCELLED,
    );
    // And the one a cancellation becomes when the run had already changed
    // something, which the scope tree decides rather than this table.
    expect(
      resolveExitCode({ outcome: { kind: "uncertain", effect: "uncertain" }, error: null }),
    ).toBe(EXIT_CODES.UNCERTAIN_EFFECT);
  });

  test("leaves the rest declared and unreachable", () => {
    expect(UNEMITTABLE_EXIT_CODES).toEqual([
      EXIT_CODES.PROVIDER_OR_NETWORK,
      EXIT_CODES.WORKSPACE_OR_TOOL,
      EXIT_CODES.COMPATIBILITY_REFUSAL,
    ]);
  });

  test("partitions the declared set exactly", () => {
    expect([...EMITTABLE_EXIT_CODES, ...UNEMITTABLE_EXIT_CODES].sort((a, b) => a - b)).toEqual([
      ...DECLARED_EXIT_CODES,
    ]);
  });

  test("has no unreachable code produced by any emittable category", () => {
    for (const category of RUNTIME_EMITTED_CATEGORIES) {
      for (const exitCategory of EXIT_CATEGORIES) {
        expect(UNEMITTABLE_EXIT_CODES).not.toContain(
          exitCodeForError(failure({ category, exitCategory })),
        );
      }
    }
  });
});
