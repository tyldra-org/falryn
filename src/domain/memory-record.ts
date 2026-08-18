/**
 * Attributed, correctable, versioned memory records (#109).
 *
 * A record is durable knowledge beyond one turn. Conversation text and
 * temporary model inferences are not automatically stored as truth.
 * Corrections create a new identity with supersession links; the superseded
 * record is not rewritten. Admission policy, recall, deletion, operational
 * learning, and product tools remain later children of #108.
 */

import { z } from "zod";

import {
  ARTIFACT_SENSITIVITIES,
  type ArtifactSensitivity,
  isArtifactSensitivity,
} from "./artifact.ts";
import { brandedString, timestampSchema } from "./branded-schema.ts";
import {
  type EventId,
  eventId,
  type MemoryId,
  memoryId,
  type WorkspaceId,
  workspaceId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";
import { timestampToEpochMilliseconds } from "./time.ts";

export const MEMORY_RECORD_VERSION = "memory.v1";
export const FIRST_MEMORY_GENERATION = 1;
export const MAX_MEMORY_SUBJECT_BYTES = 256;
export const MAX_MEMORY_CONTENT_BYTES = 8 * 1_024;
export const MAX_MEMORY_LOCATOR_BYTES = 256;
export const MAX_MEMORY_PROVENANCE_LOCATOR_BYTES = 512;
export const MAX_MEMORY_PROVENANCE = 8;
export const MAX_MEMORY_SUPERSEDES = 16;

export const MEMORY_KINDS = [
  "user-preference",
  "project-fact",
  "workflow-convention",
  "decision",
  "correction",
  "recurring-task-context",
  "reusable-technical-knowledge",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SCOPE_KINDS = [
  "user",
  "workspace",
  "repository",
  "branch",
  "worktree",
  "agent",
  "provider",
  "collection",
] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

export const MEMORY_ORIGINS = ["user-request", "repeated-fact", "correction"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

const REFUSED_MEMORY_ORIGINS = ["inference", "conversation", "model", "temporary"] as const;

export type MemoryScope =
  | { readonly kind: "user" }
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | {
      readonly kind: "repository" | "branch" | "worktree" | "agent";
      readonly workspaceId: WorkspaceId;
      readonly locator: string;
    }
  | { readonly kind: "provider" | "collection"; readonly locator: string };

export type MemoryProvenance = {
  readonly origin: MemoryOrigin;
  readonly locator: string;
  readonly eventId: EventId | null;
};

export type MemoryRecord = {
  readonly schemaVersion: typeof MEMORY_RECORD_VERSION;
  readonly memoryId: MemoryId;
  readonly generation: number;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly subject: string;
  readonly content: string;
  readonly provenance: readonly MemoryProvenance[];
  readonly confidence: number;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdAt: Timestamp;
  readonly reviewAfter: Timestamp | null;
  readonly expiresAt: Timestamp | null;
  readonly supersedes: readonly MemoryId[];
};

export type MemoryErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "unavailable"
  | "secret"
  | "empty"
  | "cancelled"
  | "conflict"
  | "stale";

export type MemoryError = {
  readonly kind: "memory";
  readonly code: MemoryErrorCode;
  readonly field: string | null;
};

export type MemoryRecordInput = {
  readonly memoryId?: unknown;
  readonly schemaVersion?: unknown;
  readonly generation?: unknown;
  readonly scope?: unknown;
  readonly kind?: unknown;
  readonly subject?: unknown;
  readonly content?: unknown;
  readonly provenance?: unknown;
  readonly confidence?: unknown;
  readonly sensitivity?: unknown;
  readonly createdAt?: unknown;
  readonly reviewAfter?: unknown;
  readonly expiresAt?: unknown;
  readonly supersedes?: unknown;
  readonly cancelled?: unknown;
};

const encoder = new TextEncoder();

const kindSchema = z.enum(MEMORY_KINDS);
const originSchema = z.enum(MEMORY_ORIGINS);
const locatorSchema = z
  .string()
  .min(1)
  .max(MAX_MEMORY_LOCATOR_BYTES)
  .refine((value) => !value.includes("\0"), { message: "nul" });
const provenanceLocatorSchema = z
  .string()
  .min(1)
  .max(MAX_MEMORY_PROVENANCE_LOCATOR_BYTES)
  .refine((value) => !value.includes("\0"), { message: "nul" });

function locatedWorkspaceScope(kind: "repository" | "branch" | "worktree" | "agent") {
  return z
    .object({
      kind: z.literal(kind),
      workspaceId: brandedString(workspaceId),
      locator: locatorSchema,
    })
    .strict();
}

function namedScope(kind: "provider" | "collection") {
  return z
    .object({
      kind: z.literal(kind),
      locator: locatorSchema,
    })
    .strict();
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("workspace"),
      workspaceId: brandedString(workspaceId),
    })
    .strict(),
  locatedWorkspaceScope("repository"),
  locatedWorkspaceScope("branch"),
  locatedWorkspaceScope("worktree"),
  locatedWorkspaceScope("agent"),
  namedScope("provider"),
  namedScope("collection"),
]);

