import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, genericProjection, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { shortestText } from "../../text-format.ts";
import { formatExternalUnifiedDiff } from "../diff/format.ts";
import { pathFromDiffGit } from "./paths.ts";

export function gitDiffProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  if (source === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }

  const formatted = formatUnifiedDiff(source) ?? formatExternalUnifiedDiff(source);
  const stdout = boundText(shortestText(source, formatted ?? source), "stdout", maxBytes);
  return joinStreams(
    stdout,
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

export function formatUnifiedDiff(source: string): string | null {
  const lines = source.split("\n");
  const formatted: string[] = [];
  let foundFile = false;
  for (const line of lines) {
    if (!line.startsWith("diff --git ")) {
      formatted.push(line);
      continue;
    }

    const path = pathFromDiffGit(line.slice("diff --git ".length));
    if (path === null) {
      return null;
    }
    if (foundFile && formatted.at(-1) !== "") {
      formatted.push("");
    }
    formatted.push(`${path}:`);
    foundFile = true;
  }
  return foundFile ? formatted.join("\n") : null;
}
