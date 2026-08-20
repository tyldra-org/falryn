/**
 * Composer-facing mid-turn submit helpers (#612).
 *
 * Turns classification outcomes into notices and draft policy. The mid-turn
 * service owns queue and interrupt; this module only phrases what the shell
 * should say and whether the draft clears.
 */

import type { MidTurnInputService } from "../application/index.ts";
import {
  describeMidTurnClassifyError,
  type MidTurnClassification,
  type MidTurnClassifyError,
  type MidTurnIntent,
  type MidTurnRequestSnapshot,
  type MidTurnSemanticEvent,
} from "../domain/index.ts";

export type MidTurnSubmitResult =
  | {
      readonly ok: true;
      readonly classification: MidTurnClassification;
      readonly notice: string;
      /** Steer and follow-up clear the draft; interrupt keeps it. */
      readonly clearDraft: boolean;
      readonly events: readonly MidTurnSemanticEvent[];
    }
  | { readonly ok: false; readonly notice: string };

export function requestFromComposer(
  text: string,
  attachmentIds: readonly string[],
): MidTurnRequestSnapshot {
  return {
    text,
    attachmentIds: [...attachmentIds],
    mentionIds: [],
  };
}

export function submitWhileActive(
  service: MidTurnInputService,
  intent: MidTurnIntent,
  request: MidTurnRequestSnapshot,
): MidTurnSubmitResult {
  const result = service.classify({ intent, request });
  if (!result.ok) {
    return {
      ok: false,
      notice: describeMidTurnClassifyError(result.error),
    };
  }
  return {
    ok: true,
    classification: result.classification,
    notice: noticeForClassification(result.classification, service.view().queue.entries.length),
    clearDraft: result.classification !== "interrupt",
    events: result.events,
  };
}

export function noticeForClassification(
  classification: MidTurnClassification,
  queueDepth: number,
): string {
  switch (classification) {
    case "steer":
      return "Steered the in-flight attempt.";
    case "follow-up":
      return queueDepth === 1
        ? "Queued follow-up (1 waiting)."
        : `Queued follow-up (${queueDepth} waiting).`;
    case "interrupt":
      return "Cancelling the in-flight turn. Draft kept.";
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
}

export function describeSubmitWhileActiveError(error: MidTurnClassifyError): string {
  return describeMidTurnClassifyError(error);
}
