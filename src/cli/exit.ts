/**
 * Falryn's numeric exit table.
 *
 * `src/domain/error.ts` declares `ExitCategory` and states that choosing the
 * numeric values belongs to the CLI owner. This module is that owner, and the
 * values below are frozen by this delivery.
 *
 * Four values of `ExitCategory` cannot distinguish the outcomes the CLI
 * reference names, so resolution reads three things together: the terminal
 * outcome, the error's `exitCategory`, and the error's `category`. The
 * `exitCategory` decides whether the category is allowed to speak at all; the
 * category is the finer axis and supplies the number when it is.
 *
 * Three rules the resolution enforces rather than documents:
 *
 * - **Effect certainty outranks the failure.** A cancelled operation that
 *   already changed something exits `UNCERTAIN_EFFECT`, not `CANCELLED`. That
 *   is the entire reason effect is carried separately from outcome: a caller
 *   that reads `130` and retries would repeat a change that already happened.
 * - **An unrecognized error gets the internal code.** An error preserved from a
 *   newer or foreign producer is never resolved to a category-specific code it
 *   was never entitled to.
 * - **126, 127, and 128 are never assigned.** The shell owns them, and a Falryn
 *   run that produced one would be indistinguishable from a Falryn that could
 *   not be executed.
 *
 * A successful Falryn invocation whose *subject* failed is a separate axis. The
 * table maps the Falryn command's outcome; a child process's status lives in
 * the structured result.
 */

import {
  assertNever,
  type ErrorCategory,
  effectOf,
  type FalrynError,
  RUNTIME_EMITTED_CATEGORIES,
  type TerminalOutcome,
} from "../domain/index.ts";

/**
 * Every code this build declares.
 *
 * Declared is not the same as emitted. The vocabulary exists so later owners
 * attach to it, following the `RUNTIME_EMITTED_CATEGORIES` precedent: a v0.1
 * run producing `PROVIDER_OR_NETWORK` would be a claim about behavior that does
 * not exist. Which subset is reachable today is derived below and asserted.
 */
