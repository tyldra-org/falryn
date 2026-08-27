/** Output-format selection and stream emission for dispatch. */

import {
  assertNever,
  MAX_STREAM_READ_LIMIT,
  type RuntimeEvent,
  streamId,
  type Timestamp,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import type { RunCommandResult } from "../commands.ts";
import { allowsColor, type GlobalOptions, resolveColor } from "../options.ts";
import { createOverBoundArtifactWriter } from "../refusal-artifact.ts";
import { renderHuman, renderQuiet } from "../render-human.ts";
import { type RenderedRecords, renderJson } from "../render-json.ts";
import { renderJsonl } from "../render-jsonl.ts";
import { resultEvents } from "../result-events.ts";
import { CLI_EVENT_STREAM, type ServiceProvider } from "../services.ts";
import { type CliStreams, writeDiagnosticLine, writeResultLine } from "../streams.ts";

export async function render(
  result: RunCommandResult,
  globals: GlobalOptions,
  streams: CliStreams,
  services: ServiceProvider,
): Promise<RenderedRecords> {
  switch (globals.format) {
    case "human":
      return asRecords(
        renderHuman({
          result,
          // Keyed to stdout, which is the handle the result lands on. A format
          // that is not `human` never gets colour at all, and `--color`
          // overrides the derived fact rather than replacing the derivation.
          color: allowsColor(globals.format)
            ? resolveColor(globals.color, streams.capabilities.stdout.color)
            : "none",
          symbols: streams.capabilities.stdout.symbols,
          columns: streams.capabilities.stdout.columns,
          verbose: globals.verbose,
        }),
      );
    case "quiet":
      return asRecords(renderQuiet(result));
    case "json":
      return renderJson({
        result,
        occurredAt: nowFor(services),
        storeOverBound: createOverBoundArtifactWriter(services),
      });
    case "jsonl":
      return renderJsonl({
        result,
        occurredAt: nowFor(services),
        events: await lifecycleEvents(result, services),
        storeOverBound: createOverBoundArtifactWriter(services),
      });
    default:
      return assertNever(globals.format, "unhandled output format");
  }
}

/** A single rendered text as the one-line list the writer takes. */
function asRecords(text: {
  readonly result: string;
  readonly diagnostics: string;
}): RenderedRecords {
  return {
    result: text.result === "" ? [] : [text.result],
    diagnostics: text.diagnostics,
  };
}

/** When the run finished, in the canonical form every record carries. */
function nowFor(services: ServiceProvider): Timestamp {
  return timestampFromEpochMilliseconds(services().clock.now());
}

/**
 * The events this run appended, in sequence order.
 *
 * Read back from the in-memory store the service graph already writes to, so a
 * JSON Lines run reports the lifecycle it actually produced rather than one
 * staged for it. A read that fails yields no events: a lifecycle this build
 * could not recover is detail, and the terminal record still carries the answer.
 */
async function lifecycleEvents(
  result: RunCommandResult,
  services: ServiceProvider,
): Promise<readonly RuntimeEvent[]> {
  const attached = resultEvents(result);
  if (attached !== null) {
    return attached;
  }
  const { eventStore } = services();
  const read = await eventStore.readFrom(
    { streamId: streamId.from(CLI_EVENT_STREAM), afterSequence: null },
    MAX_STREAM_READ_LIMIT,
  );
  return read.ok ? read.value : [];
}

/**
 * Writes each line to the handle that owns it.
 *
 * An empty list writes nothing at all, rather than a blank line: a run whose
 * format has no primary result must leave stdout untouched, and a newline is not
 * nothing to a consumer counting records.
 *
 * Writing stops as soon as the stream reports the reader is gone. A consumer
 * running `falryn ... --format jsonl | head -1` gets whole lines and no partial
 * one, and the run does not go on producing records nobody is reading.
 */
export function emit(streams: CliStreams, records: RenderedRecords): void {
  for (const line of records.result) {
    if (writeResultLine(streams, line).status === "closed") {
      break;
    }
  }
  if (records.diagnostics !== "") {
    writeDiagnosticLine(streams, records.diagnostics);
  }
}
