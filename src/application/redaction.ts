/**
 * Redaction at the message, event, log, and diagnostic boundary.
 *
 * This runs on everything that leaves the runtime as text. It is deliberately
 * aggressive: over-redacting costs a developer some context, while
 * under-redacting puts a credential in a log file that outlives the process.
 *
 * It is a boundary safeguard, not the primary defence. The primary defence is
 * that the structures reaching here carry codes and paths rather than values —
 * this catches what slips through, particularly text from a foreign `Error`.
 */

import type {
  ClockPort,
  DiagnosticValue,
  DurationMs,
  Instant,
  SensitiveValueRedactor,
} from "../domain/index.ts";
import {
  addDuration,
  duration,
  MAX_CAUSE_DETAIL_LENGTH,
  MAX_DEBUG_PREVIEW_LENGTH,
  MAX_DEBUG_PREVIEWS,
  MAX_DEBUG_WINDOW_MS,
} from "../domain/index.ts";

export const REDACTED = "[redacted]";

/**
 * Patterns replaced wholesale.
 *
 * Ordered most specific first: a credential-bearing URL is rewritten before the
 * generic key/value rule can partially mangle it.
 */
/**
 * Names that mean the value beside them is a credential.
 *
 * Shared by the free-text rule and the structured-metadata rule below. In text
 * a secret appears as `apiKey=hunter2`; in metadata the same pair arrives as a
 * key and a value that never form that string, so the name has to be matched on
 * its own or the structured form silently bypasses redaction.
 */
const SECRET_NAME_SOURCE =
  "(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)";

const SECRET_NAME = new RegExp(`^[A-Za-z0-9_.-]*${SECRET_NAME_SOURCE}[A-Za-z0-9_.-]*$`, "i");

const REDACTION_RULES: readonly { readonly pattern: RegExp; readonly replace: string }[] = [
  // scheme://user:secret@host — keep the shape, drop the credential.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replace: `$1${REDACTED}@` },
  // Authorization headers and bearer tokens.
  // Consumes the whole header value, not just its first token: stopping at the
  // scheme would leave `Bearer <token>` with the token intact.
  {
    pattern: /\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi,
    replace: `$1: ${REDACTED}`,
  },
  { pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replace: `bearer ${REDACTED}` },
  // Secret-ish assignments in any of the usual spellings.
  {
    pattern: new RegExp(
      `\\b([A-Za-z0-9_.-]*${SECRET_NAME_SOURCE}[A-Za-z0-9_.-]*)\\s*[:=]\\s*("[^"]*"|'[^']*'|\\S+)`,
      "gi",
    ),
    replace: `$1=${REDACTED}`,
  },
  // Well-known credential shapes that appear bare, with no key beside them.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{12,}/g, replace: REDACTED },
  // A JWT: three base64url segments separated by dots.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // BEGIN ... PRIVATE KEY blocks.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
];

/** Redacts and bounds a free-text fragment. */
export function redactText(text: string, maxLength = MAX_CAUSE_DETAIL_LENGTH): string {
  let result = text;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replace);
  }
  result = result.replace(/\s+/g, " ").trim();
  // The ellipsis counts toward the bound, so the result never exceeds it.
  return result.length > maxLength ? `${result.slice(0, Math.max(0, maxLength - 1))}…` : result;
}

/** Redacts model/tool output without collapsing its line and column layout. */
export function redactProjectionText(text: string, maxLength = MAX_CAUSE_DETAIL_LENGTH): string {
  let result = text;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replace);
  }
  return result.length > maxLength ? `${result.slice(0, Math.max(0, maxLength - 1))}…` : result;
}

/** Whether redaction would change this text. Used by negative controls. */
export function containsRedactableSecret(text: string): boolean {
  return redactText(text, Number.MAX_SAFE_INTEGER) !== text.replace(/\s+/g, " ").trim();
}

export function redactDiagnosticValue(value: DiagnosticValue): DiagnosticValue {
  return typeof value === "string" ? redactText(value) : value;
}

/** Whether a metadata key names something whose value is a credential. */
export function isSecretName(key: string): boolean {
  return SECRET_NAME.test(key.trim());
}

/**
 * Redacts structured metadata.
 *
 * A key and a value are separate here, so the free-text `key=value` rule can
 * never fire on them. A key that names a credential therefore has its value
 * replaced wholesale, whatever the value looks like — a password of `p4ss`
 * matches no known credential shape and would otherwise pass straight through.
 */
export function redactMetadata(
  metadata: Readonly<Record<string, DiagnosticValue>>,
): Readonly<Record<string, DiagnosticValue>> {
  const result: Record<string, DiagnosticValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const safeKey = redactText(key, 64);
    result[safeKey] = isSecretName(key) ? REDACTED : redactDiagnosticValue(value);
  }
  return result;
}

/**
 * This module packaged as the domain's redaction port.
 *
 * Areas that depend on domain ports only — configuration among them — cannot
 * import this module, and writing them a second redactor would mean keeping two
 * sets of credential patterns correct forever. Composition passes this instead.
 */
export function createRuntimeRedactor(): SensitiveValueRedactor {
  return { placeholder: REDACTED, redactText, isSecretName };
}

/** Runtime redactor for structured model/UI values where whitespace is data. */
export function createRuntimeProjectionRedactor(): SensitiveValueRedactor {
  return { placeholder: REDACTED, redactText: redactProjectionText, isSecretName };
}

/**
 * A bounded, time-scoped window in which extra detail may be requested.
 *
 * Opening it never disables redaction. It widens *how much* redacted detail is
 * kept, not *whether* redaction happens — a debug switch that turns redaction
 * off is a credential leak waiting for someone to forget it is on.
 */
export type DebugWindow = {
  /** Whether the window is currently open, according to the clock. */
  isOpen(): boolean;
  /**
   * Returns a redacted preview, or `null` when the window is closed or its
   * preview budget is spent.
   */
  preview(text: string): string | null;
  previewsRemaining(): number;
  expiresAt(): Instant;
  close(): void;
};

export type DebugWindowOptions = {
  readonly clock: ClockPort;
  /** How long the window stays open. Bounded by `MAX_DEBUG_WINDOW_MS`. */
  readonly ttlMs: DurationMs;
  /** How many previews it will produce. Bounded by `MAX_DEBUG_PREVIEWS`. */
  readonly maxPreviews: number;
};

export function openDebugWindow(options: DebugWindowOptions): DebugWindow {
  const { clock } = options;
  const ttl = duration(Math.min(options.ttlMs, MAX_DEBUG_WINDOW_MS));
  const expiry = addDuration(clock.now(), ttl);
  let remaining = Math.max(0, Math.min(options.maxPreviews, MAX_DEBUG_PREVIEWS));
  let closed = false;

  const open = (): boolean => !closed && clock.now() < expiry && remaining > 0;

  return {
    isOpen: open,
    preview(text: string): string | null {
      if (!open()) {
        return null;
      }
      remaining -= 1;
      // Still redacted. The window widens the budget, never the exposure.
      return redactText(text, MAX_DEBUG_PREVIEW_LENGTH);
    },
    previewsRemaining(): number {
      return closed ? 0 : remaining;
    },
    expiresAt(): Instant {
      return expiry;
    },
    close(): void {
      closed = true;
    },
  };
}