export const EXIT_CODES = {
  /** The command did what it was asked. */
  COMPLETED: 0,
  /** The operation failed, with nothing more specific to say. */
  OPERATION_FAILED: 1,
  /** The invocation or its input was not valid. */
  INVALID_USAGE: 2,
  CONFIGURATION: 3,
  AUTHENTICATION: 4,
  /** A required capability or dependency was unavailable. */
  UNAVAILABLE: 5,
  PROVIDER_OR_NETWORK: 6,
  WORKSPACE_OR_TOOL: 7,
  /** Something outside Falryn may have changed, and it was not observed. */
  UNCERTAIN_EFFECT: 8,
  COMPATIBILITY_REFUSAL: 9,
  INTERNAL: 70,
  TIMED_OUT: 124,
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const DECLARED_EXIT_CODES: readonly ExitCode[] = Object.values(EXIT_CODES).sort(
  (left, right) => left - right,
);

/**
 * Codes the shell owns, which Falryn never assigns.
 *
 * 126 is "found but not executable", 127 is "not found", and 128 is the base a
 * signal status is added to. Assigning one would make a Falryn outcome
 * indistinguishable from a failure to run Falryn at all.
 */
export const SHELL_RESERVED_EXIT_CODES: readonly number[] = [126, 127, 128];

/**
 * The code each error category resolves to.
 *
 * Total over the vocabulary on purpose: a category added later fails to compile
 * here rather than falling through to a default that means something else.
 */
const CODE_BY_CATEGORY: Readonly<Record<ErrorCategory, ExitCode>> = {
  // Startup could not establish what it needs, which is an unavailable
  // dependency rather than a failed operation.
  bootstrap: EXIT_CODES.UNAVAILABLE,
  configuration: EXIT_CODES.CONFIGURATION,
  authentication: EXIT_CODES.AUTHENTICATION,
  provider: EXIT_CODES.PROVIDER_OR_NETWORK,
  // Context work that failed is the operation failing; there is no separate
  // code for it and inventing one would freeze a number nothing reads.
  context: EXIT_CODES.OPERATION_FAILED,
  tool: EXIT_CODES.WORKSPACE_OR_TOOL,
  workspace: EXIT_CODES.WORKSPACE_OR_TOOL,
  process: EXIT_CODES.OPERATION_FAILED,
  // An integration that is absent or refused is a dependency this run needed
  // and did not have.
  integration: EXIT_CODES.UNAVAILABLE,
  // Data that did not validate is invalid input, whether it arrived on stdin,
  // in a file, or from a durable record this build cannot read.
  data: EXIT_CODES.INVALID_USAGE,
  cancellation: EXIT_CODES.CANCELLED,
  internal: EXIT_CODES.INTERNAL,
};

/** The code an error resolves to on its own, ignoring the outcome around it. */
export function exitCodeForError(error: FalrynError): ExitCode {
  // A code this build did not recognize was preserved rather than
  // reinterpreted, so it has not earned a category-specific number.
  if (!error.recognized) {
    return EXIT_CODES.INTERNAL;
  }

  switch (error.exitCategory) {
    // Both of these outrank the category: an internal failure carrying a
    // `data` category is still internal, and a surface that reported `2` for
    // it would send the user to check their input.
    case "internal":
      return EXIT_CODES.INTERNAL;
    case "cancelled":
      return EXIT_CODES.CANCELLED;
    case "user-error":
    case "runtime-error":
      return CODE_BY_CATEGORY[error.category];
    default:
      return assertNever(error.exitCategory, "unhandled exit category");
  }
}

export type ExitResolution = {
  readonly outcome: TerminalOutcome;
  /**
   * The failure that ended the run, or `null` when there was none.
   *
   * Present and nullable rather than optional, the convention
   * `src/domain/error.ts` states for `CorrelationIds`: an optional nullable
   * field has three spellings for two facts, and a caller would have to
   * distinguish "absent" from "not applicable" to read it.
   */
  readonly error: FalrynError | null;
};

/**
 * The exit code for one Falryn invocation.
 *
 * Order matters and is the contract: completion first, then effect certainty,
 * then the outcome, then the error.
 */
export function resolveExitCode(resolution: ExitResolution): ExitCode {
  const { outcome, error } = resolution;

  if (outcome.kind === "completed") {
    return EXIT_CODES.COMPLETED;
  }

  // Ahead of everything below, including cancellation and timeout. The caller
  // has to inspect before it retries, and no failure-shaped code says that.
  const effect = worstEffect(effectOf(outcome), error);
  if (effect === "uncertain" || effect === "partial") {
    return EXIT_CODES.UNCERTAIN_EFFECT;
  }

  switch (outcome.kind) {
    case "cancelled":
      return EXIT_CODES.CANCELLED;
    case "timed-out":
      return EXIT_CODES.TIMED_OUT;
    case "uncertain":
      // Unreachable: `uncertain` always carries uncertain effect, which the
      // check above already answered. Kept so the switch stays exhaustive.
      return EXIT_CODES.UNCERTAIN_EFFECT;
    case "failed":
      // A failure with no error attached says only that it failed. Resolving it
      // to anything more specific would be inventing a diagnosis.
      return error === null ? EXIT_CODES.OPERATION_FAILED : exitCodeForError(error);
    default:
      return assertNever(outcome, "unhandled terminal outcome");
  }
}

/**
 * The less certain of what the outcome and the error each observed.
 *
 * An outcome that recorded no effect over an error that recorded an uncertain
 * one would lose the only fact that matters for the retry decision.
 */
function worstEffect(
  outcomeEffect: ReturnType<typeof effectOf>,
  error: FalrynError | null,
): ReturnType<typeof effectOf> {
  if (error === null) {
    return outcomeEffect;
  }
  const rank = { none: 0, completed: 1, partial: 2, uncertain: 3 } as const;
  return rank[error.effect] > rank[outcomeEffect] ? error.effect : outcomeEffect;
}

/**
 * The codes a v0.1 run can actually produce.
 *
 * Derived from the categories the runtime emits rather than listed by hand, so
 * a category joining `RUNTIME_EMITTED_CATEGORIES` widens this set in the same
 * commit instead of leaving a stale claim behind.
 */
export const EMITTABLE_EXIT_CODES: readonly ExitCode[] = [
  ...new Set<ExitCode>([
    EXIT_CODES.COMPLETED,
    // A failure with no error attached, which the bootstrap can still produce.
    EXIT_CODES.OPERATION_FAILED,
    EXIT_CODES.UNCERTAIN_EFFECT,
    EXIT_CODES.TIMED_OUT,
    EXIT_CODES.CANCELLED,
    // An unrecognized error resolves here whatever category it claims.
    EXIT_CODES.INTERNAL,
    ...RUNTIME_EMITTED_CATEGORIES.map((category) => CODE_BY_CATEGORY[category]),
  ]),
].sort((left, right) => left - right);

/** Declared codes no path in this build can reach yet. */
export const UNEMITTABLE_EXIT_CODES: readonly ExitCode[] = DECLARED_EXIT_CODES.filter(
  (code) => !EMITTABLE_EXIT_CODES.includes(code),
);
