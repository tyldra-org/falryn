/**
 * The one value every command produces and every projection renders.
 *
 * `CommandOutcome` is already taken by `src/domain/process.ts` for a child
 * process's result, so this is `CommandResult`. The two are deliberately
 * different things: a child process exiting non-zero does not make the Falryn
 * command that ran it fail, and keeping the names apart keeps that from being
 * blurred at a call site.
 *
 * It is a plain data value. No renderer, no stream, no colour, no terminal
 * width — that is what makes #18's and #19's projections pure functions of it,
 * and what lets a test assert a command's whole answer without a handle.
 *
 * Three rules the shape enforces rather than documents:
 *
 * - **The outcome is the domain's.** `TerminalOutcome` is reused from
 *   `src/domain/outcome.ts`, never re-declared, so a command's terminal state
 *   and a turn's are the same closed union and map through the same exit table.
 * - **Requested intent and observed effect are separate fields.** A command
 *   that asked to change something and could not observe whether it did reports
 *   both, because collapsing them is how a caller retries a change that already
 *   happened.
 * - **Truncation is never silent.** Anything summarized carries how much was
 *   left out and the route to the rest, so a projection can shorten output
 *   without a reader losing the fact that it did.
 */

import type {
  CorrelationIds,
  EffectCertainty,
  FalrynError,
  TerminalOutcome,
} from "../domain/index.ts";

/**
 * Stable name of this schema family.
 *
 * Its source owner is this module. A machine projection writes this and its
 * version so a consumer can tell an added field from a changed contract.
 */
export const COMMAND_RESULT_SCHEMA_FAMILY = "falryn.command-result";

/** Schema version this build writes and can fully interpret. */
export const COMMAND_RESULT_SCHEMA_VERSION = 1;

/**
 * Every command this build declares.
 *
 * A closed union rather than a string, so a projection switching on it is
 * exhaustive and a command cannot be rendered by a branch that was never
 * written for it. Groups whose capability does not exist in v0.1 are absent:
 * a tree advertising `run` would promise behavior nothing implements.
 */
export const COMMAND_IDS = [
  /** The no-argument invocation, which prints help until #21 lands the shell. */
  "default",
  "config.show",
  "config.validate",
  "config.path",
  "doctor",
  /** Help for the root or for a subcommand. */
  "help",
  "version",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && (COMMAND_IDS as readonly string[]).includes(value);
}

/** Longest single warning or omission reason. Longer text is truncated where it is built. */
export const MAX_NOTICE_LENGTH = 300;

/** Warnings kept on one result. Beyond this the tail is dropped and counted. */
export const MAX_WARNINGS = 64;

/**
 * Something the command wants the operator to know that is not a failure.
 *
 * Carried as data rather than written to stderr at the point it is noticed, so
 * a machine projection can emit it as a field and a human projection can print
 * it — from the same value, in the same order.
 */
export type CommandWarning = {
  /** Stable, matchable identity. Never a sentence. */
  readonly code: string;
  /** Safe to show and safe to log. Never carries input, secrets, or file content. */
  readonly message: string;
};

/**
 * Something the command deliberately left out of its answer.
 *
 * Distinct from a warning: an omission is a statement about the completeness of
 * the payload, and a reader that ignores it has an answer that looks whole and
 * is not.
 */
export type CommandOmission = {
  readonly code: string;
  readonly message: string;
  /** How many items were left out, or `null` when the count is not knowable. */
  readonly count: number | null;
};

/**
 * What was summarized, and how to get the rest.
 *
 * `expansion` names a concrete invocation rather than prose, so a projection
 * can print a command a reader can actually run.
 */
export type CommandTruncation = {
  readonly of: string;
  readonly shown: number;
  readonly total: number;
  /** The invocation that returns the untruncated form, or `null` when there is none. */
  readonly expansion: string | null;
};

/**
 * What the command intended to change, and what it observed.
 *
 * `intent` is declared before the work runs and `observed` after, so a command
 * that meant to change nothing and a command that meant to change something and
 * could not tell are distinguishable. A read-only command declares
 * `intent: "none"` and observes `none`.
 */
export type CommandEffect = {
  readonly intent: "none" | "mutate";
  readonly observed: EffectCertainty;
};

/** The effect of a command that reads and never writes. */
export const READ_ONLY_EFFECT: CommandEffect = { intent: "none", observed: "none" };

/**
 * One command's complete answer.
 *
 * The payload is generic so each command declares its own, and every other
 * field is the same for all of them — which is what lets one projection render
 * any command without knowing which it is.
 */
export type CommandResult<Payload> = {
  readonly schemaFamily: typeof COMMAND_RESULT_SCHEMA_FAMILY;
  readonly schemaVersion: number;
  readonly command: CommandId;
  readonly outcome: TerminalOutcome;
  readonly effect: CommandEffect;
  /**
   * The command's own answer.
   *
   * `null` when the command failed before it had one. A payload and a failure
   * are not mutually exclusive: a partially-completed read reports what it did
   * read alongside the error that stopped it.
   */
  readonly payload: Payload | null;
  /** Failures, in the order they occurred. Empty on a clean run. */
  readonly errors: readonly FalrynError[];
  readonly warnings: readonly CommandWarning[];
  readonly omissions: readonly CommandOmission[];
  readonly truncation: readonly CommandTruncation[];
  readonly correlation: CorrelationIds;
};

/** Whether the command's own work succeeded, whatever its subject reported. */
export function succeeded<Payload>(result: CommandResult<Payload>): boolean {
  return result.outcome.kind === "completed";
}

/** Whether anything in this result was summarized or left out. */
export function isComplete<Payload>(result: CommandResult<Payload>): boolean {
  return result.omissions.length === 0 && result.truncation.length === 0;
}
