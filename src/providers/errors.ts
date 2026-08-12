/**
 * Distinguishes provider-boundary failures without embedding secrets or payloads.
 *
 * Categories mirror the design contract so adapters and tests can agree on why
 * an attempt ended. Retryability is a separate field: a rate limit may be
 * retryable while a malformed request is not.
 */

export const PROVIDER_FAILURE_KINDS = [
  "network",
  "authentication",
  "authorization",
  "rate-limit",
  "invalid-request",
  "unsupported-capability",
  "malformed-stream",
  "provider-safety",
  "server-failure",
  "cancellation",
  "timeout",
  "adapter-defect",
] as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export function isProviderFailureKind(value: unknown): value is ProviderFailureKind {
  return typeof value === "string" && (PROVIDER_FAILURE_KINDS as readonly string[]).includes(value);
}

export type ProviderFailure = {
  readonly kind: ProviderFailureKind;
  /** Whether a caller may retry this attempt without inspecting effects. */
  readonly retryable: boolean;
  /**
   * User-safe summary. Never includes headers, URLs with credentials, prompts,
   * or secret material.
   */
  readonly message: string;
};