const provenanceEntrySchema = z
  .object({
    origin: originSchema,
    locator: provenanceLocatorSchema,
    eventId: brandedString(eventId).optional(),
  })
  .strict();

function memoryError(code: MemoryErrorCode, field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export function describeMemoryError(error: MemoryError): string {
  const field = error.field === null ? "memory" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "unavailable":
      return `unavailable ${field}`;
    case "secret":
      return `secret ${field}`;
    case "empty":
      return `empty ${field}`;
    case "cancelled":
      return `cancelled ${field}`;
    case "conflict":
      return `conflict ${field}`;
    case "stale":
      return `stale ${field}`;
    default:
      return assertNever(error.code, "unhandled memory error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function fromZod(error: z.ZodError, fallback: string): MemoryError {
  const issue = error.issues[0];
  if (issue === undefined) {
    return memoryError("malformed", fallback);
  }
  const field =
    issue.path.length === 0 ? fallback : issue.path.map((segment) => String(segment)).join(".");
  if (issue.code === "too_big") {
    return memoryError("oversized", field);
  }
  if (issue.message === "nul") {
    return memoryError("malformed", field);
  }
  return memoryError("malformed", field);
}

function parseBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): Result<string, MemoryError> {
  if (typeof value !== "string") {
    return err(memoryError("malformed", field));
  }
  if (value.includes("\0")) {
    return err(memoryError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(memoryError("empty", field));
  }
  if (byteLength(trimmed) > maxBytes) {
    return err(memoryError("oversized", field));
  }
  return ok(trimmed);
}

function parseGeneration(value: unknown): Result<number, MemoryError> {
  const raw = value === undefined ? FIRST_MEMORY_GENERATION : value;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    return err(memoryError("malformed", "generation"));
  }
  if (raw < FIRST_MEMORY_GENERATION) {
    return err(memoryError("malformed", "generation"));
  }
  return ok(raw);
}

function parseConfidence(value: unknown): Result<number, MemoryError> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return err(memoryError("malformed", "confidence"));
  }
  if (value < 0 || value > 100) {
    return err(memoryError("malformed", "confidence"));
  }
  return ok(value);
}

function parseOptionalTimestamp(
  value: unknown,
  field: string,
): Result<Timestamp | null, MemoryError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success) {
    return err(fromZod(parsed.error, field));
  }
  return ok(parsed.data);
}

function refusedOrigin(value: unknown): boolean {
  return typeof value === "string" && (REFUSED_MEMORY_ORIGINS as readonly string[]).includes(value);
}

function parseProvenance(value: unknown): Result<readonly MemoryProvenance[], MemoryError> {
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "provenance"));
  }
  if (value.length === 0) {
    return err(memoryError("empty", "provenance"));
  }
  if (value.length > MAX_MEMORY_PROVENANCE) {
    return err(memoryError("oversized", "provenance"));
  }
  const entries: MemoryProvenance[] = [];
  for (const [index, entry] of value.entries()) {
    const origin =
      entry !== null && typeof entry === "object"
        ? (entry as { origin?: unknown }).origin
        : undefined;
    if (refusedOrigin(origin)) {
      return err(memoryError("unsupported", `provenance.${index}.origin`));
    }
    const parsed = provenanceEntrySchema.safeParse(entry);
    if (!parsed.success) {
      return err(fromZod(parsed.error, `provenance.${index}`));
    }
    entries.push({
      origin: parsed.data.origin,
      locator: parsed.data.locator,
      eventId: parsed.data.eventId ?? null,
    });
  }
  return ok(entries);
}

