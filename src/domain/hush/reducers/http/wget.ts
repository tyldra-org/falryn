import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import {
  compactDuplicateRuns,
  compactJsonWhitespace,
  shortestText,
  stripAnsi,
} from "../shared/text.ts";
import { binaryOmission, boundText, joinStreams } from "../stream.ts";
import { stripWgetProgress } from "./progress.ts";

const STANDARD_WGET_LINE = [
  /^--\d{4}-\d{2}-\d{2}.*--\s+https?:\/\//u,
  /^Resolving\s+/iu,
  /^Connecting to\s+/iu,
  /^HTTP request sent, awaiting response\.\.\.\s+\d{3}/iu,
  /^Length:\s+\d+/iu,
  /^Saving to:/iu,
  /^\d{4}-\d{2}-\d{2}.*saved\s+\[/iu,
] as const;

export const reduceWget: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  wgetProjection(capture, maxBytes, patterns, commandTokens);

export function wgetProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const stdout = projectWgetBody(capture.stdout, maxBytes);
  const summary =
    stdout.text.length === 0 &&
    stdout.omissions.length === 0 &&
    completeSuccess(capture) &&
    patterns.length === 0 &&
    capture.stderr.inlineText !== null
      ? formatWgetSuccess(stripAnsi(capture.stderr.inlineText), commandTokens)
      : null;
  if (summary !== null) {
    return joinStreams(
      boundText(summary, "stdout", maxBytes),
      { text: "", omissions: [] },
      maxBytes,
    );
  }
  const stderr = projectWgetStderr(capture.stderr, maxBytes, patterns);
  return joinStreams(stdout, stderr, maxBytes);
}

function projectWgetBody(capture: ProcessStreamCapture, maxBytes: number): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission("stdout", capture);
  }
  const plain = stripAnsi(capture.inlineText);
  const duplicates = compactDuplicateRuns(plain);
  const json = compactJsonWhitespace(plain);
  return boundText(
    shortestText(plain, duplicates, ...(json === null ? [] : [json])),
    "stdout",
    maxBytes,
  );
}

function projectWgetStderr(
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission("stderr", capture);
  }
  const plain = stripAnsi(capture.inlineText);
  const withoutProgress = stripWgetProgress(plain, patterns);
  return boundText(
    shortestText(plain, withoutProgress, compactDuplicateRuns(withoutProgress)),
    "stderr",
    maxBytes,
  );
}

function formatWgetSuccess(stderr: string, commandTokens: readonly string[]): string | null {
  const urls = commandTokens.filter((token) => /^https?:\/\//u.test(token));
  const url = urls[0];
  if (url === undefined || urls.length !== 1) {
    return null;
  }
  const statuses = [...stderr.matchAll(/awaiting response\.\.\.\s+(\d{3}(?:\s+[^\n]+)?)/giu)];
  const status = statuses.at(-1)?.[1]?.trim();
  const destination = destinationFrom(commandTokens, stderr, url);
  const size = sizeFrom(stderr);
  if (status === undefined || statuses.length !== 1 || destination === null || size === null) {
    return null;
  }
  const extras = stripWgetProgress(stderr, [])
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !STANDARD_WGET_LINE.some((matcher) => matcher.test(trimmed));
    });
  const summary = `${status.split(/\s+/u)[0]} ${url.replace(/^https?:\/\//u, "")}->${destination} ${size}`;
  return extras.length === 0 ? summary : [summary, ...extras].join("\n");
}

function completeSuccess(capture: ProcessCaptureReport): boolean {
  return (
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    completeText(capture.stdout) &&
    completeText(capture.stderr)
  );
}

function completeText(stream: ProcessStreamCapture): boolean {
  return (
    stream.encoding === "utf-8" &&
    stream.inlineText !== null &&
    !stream.truncated &&
    stream.omittedBytes === 0 &&
    !stream.maxLineExceeded
  );
}

function destinationFrom(tokens: readonly string[], stderr: string, url: string): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if ((token === "-O" || token === "--output-document") && tokens[index + 1] !== undefined) {
      return tokens[index + 1] ?? null;
    }
    const explicit = token.match(/^(?:-O|--output-document=)(.+)$/u)?.[1];
    if (explicit !== undefined) {
      return explicit;
    }
  }
  const reported = stderr.match(/(?:Saving to:|saved\s+)\s*[‘'«"]([^’'»"\n]+)[’'»"]/iu)?.[1];
  if (reported !== undefined) {
    return reported.trim();
  }
  const path = url.split(/[?#]/u, 1)[0] ?? url;
  const filename = path.split("/").at(-1);
  return filename === undefined || filename.length === 0 ? "index.html" : filename;
}

function sizeFrom(stderr: string): string | null {
  const length = stderr.match(/Length:\s+(\d+)(?:\s+\(([^)]+)\))?/iu);
  if (length === null) {
    return null;
  }
  const human = length[2];
  return human === undefined ? `${length[1]}B` : normalizeSize(human);
}

function normalizeSize(size: string): string {
  return size.replace(/([KMGT])$/u, "$1B");
}
