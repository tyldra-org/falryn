import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import {
  graphiteCommand,
  graphiteCommandArguments,
  type HushGraphiteCommand,
  hasGraphiteOutputOverride,
} from "../../../command/graphite.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { boundText } from "../../stream.ts";
import { completeSuccessfulCapture } from "../capture.ts";
import { formatGraphiteLog } from "./log.ts";
import { formatGraphiteMutation } from "./mutation.ts";
import { formatGraphiteSubmit } from "./submit.ts";

export function graphiteProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection | null {
  const command = graphiteCommand(commandTokens);
  if (
    command === null ||
    patterns.length > 0 ||
    hasGraphiteOutputOverride(command, graphiteCommandArguments(commandTokens)) ||
    !completeSuccessfulCapture(capture)
  ) {
    return null;
  }
  const source = [capture.stdout.inlineText ?? "", capture.stderr.inlineText ?? ""]
    .filter((text) => text.length > 0)
    .join("\n");
  const formatted = formatGraphite(command, source);
  if (formatted === null) {
    return null;
  }
  return boundText(formatted, "both", maxBytes);
}

function formatGraphite(command: HushGraphiteCommand, source: string): string | null {
  switch (command) {
    case "log":
      return formatGraphiteLog(source);
    case "submit":
      return formatGraphiteSubmit(source);
    case "sync":
    case "restack":
    case "create":
    case "branch":
      return formatGraphiteMutation(command, source);
  }
}
