/**
 * Parse helpers at the provider boundary.
 *
 * Failures return path/code issues only — never the rejected payload — so a
 * malformed fragment that contains a secret cannot reach logs through this path.
 */

import { toCodecIssues } from "../domain/branded-schema.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ModelRequest } from "./request.ts";
import { modelRequestSchema, normalizedProviderEventSchema } from "./schemas.ts";
import type { NormalizedProviderEvent } from "./stream.ts";

export type ProviderBoundaryParseError = {
  readonly kind: "provider-boundary";
  readonly issues: readonly CodecIssue[];
};

export function parseModelRequest(
  value: unknown,
): Result<ModelRequest, ProviderBoundaryParseError> {
  const parsed = modelRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({ kind: "provider-boundary", issues: toCodecIssues(parsed.error) });
  }
  const { schemaVersion: _schemaVersion, ...request } = parsed.data;
  return ok(request);
}

export function parseNormalizedProviderEvent(
  value: unknown,
): Result<NormalizedProviderEvent, ProviderBoundaryParseError> {
  const parsed = normalizedProviderEventSchema.safeParse(value);
  if (!parsed.success) {
    return err({ kind: "provider-boundary", issues: toCodecIssues(parsed.error) });
  }
  return ok(parsed.data);
}

/**
 * Redacts a string that might appear in diagnostics.
 *
 * Provider boundaries must never echo secrets. Anything that looks like a
 * bearer token, API key, or key=value secret is replaced wholesale.
 */
export function redactProviderDiagnosticText(value: string): string {
  if (value.length === 0) {
    return value;
  }
  if (
    /sk-[a-zA-Z0-9]{8,}/.test(value) ||
    /Bearer\s+\S+/i.test(value) ||
    /api[_-]?key\s*[:=]\s*\S+/i.test(value) ||
    /x-api-key\s*[:=]\s*\S+/i.test(value)
  ) {
    return "[redacted]";
  }
  return value;
}
