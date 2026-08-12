/**
 * Normalized provider stream events.
 *
 * These are adapter-boundary events, not the durable `RuntimeEvent` envelope.
 * Ordering is per `requestId` / attempt sequence. Invalid ordering or a second
 * terminal event is an adapter defect surfaced as `error`.
 */

import type { ModelAttemptId } from "../domain/identity.ts";
import type { ProviderFailure } from "./errors.ts";
import type { ModelRequestId } from "./identity.ts";

export const PROVIDER_EVENT_KINDS = [
  "request-started",
  "text-delta",
  "reasoning-delta",
  "tool-call-delta",
  "tool-proposal",
  "usage",
  "provider-metadata",
  "finished",
  "error",
] as const;

export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];

export function isProviderEventKind(value: unknown): value is ProviderEventKind {
  return typeof value === "string" && (PROVIDER_EVENT_KINDS as readonly string[]).includes(value);
}

export type ProviderEventSpine = {
  readonly requestId: ModelRequestId;
  readonly modelAttemptId: ModelAttemptId;
  /** One-based sequence within the attempt. */
  readonly sequence: number;
};

export type UsageUnits = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  /**
   * Whether counts came from the provider or are Falryn estimates.
   * Missing usage is unknown, never silently zero.
   */
  readonly provenance: "provider-reported" | "estimate" | "unknown";
};

export type NormalizedProviderEvent =
  | (ProviderEventSpine & { readonly kind: "request-started" })
  | (ProviderEventSpine & { readonly kind: "text-delta"; readonly text: string })
  | (ProviderEventSpine & { readonly kind: "reasoning-delta"; readonly text: string })
  | (ProviderEventSpine & {
      readonly kind: "tool-call-delta";
      readonly toolCallId: string;
      readonly name?: string | undefined;
      readonly argumentsFragment: string;
    })
  | (ProviderEventSpine & {
      readonly kind: "tool-proposal";
      readonly toolCallId: string;
      readonly name: string;
      readonly argumentsJson: string;
    })
  | (ProviderEventSpine & { readonly kind: "usage"; readonly usage: UsageUnits })
  | (ProviderEventSpine & {
      readonly kind: "provider-metadata";
      readonly entries: Readonly<Record<string, string>>;
    })
  | (ProviderEventSpine & {
      readonly kind: "finished";
      readonly finishReason: string;
    })
  | (ProviderEventSpine & {
      readonly kind: "error";
      readonly failure: ProviderFailure;
    });

export function isTerminalProviderEvent(event: NormalizedProviderEvent): boolean {
  return event.kind === "finished" || event.kind === "error";
}
