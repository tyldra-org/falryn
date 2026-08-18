/**
 * History checkpoint and overflow compact-retry lanes (#106).
 *
 * Compaction records a new checkpoint identity. The original event log is
 * never rewritten. Required items stay verbatim; foldable turn prose may use
 * the optional compact-model lane. Provider overflow compact-retries once.
 * Skill instruction bodies are not folded into a summary.
 */

import { z } from "zod";

import type { ContentHasherPort } from "./blob.ts";
import {
  type CompactError,
  type CompactModelPort,
  type CompactReduceResult,
  reduceCompact,
} from "./compact-model.ts";
import {
  type EventId,
  eventId,
  type HistoryCheckpointId,
  historyCheckpointId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const HISTORY_CHECKPOINT_VERSION = "history.v1";
export const MAX_HISTORY_ITEMS = 64;
export const MAX_HISTORY_ITEM_BYTES = 4 * 1_024;
export const MAX_SKILL_INSTRUCTION_BYTES = 8 * 1_024;

export const HISTORY_REQUIRED_KINDS = [
  "user-commitment",
  "decision",
  "unresolved-question",
  "task-state",
  "tool-outcome",
  "citation",
  "artifact",
  "uncertainty",
  "correction",
  "skill-instruction",
] as const;
export type HistoryRequiredKind = (typeof HISTORY_REQUIRED_KINDS)[number];

export const HISTORY_FOLDABLE_KINDS = ["turn-prose"] as const;
export type HistoryFoldableKind = (typeof HISTORY_FOLDABLE_KINDS)[number];

export const HISTORY_ITEM_KINDS = [...HISTORY_REQUIRED_KINDS, ...HISTORY_FOLDABLE_KINDS] as const;
export type HistoryItemKind = (typeof HISTORY_ITEM_KINDS)[number];

export const OVERFLOW_REASONS = ["prompt-too-long"] as const;
export type OverflowReason = (typeof OVERFLOW_REASONS)[number];

export type HistoryItemInput = {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly retained?: unknown;
};

export type HistoryCheckpointInput = {
  readonly checkpointId?: unknown;
  readonly items?: unknown;
  readonly compactUse?: unknown;
  readonly maxBytes?: unknown;
  readonly cancelled?: unknown;
};

export type HistoryPreservedItem = {
  readonly id: EventId;
  readonly kind: HistoryRequiredKind;
  readonly text: string;
};

export type HistoryExpansion = {
  readonly eventId: EventId;
  readonly retained: true;
};

export type HistoryCheckpoint = {
  readonly checkpointId: HistoryCheckpointId;
  readonly strategyVersion: typeof HISTORY_CHECKPOINT_VERSION;
  readonly originalEventIds: readonly EventId[];
  readonly eventLogRewritten: false;
  readonly preserved: readonly HistoryPreservedItem[];
  readonly folded: CompactReduceResult | null;
  readonly expansions: readonly HistoryExpansion[];
  readonly compactUse: CompactReduceResult["compactUse"] | null;
};

export type OverflowRetryInput = HistoryCheckpointInput & {
  readonly consecutiveOverflows?: unknown;
  readonly reason?: unknown;
};

export type OverflowRetry = {
  readonly action: "retry";
  readonly overflowRetries: 1;
  readonly checkpoint: HistoryCheckpoint;
};

export type WindowPreviewInput = HistoryCheckpointInput & {
  readonly fromWindowTokens?: unknown;
  readonly toWindowTokens?: unknown;
};

const itemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(HISTORY_ITEM_KINDS),
  text: z.string().min(1),
  retained: z.boolean().optional(),
});

function compactError(code: CompactError["code"], field: string | null): CompactError {
  return { kind: "compact", code, field };
}

function isRequiredKind(kind: HistoryItemKind): kind is HistoryRequiredKind {
  return (HISTORY_REQUIRED_KINDS as readonly string[]).includes(kind);
}

function parseCheckpointId(value: unknown): Result<HistoryCheckpointId, CompactError> {
  const parsed = historyCheckpointId.parse(value);
  if (!parsed.ok) {
    return err(compactError("malformed", "checkpointId"));
  }
  return ok(parsed.value);
}

function parseEventId(value: string): Result<EventId, CompactError> {
  const parsed = eventId.parse(value);
  if (!parsed.ok) {
    return err(compactError("malformed", "items.id"));
  }
  return ok(parsed.value);
}

function itemByteCap(kind: HistoryItemKind): number {
  return kind === "skill-instruction" ? MAX_SKILL_INSTRUCTION_BYTES : MAX_HISTORY_ITEM_BYTES;
}

/**
 * Record a history checkpoint without rewriting the original event identities.
 */
