/**
 * Memory recall, ranking, freshness, and contradiction handling (#111).
 *
 * Filters stored records by workspace, destination sensitivity, expiry, and
 * staleness, then ranks relevance, freshness, and confidence. Contradictory
 * facts stay visible until a superseding record resolves them. Newer is not
 * automatically truer. Correction operations and product tools remain later.
 */

import { z } from "zod";

import {
  ARTIFACT_SENSITIVITIES,
  type ArtifactSensitivity,
  isArtifactSensitivity,
} from "./artifact.ts";
import { type MemoryId, memoryId, workspaceId } from "./identity.ts";
import { type MemoryError, type MemoryRecord, memoryScopeWorkspaceId } from "./memory-record.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import { timestampToEpochMilliseconds } from "./time.ts";

export const MEMORY_RECALL_VERSION = "memory-recall.v1";
export const DEFAULT_MEMORY_RECALL_MAX = 16;
export const HARD_MEMORY_RECALL_MAX = 64;
export const MAX_MEMORY_RECALL_QUERY_BYTES = 256;

export const MEMORY_RECALL_SIGNALS = [
  "query-relevance",
  "freshness",
  "confidence",
  "workspace",
  "pinned",
  "contradiction",
] as const;
export type MemoryRecallSignal = (typeof MEMORY_RECALL_SIGNALS)[number];

export const MEMORY_RECALL_OMISSION_REASONS = [
  "wrong-workspace",
  "expired",
  "stale",
  "sensitivity",
  "superseded",
  "unrelated",
  "rank-limit",
] as const;
export type MemoryRecallOmissionReason = (typeof MEMORY_RECALL_OMISSION_REASONS)[number];

export type MemoryRecallInput = {
  readonly records?: unknown;
  readonly workspaceId?: unknown;
  readonly query?: unknown;
  readonly destination?: unknown;
  readonly now?: unknown;
  readonly maxResults?: unknown;
  readonly pinnedIds?: unknown;
  readonly cancelled?: unknown;
};

export type MemoryRecallHit = {
  readonly record: MemoryRecord;
  readonly score: number;
  readonly reasons: readonly MemoryRecallSignal[];
};

export type MemoryRecallOmission = {
  readonly memoryId: MemoryId;
  readonly reason: MemoryRecallOmissionReason;
};

export type MemoryContradiction = {
  readonly subject: string;
  readonly memoryIds: readonly MemoryId[];
};

export type MemoryRecallResult = {
  readonly strategyVersion: typeof MEMORY_RECALL_VERSION;
  readonly selected: readonly MemoryRecallHit[];
  readonly omitted: readonly MemoryRecallOmission[];
  readonly contradictions: readonly MemoryContradiction[];
};

const encoder = new TextEncoder();

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

function sensitivityRank(value: ArtifactSensitivity): number {
  return ARTIFACT_SENSITIVITIES.indexOf(value);
}

function parseRecords(value: unknown): Result<readonly MemoryRecord[], MemoryError> {
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "records"));
  }
  if (value.length > HARD_MEMORY_RECALL_MAX * 4) {
    return err(memoryError("oversized", "records"));
  }
  const records: MemoryRecord[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("memoryId" in entry) ||
      !("scope" in entry)
    ) {
      return err(memoryError("malformed", `records.${index}`));
    }
    records.push(entry as MemoryRecord);
  }
  return ok(records);
}

function parseQuery(value: unknown): Result<string | null, MemoryError> {
  if (value === undefined || value === null || value === "") {
    return ok(null);
  }
  if (typeof value !== "string" || value.includes("\0")) {
    return err(memoryError("malformed", "query"));
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return ok(null);
  }
  if (encoder.encode(trimmed).byteLength > MAX_MEMORY_RECALL_QUERY_BYTES) {
    return err(memoryError("oversized", "query"));
  }
  return ok(trimmed);
}

function parseMaxResults(value: unknown): Result<number, MemoryError> {
  const raw = value === undefined ? DEFAULT_MEMORY_RECALL_MAX : value;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    return err(memoryError("malformed", "maxResults"));
  }
  if (raw < 1) {
    return err(memoryError("malformed", "maxResults"));
  }
  if (raw > HARD_MEMORY_RECALL_MAX) {
    return err(memoryError("oversized", "maxResults"));
  }
  return ok(raw);
}

function parsePinnedIds(value: unknown): Result<ReadonlySet<string>, MemoryError> {
  if (value === undefined) {
    return ok(new Set());
  }
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "pinnedIds"));
  }
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const parsed = memoryId.parse(raw);
    if (!parsed.ok) {
      return err(memoryError("malformed", `pinnedIds.${index}`));
    }
    ids.add(parsed.value);
  }
  return ok(ids);
}

function parseNow(value: unknown, fallbackMs: number): Result<number, MemoryError> {
  if (value === undefined) {
    return ok(fallbackMs);
  }
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    return err(memoryError("malformed", "now"));
  }
  const ms = Date.parse(parsed.data);
  if (Number.isNaN(ms)) {
    return err(memoryError("malformed", "now"));
  }
  return ok(ms);
}

function tokens(query: string): readonly string[] {
  return query.split(/\s+/).filter((part) => part.length > 0);
}

function relevance(record: MemoryRecord, query: string | null): number {
  if (query === null) {
    return 1;
  }
  const haystack = `${record.subject} ${record.content}`.toLowerCase();
  const parts = tokens(query);
  if (parts.length === 0) {
    return 1;
  }
  let hits = 0;
  for (const part of parts) {
    if (haystack.includes(part)) {
      hits += 1;
    }
  }
  return hits / parts.length;
}