function parseSupersedes(value: unknown): Result<readonly MemoryId[], MemoryError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "supersedes"));
  }
  if (value.length > MAX_MEMORY_SUPERSEDES) {
    return err(memoryError("oversized", "supersedes"));
  }
  const ids: MemoryId[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const parsed = memoryId.parse(raw);
    if (!parsed.ok) {
      return err(memoryError("malformed", `supersedes.${index}`));
    }
    if (seen.has(parsed.value)) {
      return err(memoryError("malformed", `supersedes.${index}`));
    }
    seen.add(parsed.value);
    ids.push(parsed.value);
  }
  return ok(ids);
}

function parseScope(value: unknown): Result<MemoryScope, MemoryError> {
  const parsed = scopeSchema.safeParse(value);
  if (!parsed.success) {
    return err(fromZod(parsed.error, "scope"));
  }
  return ok(parsed.data);
}

/**
 * Validates an untrusted candidate into a durable memory record.
 *
 * Inference, conversation auto-promotion, and empty provenance fail closed.
 * The function is pure: it does not persist, mutate a prior id, or rank recall.
 */
export function defineMemoryRecord(input: MemoryRecordInput): Result<MemoryRecord, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== MEMORY_RECORD_VERSION) {
    return err(memoryError("unsupported", "schemaVersion"));
  }
  const id = memoryId.parse(input.memoryId);
  if (!id.ok) {
    return err(memoryError("malformed", "memoryId"));
  }
  const generation = parseGeneration(input.generation);
  if (!generation.ok) {
    return generation;
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) {
    return scope;
  }
  const kindParsed = kindSchema.safeParse(input.kind);
  if (!kindParsed.success) {
    return err(memoryError("malformed", "kind"));
  }
  const subject = parseBoundedText(input.subject, "subject", MAX_MEMORY_SUBJECT_BYTES);
  if (!subject.ok) {
    return subject;
  }
  const content = parseBoundedText(input.content, "content", MAX_MEMORY_CONTENT_BYTES);
  if (!content.ok) {
    return content;
  }
  const provenance = parseProvenance(input.provenance);
  if (!provenance.ok) {
    return provenance;
  }
  const confidence = parseConfidence(input.confidence);
  if (!confidence.ok) {
    return confidence;
  }
  const sensitivity = input.sensitivity === undefined ? "user-content" : input.sensitivity;
  if (!isArtifactSensitivity(sensitivity)) {
    return err(memoryError("malformed", "sensitivity"));
  }
  const createdAt = timestampSchema.safeParse(input.createdAt);
  if (!createdAt.success) {
    return err(fromZod(createdAt.error, "createdAt"));
  }
  const reviewAfter = parseOptionalTimestamp(input.reviewAfter, "reviewAfter");
  if (!reviewAfter.ok) {
    return reviewAfter;
  }
  const expiresAt = parseOptionalTimestamp(input.expiresAt, "expiresAt");
  if (!expiresAt.ok) {
    return expiresAt;
  }
  const createdMs = timestampToEpochMilliseconds(createdAt.data);
  if (reviewAfter.value !== null && timestampToEpochMilliseconds(reviewAfter.value) < createdMs) {
    return err(memoryError("stale", "reviewAfter"));
  }
  if (expiresAt.value !== null && timestampToEpochMilliseconds(expiresAt.value) < createdMs) {
    return err(memoryError("stale", "expiresAt"));
  }
  if (
    reviewAfter.value !== null &&
    expiresAt.value !== null &&
    timestampToEpochMilliseconds(reviewAfter.value) > timestampToEpochMilliseconds(expiresAt.value)
  ) {
    return err(memoryError("malformed", "reviewAfter"));
  }
  const supersedes = parseSupersedes(input.supersedes);
  if (!supersedes.ok) {
    return supersedes;
  }
  if (supersedes.value.includes(id.value)) {
    return err(memoryError("malformed", "supersedes"));
  }
  if (supersedes.value.length === 0 && generation.value !== FIRST_MEMORY_GENERATION) {
    return err(memoryError("malformed", "generation"));
  }
  if (supersedes.value.length > 0 && generation.value === FIRST_MEMORY_GENERATION) {
    return err(memoryError("malformed", "generation"));
  }

  return ok({
    schemaVersion: MEMORY_RECORD_VERSION,
    memoryId: id.value,
    generation: generation.value,
    scope: scope.value,
    kind: kindParsed.data,
    subject: subject.value,
    content: content.value,
    provenance: provenance.value,
    confidence: confidence.value,
    sensitivity,
    createdAt: createdAt.data,
    reviewAfter: reviewAfter.value,
    expiresAt: expiresAt.value,
    supersedes: supersedes.value,
  });
}

export const MEMORY_SENSITIVITIES = ARTIFACT_SENSITIVITIES;
