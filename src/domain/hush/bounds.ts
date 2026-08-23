/** Shared byte, stream, and repeated-line bounds for Hush reducers. */

import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../process-capture.ts";
import type { HushOmission, HushStreamProjection } from "./contracts.ts";

export function passthroughProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, false),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, false),
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
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
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

export function groupLines(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
  keyFor: (line: string) => string,
  perGroup: number,
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const counts = new Map<string, number>();
  const kept: string[] = [];
  let omitted = 0;
  for (const line of capture.inlineText.split("\n")) {
    if (line.length === 0 || matchesPattern(line, patterns)) {
      kept.push(line);
      continue;
    }
    const key = keyFor(line);
    const seen = counts.get(key) ?? 0;
    if (seen < perGroup) {
      kept.push(line);
      counts.set(key, seen + 1);
    } else {
      omitted += 1;
    }
  }
  const bounded = boundText(kept.join("\n"), stream, maxBytes);
  return {
    text: bounded.text,
    omissions: [
      ...(omitted > 0
        ? [{ kind: "capped-lines" as const, stream, count: omitted, detail: null }]
        : []),
      ...bounded.omissions,
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
    ? collapseDuplicateLines(capture.inlineText, stream, patterns)
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

function collapseDuplicateLines(
  text: string,
  stream: ProcessStreamName,
  patterns: readonly string[],
): HushStreamProjection {
  const kept: string[] = [];
  let omitted = 0;
  let previous: string | null = null;
  let run = 0;
  for (const line of text.split("\n")) {
    if (matchesPattern(line, patterns) || line !== previous) {
      kept.push(line);
      previous = line;
      run = 1;
      continue;
    }
    run += 1;
    if (run === 2) {
      kept.push(line);
    } else {
      omitted += 1;
    }
  }
  return {
    text: kept.join("\n"),
    omissions: omitted > 0 ? [{ kind: "duplicate-run", stream, count: omitted, detail: null }] : [],
  };
}
