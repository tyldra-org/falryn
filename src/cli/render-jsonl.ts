/**
 * The JSON Lines projection: ordered lifecycle records, then exactly one
 * terminal record.
 *
 * A pure function from the events a run produced plus its `CommandResult` to the
 * lines stdout carries. Like the JSON projection it is handed the time rather
 * than reading a clock.
 *
 * Two rules it enforces rather than documents:
 *
 * - **Lifecycle records project the runtime's own events.** Each carries the
 *   wire form `toWireEvent` already produces, so this format does not invent a
 *   second event vocabulary that would then have to be kept in step with the
 *   first.
 * - **Exactly one terminal record, and it is last.** A record that cannot be
 *   encoded is skipped and counted; the terminal record is emitted regardless,
 *   because a stream that simply stops is indistinguishable from a killed
 *   process — which is precisely what a CI consumer has to be able to tell
 *   apart.
 */

import {
  FIRST_SEQUENCE,
  nextSequence,
  type RuntimeEvent,
  type Sequence,
  toWireEvent,
} from "../domain/index.ts";
import {
  emitTerminal,
  type MachineRenderRequest,
  type RenderedRecords,
  resultBodyOf,
} from "./render-json.ts";
import { cliEventRecord, cliResultRecord, encodeCliRecord } from "./schema.ts";

export type JsonlRenderRequest = MachineRenderRequest & {
  /**
   * The events this run produced, in the order they were appended.
   *
   * Empty is a valid stream: most commands in this build produce none, and a
   * stream carrying only its terminal record is still a complete answer.
   */
  readonly events: readonly RuntimeEvent[];
};

export async function renderJsonl(request: JsonlRenderRequest): Promise<RenderedRecords> {
  const { result, occurredAt, events, storeOverBound } = request;
  const lines: string[] = [];
  const skipped: string[] = [];

  let order: Sequence = FIRST_SEQUENCE;
  for (const event of events) {
    const record = cliEventRecord(result.command, order, occurredAt, toWireEvent(event));
    const encoded = encodeCliRecord(record);
    if (encoded.ok) {
      lines.push(encoded.text);
      order = nextSequence(order);
      continue;
    }
    // A lifecycle record that will not encode is detail, not the answer. It is
    // dropped and reported rather than allowed to take the terminal record with
    // it — and the sequence does not advance, so the stream a consumer reads
    // stays contiguous and its gap check keeps meaning what it means.
    skipped.push(`${event.kind}: ${encoded.error.code}`);
  }

  const terminal = await emitTerminal(
    cliResultRecord(result.command, order, occurredAt, resultBodyOf(result)),
    result.command,
    occurredAt,
    storeOverBound,
  );

  const notices = [
    ...skipped.map(
      (entry) => `A lifecycle record could not be emitted and was skipped (${entry}).`,
    ),
    ...(terminal.diagnostics === "" ? [] : [terminal.diagnostics]),
  ];

  return {
    result: [...lines, ...terminal.result],
    diagnostics: notices.join("\n"),
  };
}
