import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { semanticProjection } from "../semantic.ts";
import { psqlProjection } from "./psql/projection.ts";
import { sqliteProjection } from "./sqlite/projection.ts";

export function structuredProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const executable = commandTokens[0]?.split(/[\\/]/u).at(-1);
  if (executable === "psql") {
    return psqlProjection(capture, maxBytes, patterns);
  }
  if (executable === "sqlite3") {
    return sqliteProjection(capture, maxBytes, patterns);
  }
  const identity =
    executable === "aws" && patterns.length === 0 && capture.stdout.inlineText !== null
      ? formatAwsIdentity(capture.stdout.inlineText)
      : null;
  if (identity === null) {
    return semanticProjection("structured", capture, maxBytes, patterns);
  }
  return joinStreams(
    boundText(identity, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

function formatAwsIdentity(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const account = value.Account;
  const arn = value.Arn;
  const id = value.UserId;
  if (typeof account !== "string" || typeof arn !== "string" || typeof id !== "string") {
    return null;
  }
  const parts = arn.split(":");
  const service = parts[2];
  const arnAccount = parts[4];
  const resource = parts.slice(5).join(":");
  if (service === undefined || arnAccount !== account || resource.length === 0) {
    return null;
  }
  const resourceLabel = resource.replace("/", "=");
  return `AWS ${service} account=${account} ${resourceLabel} id=${id}\n`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
