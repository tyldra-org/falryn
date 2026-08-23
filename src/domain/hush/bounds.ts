/** Shared byte, stream, and repeated-line bounds for Hush reducers. */

import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../process-capture.ts";
import type { HushOmission, HushStreamProjection } from "./contracts.ts";
import { compactDuplicateRuns } from "./text-format.ts";

export function passthroughProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, false),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

export function genericProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, true),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

export function rawFallbackProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
): HushStreamProjection {
  const fallback = passthroughProjection(capture, maxBytes, []);
  return {
    text: fallback.text,
    omissions: [
      ...fallback.omissions,
      { kind: "reducer-failure", stream: "both", count: 1, detail: null },
    ],
  };
}

export function boundStream(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
  collapseDuplicates: boolean,
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const source = collapseDuplicates
    ? {
        text: compactDuplicateRuns(capture.inlineText, (line) => matchesPattern(line, patterns)),
        omissions: [] as HushOmission[],
      }
    : { text: capture.inlineText, omissions: [] as HushOmission[] };
  const bounded = boundText(source.text, stream, maxBytes);
  return {
    text: bounded.text,
    omissions: [...source.omissions, ...bounded.omissions],
  };
}

export function boundText(
  text: string,
  stream: ProcessStreamName | "both",
  maxBytes: number,
): HushStreamProjection {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, omissions: [] };
  }
  const decoder = new TextDecoder();
  const head = decoder.decode(encoded.slice(0, Math.floor(maxBytes * 0.6)));
  const tail = decoder.decode(encoded.slice(encoded.byteLength - Math.floor(maxBytes * 0.3)));
  return {
    text: `${head}\n…\n${tail}`,
    omissions: [
      {
        kind: "capped-bytes",
        stream,
        count: encoded.byteLength - maxBytes,
        detail: null,
      },
    ],
  };
}

export function binaryOmission(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
): HushStreamProjection {
  return {
    text: "",
    omissions: [
      {
        kind: "binary-stream",
        stream,
        count: capture.byteCount,
        detail: capture.artifact?.artifactId ?? null,
      },
    ],
  };
}

export function joinStreams(
  stdout: HushStreamProjection,
  stderr: HushStreamProjection,
  maxBytes: number,
): HushStreamProjection {
  const parts: string[] = [];
  if (stdout.text.length > 0) {
    parts.push(stdout.text);
  }
  if (stderr.text.length > 0) {
    parts.push(`stderr:\n${stderr.text}`);
  }
  const joined = boundText(parts.join("\n"), "both", maxBytes);
  return {
    text: joined.text,
    omissions: [...stdout.omissions, ...stderr.omissions, ...joined.omissions],
  };
}

export function matchesPattern(line: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => line.includes(pattern));
}
