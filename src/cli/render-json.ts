/**
 * The JSON projection: one bounded terminal record.
 *
 * A pure function from a `CommandResult` and the time it finished to the single
 * line stdout carries. It holds no stream and no clock — the time is handed in,
 * for the same reason #18's renderer is handed the terminal facts rather than
 * deriving them.
 *
 * Two rules it enforces rather than documents:
 *
 * - **Exactly one terminal record, always.** A result that cannot be encoded
 *   becomes a `refusal` record, which is still terminal, so a consumer waiting
 *   for the run's outcome never waits forever.
 * - **A bound is an error, not a clamp.** An over-bound result is refused with a
 *   code and the bytes it would have taken. A trimmed object parses cleanly and
 *   a consumer reads it as the whole answer, which is the failure this exists to
 *   prevent.
 */

import { FIRST_SEQUENCE, type Timestamp } from "../domain/index.ts";
import type { RunCommandResult } from "./commands.ts";
import {
  type CliEncodeError,
  type CliRecord,
  cliRefusalRecord,
  cliResultRecord,
  encodeCliRecord,
} from "./schema.ts";

/**
 * What a machine projection produces.
 *
 * `result` is a list of lines rather than one text, because JSON Lines writes
 * more than one record and a reader may leave between any two of them. The
 * caller writes them in order and stops when the reader is gone.
 */
export type RenderedRecords = {
  readonly result: readonly string[];
  /** Never the result. Empty unless a record could not be emitted. */
  readonly diagnostics: string;
};

export type MachineRenderRequest = {
  readonly result: RunCommandResult;
  /** When the run finished. Supplied by the caller, so this stays pure. */
  readonly occurredAt: Timestamp;
};

/** The body of a terminal record, taken from the result without reshaping it. */
export function resultBodyOf(result: RunCommandResult) {
  return {
    outcome: result.outcome,
    effect: result.effect,
    payload: result.payload,
    errors: result.errors,
    warnings: result.warnings,
    omissions: result.omissions,
    truncation: result.truncation,
    correlation: result.correlation,
  };
}

/** One versioned, bounded, deterministic object. */
export function renderJson(request: MachineRenderRequest): RenderedRecords {
  const { result, occurredAt } = request;
  const record = cliResultRecord(result.command, FIRST_SEQUENCE, occurredAt, resultBodyOf(result));
  return emitTerminal(record, result.command, occurredAt);
}

/**
 * One terminal record, or the refusal that replaces it.
 *
 * Shared with the JSON Lines projection: both end in exactly one terminal
 * record, and both have to answer the same way when the result will not encode.
 */
export function emitTerminal(
  record: CliRecord,
  command: string,
  occurredAt: Timestamp,
): RenderedRecords {
  const encoded = encodeCliRecord(record);
  if (encoded.ok) {
    return { result: [encoded.text], diagnostics: "" };
  }
  return refusalFor(record, command, occurredAt, encoded.error);
}

function refusalFor(
  original: CliRecord,
  command: string,
  occurredAt: Timestamp,
  error: CliEncodeError,
): RenderedRecords {
  const refusal = cliRefusalRecord(command, original.sequence, occurredAt, error);
  const encoded = encodeCliRecord(refusal);
  const notice = `The result could not be emitted: ${error.code}${error.path === "" ? "" : ` at ${error.path}`}.`;

  // The refusal carries nothing that came from the result, so this branch is
  // unreachable in practice. It is written rather than asserted because the
  // alternative — throwing from a projection — would lose the run's outcome
  // entirely, which is the one thing this format exists to deliver.
  return encoded.ok
    ? { result: [encoded.text], diagnostics: notice }
    : { result: [], diagnostics: `${notice} The refusal record could not be emitted either.` };
}
