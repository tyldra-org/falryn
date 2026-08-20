/**
 * The JSON projection: one bounded terminal record.
 *
 * A pure function from a `CommandResult` and the time it finished to the single
 * line stdout carries — until an over-bound result needs the artifact store.
 * Spilling the full result is the only side effect, and it is optional: a
 * caller that cannot reach a store still gets a terminal refusal.
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
  type CliArtifactErrorCode,
  type CliArtifactHandle,
  type CliEncodeError,
  type CliRecord,
  type CliRefusalArtifact,
  type CliResultBody,
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

/**
 * Where an over-bound result's bytes are written, when a store is reachable.
 *
 * Returns a handle the consumer can resolve through `falryn artifact get`, or a
 * code naming why the spill failed. The refusal still emits either way.
 */
export type OverBoundArtifactWriter = (input: {
  readonly bytes: Uint8Array;
}) => Promise<
  | { readonly ok: true; readonly artifact: CliArtifactHandle }
  | { readonly ok: false; readonly code: CliArtifactErrorCode }
>;

export type MachineRenderRequest = {
  readonly result: RunCommandResult;
  /** When the run finished. Supplied by the caller, so this stays pure. */
  readonly occurredAt: Timestamp;
  /**
   * Spills an over-bound result into the artifact store.
   *
   * Absent in pure tests: the refusal still emits with `artifact: null` and no
   * `artifactError`, because no spill was attempted.
   */
  readonly storeOverBound?: OverBoundArtifactWriter;
};

/** The body of a terminal record, taken from the result without reshaping it. */
export function resultBodyOf(result: RunCommandResult): CliResultBody {
  return {
    outcome: result.outcome,
    effect: result.effect,
    payload: result.payload,
    errors: result.errors,
    warnings: result.warnings,
    omissions: result.omissions,
    truncation: result.truncation,
    artifacts: result.artifacts,
    correlation: result.correlation,
  };
}

/** One versioned, bounded, deterministic object. */
export async function renderJson(request: MachineRenderRequest): Promise<RenderedRecords> {
  const { result, occurredAt, storeOverBound } = request;
  const record = cliResultRecord(result.command, FIRST_SEQUENCE, occurredAt, resultBodyOf(result));
  return emitTerminal(record, result.command, occurredAt, storeOverBound);
}

/**
 * One terminal record, or the refusal that replaces it.
 *
 * Shared with the JSON Lines projection: both end in exactly one terminal
 * record, and both have to answer the same way when the result will not encode.
 */
export async function emitTerminal(
  record: CliRecord,
  command: string,
  occurredAt: Timestamp,
  storeOverBound?: OverBoundArtifactWriter,
): Promise<RenderedRecords> {
  const encoded = encodeCliRecord(record);
  if (encoded.ok) {
    return { result: [encoded.text], diagnostics: "" };
  }
  return refusalFor(record, command, occurredAt, encoded.error, storeOverBound);
}

async function refusalFor(
  original: CliRecord,
  command: string,
  occurredAt: Timestamp,
  error: CliEncodeError,
  storeOverBound: OverBoundArtifactWriter | undefined,
): Promise<RenderedRecords> {
  const spill = await spillOverBound(error, storeOverBound);
  const refusal = cliRefusalRecord(command, original.sequence, occurredAt, error, spill);
  const encoded = encodeCliRecord(refusal);
  const notice = [
    `The result could not be emitted: ${error.code}${error.path === "" ? "" : ` at ${error.path}`}.`,
    spill.artifactError === null
      ? null
      : `The full result could not be stored (${spill.artifactError}).`,
  ]
    .filter((line): line is string => line !== null)
    .join(" ");

  // The refusal carries nothing that came from the result, so this branch is
  // unreachable in practice. It is written rather than asserted because the
  // alternative — throwing from a projection — would lose the run's outcome
  // entirely, which is the one thing this format exists to deliver.
  return encoded.ok
    ? { result: [encoded.text], diagnostics: notice }
    : { result: [], diagnostics: `${notice} The refusal record could not be emitted either.` };
}

async function spillOverBound(
  error: CliEncodeError,
  storeOverBound: OverBoundArtifactWriter | undefined,
): Promise<CliRefusalArtifact> {
  if (error.code !== "record-too-large" || error.encodedText === null) {
    return { artifact: null, artifactError: null };
  }
  if (storeOverBound === undefined) {
    return { artifact: null, artifactError: null };
  }
  const bytes = new TextEncoder().encode(error.encodedText);
  const written = await storeOverBound({ bytes });
  return written.ok
    ? { artifact: written.artifact, artifactError: null }
    : { artifact: null, artifactError: written.code };
}
