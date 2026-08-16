/**
 * Confirmation facts for the TUI sheet (#255).
 *
 * Domain policy already binds a confirmation id to capability + normalized
 * input. This module projects those facts for the overlay and owns the secret
 * buffer helpers the sheet uses — the value itself never lives here, only the
 * transforms that keep a mask honest.
 *
 * OpenTUI's Input has no password echo, so masked capture is Falryn-owned.
 * `looksSecret` stays the one weak signal in this area; this file calls it
 * rather than inventing a second pattern.
 */

import type { EffectClass, FocusedConfirmationRequest } from "../../domain/index.ts";
import { assertNever, graphemes } from "../../domain/index.ts";
import { looksSecret } from "../paste.ts";

export const CONFIRMATION_SCOPES = ["once"] as const;
export type ConfirmationScope = (typeof CONFIRMATION_SCOPES)[number];

export type ConfirmationChoiceId = "accept" | "deny";

export type ConfirmationChoice = {
  readonly id: ConfirmationChoiceId;
  readonly label: string;
  readonly key: string;
};

export type ConfirmationSecret = {
  readonly label: string;
};

export type ConfirmationPrompt = {
  readonly id: string;
  readonly title: string;
  readonly operation: string;
  readonly target: string;
  readonly reason: string;
  readonly effect: string;
  readonly alternatives: readonly string[];
  readonly scope: ConfirmationScope;
  readonly fingerprint: string;
  readonly secret: ConfirmationSecret | null;
};

export type ConfirmationView = {
  readonly prompt: ConfirmationPrompt;
  readonly stale: boolean;
  readonly secretGraphemes: number;
  readonly choices: readonly ConfirmationChoice[];
};

export type ConfirmationDecision =
  | {
      readonly status: "accepted";
      readonly id: string;
      readonly fingerprint: string;
    }
  | { readonly status: "refused"; readonly id: string }
  | { readonly status: "stale"; readonly expected: string; readonly current: string };

export type SecretEdit =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "delete" };

/** Alternatives the sheet names. Cancel is the deny action; the rest are gaps. */
export const CONFIRMATION_ALTERNATIVES = [
  "Cancel",
  "Preview (unavailable in this build)",
  "Narrow scope (unavailable in this build)",
  "Export (unavailable in this build)",
] as const;

export const WITHHELD_TARGET = "[withheld]";

export function reasonForEffect(effect: EffectClass): string {
  switch (effect) {
    case "observation":
      return "This would only read.";
    case "mutation":
      return "This would change files or other local state.";
    case "external":
      return "This would have an effect outside this workspace.";
    case "interactive":
      return "This would take over the terminal or wait for input.";
    default: {
      const exhaustive: never = effect;
      return assertNever(exhaustive, "unhandled effect class");
    }
  }
}

export function formatConfirmationTarget(input: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return "(no target)";
  }
  return entries.map(([key, value]) => `${key}=${redactTargetValue(key, value)}`).join(" ");
}

function redactTargetValue(key: string, value: unknown): string {
  const rendered = renderTargetValue(value);
  if (looksSecret(key) || looksSecret(rendered)) {
    return WITHHELD_TARGET;
  }
  return rendered;
}

function renderTargetValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value);
}

export function promptFromPolicy(request: FocusedConfirmationRequest): ConfirmationPrompt {
  return {
    id: request.confirmationId,
    title: request.title,
    operation: request.toolName,
    target: formatConfirmationTarget(request.normalizedInput),
    reason: reasonForEffect(request.effectClass),
    effect: request.effectClass,
    alternatives: CONFIRMATION_ALTERNATIVES,
    scope: "once",
    fingerprint: request.inputFingerprint,
    secret: null,
  };
}

export function confirmationIsStale(
  bound: ConfirmationPrompt | null,
  live: ConfirmationPrompt | null,
): boolean {
  if (bound === null) {
    return live !== null;
  }
  if (live === null) {
    return true;
  }
  return bound.id !== live.id || bound.fingerprint !== live.fingerprint;
}

export function labelledChoices(prompt: ConfirmationPrompt): readonly ConfirmationChoice[] {
  if (prompt.secret !== null) {
    return [
      { id: "accept", label: "Accept", key: "return" },
      { id: "deny", label: "Decline", key: "escape" },
    ];
  }
  return [
    { id: "accept", label: "Accept", key: "y" },
    { id: "deny", label: "Decline", key: "n" },
  ];
}

export function confirmationView(
  bound: ConfirmationPrompt,
  live: ConfirmationPrompt | null,
  secretGraphemes: number,
): ConfirmationView {
  return {
    prompt: bound,
    stale: confirmationIsStale(bound, live),
    secretGraphemes,
    choices: labelledChoices(bound),
  };
}

export function resolvedConfirmationKey(prompt: ConfirmationPrompt): string {
  return `${prompt.id}:${prompt.fingerprint}`;
}

export function applySecretEdit(current: string, edit: SecretEdit): string {
  switch (edit.kind) {
    case "insert":
      return current + edit.text;
    case "delete": {
      const parts = graphemes(current);
      return parts.slice(0, -1).join("");
    }
    default: {
      const exhaustive: never = edit;
      return assertNever(exhaustive, "unhandled secret edit");
    }
  }
}

export function secretGraphemeCount(value: string): number {
  return graphemes(value).length;
}

export function maskSecret(count: number, mark: string): string {
  if (count <= 0) {
    return "";
  }
  return mark.repeat(count);
}