export function checkpointHistory(
  input: HistoryCheckpointInput,
  hasher: ContentHasherPort,
  port: CompactModelPort | null,
): Result<HistoryCheckpoint, CompactError> {
  if (input.cancelled === true) {
    return err(compactError("cancelled", "signal"));
  }
  const checkpointId = parseCheckpointId(input.checkpointId);
  if (!checkpointId.ok) {
    return checkpointId;
  }
  if (!Array.isArray(input.items)) {
    return err(compactError("malformed", "items"));
  }
  if (input.items.length === 0) {
    return err(compactError("empty", "items"));
  }
  if (input.items.length > MAX_HISTORY_ITEMS) {
    return err(compactError("oversized", "items"));
  }

  const originalEventIds: EventId[] = [];
  const preserved: HistoryPreservedItem[] = [];
  const foldable: string[] = [];
  const expansions: HistoryExpansion[] = [];
  const seen = new Set<string>();

  for (const raw of input.items) {
    const parsed = itemSchema.safeParse(raw);
    if (!parsed.success) {
      return err(compactError("malformed", "items"));
    }
    const item = parsed.data;
    if (item.text.includes("\0")) {
      return err(compactError("malformed", "items.text"));
    }
    const encoded = new TextEncoder().encode(item.text);
    if (encoded.byteLength > itemByteCap(item.kind)) {
      return err(compactError("oversized", "items.text"));
    }
    const id = parseEventId(item.id);
    if (!id.ok) {
      return id;
    }
    if (seen.has(id.value)) {
      return err(compactError("malformed", "items.id"));
    }
    seen.add(id.value);
    originalEventIds.push(id.value);
    if (item.retained === true) {
      expansions.push({ eventId: id.value, retained: true });
    }
    if (isRequiredKind(item.kind)) {
      preserved.push({ id: id.value, kind: item.kind, text: item.text });
      continue;
    }
    foldable.push(item.text);
  }

  let folded: CompactReduceResult | null = null;
  if (foldable.length > 0) {
    const reduced = reduceCompact(
      {
        text: foldable.join("\n"),
        ...(input.compactUse === undefined ? {} : { compactUse: input.compactUse }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      },
      hasher,
      port,
    );
    if (!reduced.ok) {
      return reduced;
    }
    folded = reduced.value;
  }

  return ok({
    checkpointId: checkpointId.value,
    strategyVersion: HISTORY_CHECKPOINT_VERSION,
    originalEventIds,
    eventLogRewritten: false,
    preserved,
    folded,
    expansions,
    compactUse: folded?.compactUse ?? null,
  });
}

/**
 * Classify a prompt-too-long overflow, compact once, and retry.
 *
 * A second consecutive overflow is a typed failure. The original log is not
 * rewritten.
 */
export function retryAfterOverflow(
  input: OverflowRetryInput,
  hasher: ContentHasherPort,
  port: CompactModelPort | null,
): Result<OverflowRetry, CompactError> {
  if (input.reason !== "prompt-too-long") {
    return err(compactError("unsupported", "reason"));
  }
  const consecutive = input.consecutiveOverflows === undefined ? 0 : input.consecutiveOverflows;
  if (typeof consecutive !== "number" || !Number.isSafeInteger(consecutive) || consecutive < 0) {
    return err(compactError("malformed", "consecutiveOverflows"));
  }
  if (consecutive >= 1) {
    return err(compactError("overflow-exhausted", "consecutiveOverflows"));
  }
  const checkpoint = checkpointHistory(input, hasher, port);
  if (!checkpoint.ok) {
    return checkpoint;
  }
  return ok({
    action: "retry",
    overflowRetries: 1,
    checkpoint: checkpoint.value,
  });
}

/**
 * Compact-preview before switching onto a strictly smaller model window.
 */
export function previewCompactForSmallerWindow(
  input: WindowPreviewInput,
  hasher: ContentHasherPort,
  port: CompactModelPort | null,
): Result<HistoryCheckpoint, CompactError> {
  const from = input.fromWindowTokens;
  const to = input.toWindowTokens;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to < 1
  ) {
    return err(compactError("malformed", "window"));
  }
  if (to >= from) {
    return err(compactError("unsupported", "toWindowTokens"));
  }
  return checkpointHistory(input, hasher, port);
}

export function describeHistoryItemKind(kind: HistoryItemKind): string {
  switch (kind) {
    case "user-commitment":
    case "decision":
    case "unresolved-question":
    case "task-state":
    case "tool-outcome":
    case "citation":
    case "artifact":
    case "uncertainty":
    case "correction":
    case "skill-instruction":
    case "turn-prose":
      return kind;
    default:
      return assertNever(kind, "unhandled history item kind");
  }
}