/**
 * Recalls in-scope memory with explanations. Contradictions are reported, not
 * collapsed. A superseded identity is omitted; an unresolved pair stays selected.
 */
export function recallMemory(input: MemoryRecallInput): Result<MemoryRecallResult, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const workspace = workspaceId.parse(input.workspaceId);
  if (!workspace.ok) {
    return err(memoryError("malformed", "workspaceId"));
  }
  const records = parseRecords(input.records);
  if (!records.ok) {
    return records;
  }
  const query = parseQuery(input.query);
  if (!query.ok) {
    return query;
  }
  const destinationRaw = input.destination === undefined ? "user-content" : input.destination;
  if (!isArtifactSensitivity(destinationRaw)) {
    return err(memoryError("malformed", "destination"));
  }
  const maxResults = parseMaxResults(input.maxResults);
  if (!maxResults.ok) {
    return maxResults;
  }
  const pinned = parsePinnedIds(input.pinnedIds);
  if (!pinned.ok) {
    return pinned;
  }
  const newest = records.value.reduce((latest, record) => {
    return Math.max(latest, timestampToEpochMilliseconds(record.createdAt));
  }, 0);
  const now = parseNow(input.now, newest);
  if (!now.ok) {
    return now;
  }

  const superseded = new Set<string>();
  for (const record of records.value) {
    for (const id of record.supersedes) {
      superseded.add(id);
    }
  }

  const omitted: MemoryRecallOmission[] = [];
  const eligible: MemoryRecallHit[] = [];
  const destRank = sensitivityRank(destinationRaw);

  for (const record of records.value) {
    const recordWorkspace = memoryScopeWorkspaceId(record.scope);
    if (recordWorkspace !== null && recordWorkspace !== workspace.value) {
      omitted.push({ memoryId: record.memoryId, reason: "wrong-workspace" });
      continue;
    }
    if (record.expiresAt !== null && timestampToEpochMilliseconds(record.expiresAt) < now.value) {
      omitted.push({ memoryId: record.memoryId, reason: "expired" });
      continue;
    }
    if (
      record.reviewAfter !== null &&
      timestampToEpochMilliseconds(record.reviewAfter) < now.value
    ) {
      omitted.push({ memoryId: record.memoryId, reason: "stale" });
      continue;
    }
    if (superseded.has(record.memoryId)) {
      omitted.push({ memoryId: record.memoryId, reason: "superseded" });
      continue;
    }
    if (sensitivityRank(record.sensitivity) > destRank) {
      omitted.push({ memoryId: record.memoryId, reason: "sensitivity" });
      continue;
    }
    const rel = relevance(record, query.value);
    if (query.value !== null && rel === 0) {
      omitted.push({ memoryId: record.memoryId, reason: "unrelated" });
      continue;
    }
    const reasons: MemoryRecallSignal[] = [];
    let score = record.confidence;
    if (rel > 0 && query.value !== null) {
      score += Math.round(rel * 40);
      reasons.push("query-relevance");
    }
    const ageMs = Math.max(0, now.value - timestampToEpochMilliseconds(record.createdAt));
    if (ageMs < 86_400_000) {
      score += 10;
      reasons.push("freshness");
    }
    reasons.push("confidence");
    if (recordWorkspace === workspace.value) {
      reasons.push("workspace");
      score += 5;
    }
    if (pinned.value.has(record.memoryId)) {
      reasons.push("pinned");
      score += 50;
    }
    eligible.push({ record, score, reasons });
  }

  eligible.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.record.memoryId < right.record.memoryId ? -1 : 1;
  });

  const ranked = eligible.slice(0, maxResults.value);
  for (const extra of eligible.slice(maxResults.value)) {
    omitted.push({ memoryId: extra.record.memoryId, reason: "rank-limit" });
  }

  const bySubject = new Map<string, MemoryId[]>();
  for (const hit of ranked) {
    const key = hit.record.subject.toLowerCase();
    const existing = bySubject.get(key) ?? [];
    existing.push(hit.record.memoryId);
    bySubject.set(key, existing);
  }
  const contradictionSubjects = new Set<string>();
  const contradictions: MemoryContradiction[] = [];
  for (const [subject, memoryIds] of bySubject) {
    if (memoryIds.length > 1) {
      contradictionSubjects.add(subject);
      contradictions.push({ subject, memoryIds });
    }
  }
  const selected = ranked.map((hit) => {
    if (!contradictionSubjects.has(hit.record.subject.toLowerCase())) {
      return hit;
    }
    return {
      ...hit,
      reasons: hit.reasons.includes("contradiction")
        ? hit.reasons
        : [...hit.reasons, "contradiction" as const],
    };
  });

  return ok({
    strategyVersion: MEMORY_RECALL_VERSION,
    selected,
    omitted,
    contradictions,
  });
}

export function describeMemoryRecallOmission(reason: MemoryRecallOmissionReason): string {
  switch (reason) {
    case "wrong-workspace":
      return "wrong-workspace";
    case "expired":
      return "expired";
    case "stale":
      return "stale";
    case "sensitivity":
      return "sensitivity";
    case "superseded":
      return "superseded";
    case "unrelated":
      return "unrelated";
    case "rank-limit":
      return "rank-limit";
    default:
      return assertNever(reason, "unhandled memory recall omission");
  }
}
