/**
 * Loom compress-cache-retrieve manifests and exact retrieval (#104).
 *
 * Groups one or more exact artifacts behind a reversible manifest, then
 * projects a verified member as a full retrieve, range, head/tail, or search
 * hits. A group is exact-recoverable only when every required member is
 * available and verifies. Restricted content is refused and never cached.
 * Structural reducers exist for #105. Compact-model and history checkpoints
 * exist for #106. Product tools stay later.
 */

import { z } from "zod";

import {
  ARTIFACT_AVAILABILITIES,
  ARTIFACT_ENCODINGS,
  ARTIFACT_SENSITIVITIES,
  type ArtifactAvailability,
  type ArtifactEncoding,
  type ArtifactId,
  type ArtifactSensitivity,
  artifactId,
  type ContentDigest,
  contentDigest,
  MAX_ARTIFACT_BYTES,
  MAX_MEDIA_TYPE_LENGTH,
} from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import { brandedString, timestampSchema } from "./branded-schema.ts";
import { CONTEXT_BUDGET_DESTINATIONS, type ContextBudgetDestination } from "./context-budget.ts";
import {
  EVIDENCE_FRESHNESSES,
  type EvidenceFidelity,
  type EvidenceFreshness,
  type ExactSourceHandle,
  MAX_EVIDENCE_BATCH,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import {
  type EvidenceId,
  evidenceId,
  type LoomManifestId,
  loomManifestId,
  type SessionId,
  sessionId,
  type WorkspaceId,
  workspaceId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";
import { timestampToEpochMilliseconds } from "./time.ts";

export const DEFAULT_LOOM_STRATEGY = "loom.v1";
export const DEFAULT_LOOM_PROJECTION_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const HARD_LOOM_PROJECTION_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const DEFAULT_LOOM_CACHE_ENTRIES = 32;
export const HARD_LOOM_CACHE_ENTRIES = MAX_EVIDENCE_BATCH;
export const MAX_LOOM_KEY_FIELD = 128;
export const MAX_LOOM_MEMBERS = 16;
export const MAX_LOOM_PROTECTED_FACTS = 8;
export const MAX_LOOM_PROTECTED_FACT_BYTES = 128;
export const MAX_LOOM_SUMMARY_BYTES = 512;
export const MAX_LOOM_QUERY_BYTES = 128;
export const DEFAULT_LOOM_HEAD_BYTES = 256;
export const DEFAULT_LOOM_TAIL_BYTES = 256;
export const DEFAULT_LOOM_SEARCH_HITS = 8;
export const HARD_LOOM_SEARCH_HITS = 32;
export const DEFAULT_LOOM_SEARCH_CONTEXT_BYTES = 64;

export const LOOM_PROJECTION_KINDS = ["exact", "range", "head-tail", "search-hits"] as const;
export type LoomProjectionKind = (typeof LOOM_PROJECTION_KINDS)[number];

export const LOOM_UNSUPPORTED_PROJECTION_KINDS = [
  "structural",
  "indexed-chunks",
  "lossy-summary",
] as const;
export type LoomUnsupportedProjectionKind = (typeof LOOM_UNSUPPORTED_PROJECTION_KINDS)[number];

export type LoomErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "unavailable"
  | "checksum"
  | "secret"
  | "denied"
  | "expired"
  | "empty";

export type LoomError = {
  readonly kind: "loom";
  readonly code: LoomErrorCode;
  readonly field: string | null;
};

export type LoomProtectedFact = string;

export type LoomMember = {
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly sensitivity: ArtifactSensitivity;
  readonly availability: ArtifactAvailability;
  readonly required: boolean;
  readonly protectedFacts: readonly LoomProtectedFact[];
  readonly summary: string | null;
};

export type LoomManifest = {
  readonly id: LoomManifestId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly members: readonly LoomMember[];
  readonly exactRecoverable: boolean;
  readonly generation: string;
  readonly retentionUntil: Timestamp | null;
};

export type LoomHandle = {
  readonly manifestId: LoomManifestId;
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
};

export type LoomOmission =
  | { readonly kind: "bytes"; readonly count: number }
  | { readonly kind: "hits-capped"; readonly count: number };

export type LoomSearchHit = {
  readonly offset: number;
  readonly byteLength: number;
  readonly text: string;
};

export type LoomCacheStatus = "hit" | "miss";

export type LoomProjectionRequest =
  | {
      readonly kind: "exact";
      readonly member: string;
      readonly maxBytes?: number;
    }
  | {
      readonly kind: "range";
      readonly member: string;
      readonly offset?: number;
      readonly length?: number;
      readonly maxBytes?: number;
    }
  | {
      readonly kind: "head-tail";
      readonly member: string;
      readonly headBytes?: number;
      readonly tailBytes?: number;
      readonly maxBytes?: number;
    }
  | {
      readonly kind: "search-hits";
      readonly member: string;
      readonly query: string;
      readonly maxHits?: number;
      readonly contextBytes?: number;
      readonly maxBytes?: number;
    };

export type LoomMemberBytes = {
  readonly artifactId: string;
  readonly bytes: Uint8Array | null;
  readonly availability?: string;
};

export type LoomCommitInput = {
  readonly id: unknown;
  readonly workspaceId: unknown;
  readonly sessionId: unknown;
  readonly members: unknown;
  readonly generation?: unknown;
  readonly retentionUntil?: unknown;
};

export type LoomRetrieveInput = {
  readonly id: unknown;
  readonly freshness?: unknown;
  readonly manifest: LoomManifest;
  readonly expectedWorkspaceId: unknown;
  readonly expectedSessionId: unknown;
  readonly members: readonly LoomMemberBytes[];
  readonly projection: unknown;
  readonly destination?: unknown;
  readonly generation?: unknown;
  readonly strategyVersion?: unknown;
  readonly configuration?: unknown;
  readonly now?: unknown;
};

export type LoomProjectionResult = {
  readonly id: EvidenceId;
  readonly manifestId: LoomManifestId;
  readonly fidelity: EvidenceFidelity;
  readonly freshness: EvidenceFreshness;
  readonly text: string;
  readonly projection: LoomProjectionKind;
  readonly offset: number;
  readonly byteLength: number;
  readonly sourceBytes: number;
  readonly complete: boolean;
  readonly claimsExact: boolean;
  readonly cache: LoomCacheStatus;
  readonly exactRecoverable: boolean;
  readonly exactSource: ExactSourceHandle | null;
  readonly expansion: ExactSourceHandle;
  readonly handle: LoomHandle;
  readonly omissions: readonly LoomOmission[];
  readonly hits: readonly LoomSearchHit[];
  readonly protectedFacts: readonly LoomProtectedFact[];
  readonly lineage: readonly string[];
};

export type LoomCacheKey = {
  readonly digest: ContentDigest;
  readonly generation: string;
  readonly strategyVersion: string;
  readonly configuration: string;
  readonly destination: ContextBudgetDestination;
  readonly projection: LoomProjectionKind;
  readonly member: ArtifactId;
  readonly boundA: number;
  readonly boundB: number;
  readonly maxBytes: number;
  readonly query: string;
};

export type LoomInvalidation = {
  readonly digest?: ContentDigest;
  readonly generation?: string;
  readonly strategyVersion?: string;
  readonly configuration?: string;
  readonly destination?: ContextBudgetDestination;
  readonly artifactId?: ArtifactId;
  readonly all?: boolean;
};

export type LoomCache = {
  get(key: LoomCacheKey): LoomProjectionResult | null;
  put(key: LoomCacheKey, value: LoomProjectionResult): void;
  invalidate(filter: LoomInvalidation): number;
  get size(): number;
};

type StoredEntry = {
  readonly key: LoomCacheKey;
  readonly value: LoomProjectionResult;
  readonly artifactId: ArtifactId;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const MEDIA_TYPE = /^[!-~]+\/[!-~]+$/;

const memberSchema = z.object({
  artifactId: brandedString(artifactId),
  digest: brandedString(contentDigest),
  byteLength: z.int().min(0).max(MAX_ARTIFACT_BYTES),
  mediaType: z.string().min(3).max(MAX_MEDIA_TYPE_LENGTH).regex(MEDIA_TYPE),
  encoding: z.literal(ARTIFACT_ENCODINGS),
  sensitivity: z.literal(ARTIFACT_SENSITIVITIES),
  availability: z.literal(ARTIFACT_AVAILABILITIES).default("available"),
  required: z.boolean().default(true),
  protectedFacts: z
    .array(z.string().min(1).max(MAX_LOOM_PROTECTED_FACT_BYTES))
    .max(MAX_LOOM_PROTECTED_FACTS)
    .default([]),
  summary: z.string().min(1).max(MAX_LOOM_SUMMARY_BYTES).nullable().default(null),
});

const commitSchema = z.object({
  id: brandedString(loomManifestId),
  workspaceId: brandedString(workspaceId),
  sessionId: brandedString(sessionId),
  members: z.array(memberSchema).min(1).max(MAX_LOOM_MEMBERS),
  generation: z.string().max(MAX_LOOM_KEY_FIELD).default(""),
  retentionUntil: timestampSchema.nullable().optional(),
});

const exactProjectionSchema = z.object({
  kind: z.literal("exact"),
  member: brandedString(artifactId),
  maxBytes: z.int().min(1).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
});

const rangeProjectionSchema = z.object({
  kind: z.literal("range"),
  member: brandedString(artifactId),
  offset: z.int().min(0).optional(),
  length: z.int().min(0).optional(),
  maxBytes: z.int().min(1).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
});

const headTailProjectionSchema = z.object({
  kind: z.literal("head-tail"),
  member: brandedString(artifactId),
  headBytes: z.int().min(0).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
  tailBytes: z.int().min(0).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
  maxBytes: z.int().min(1).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
});

const searchHitsProjectionSchema = z.object({
  kind: z.literal("search-hits"),
  member: brandedString(artifactId),
  query: z.string().min(1).max(MAX_LOOM_QUERY_BYTES),
  maxHits: z.int().min(1).max(HARD_LOOM_SEARCH_HITS).optional(),
  contextBytes: z.int().min(0).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
  maxBytes: z.int().min(1).max(HARD_LOOM_PROJECTION_MAX_BYTES).optional(),
});

const projectionSchema = z.discriminatedUnion("kind", [
  exactProjectionSchema,
  rangeProjectionSchema,
  headTailProjectionSchema,
  searchHitsProjectionSchema,
]);

function loomError(code: LoomErrorCode, field: string | null): LoomError {
  return { kind: "loom", code, field };
}

export function describeLoomError(error: LoomError): string {
  const field = error.field === null ? "loom" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "unavailable":
      return `unavailable ${field}`;
    case "checksum":
      return `checksum ${field}`;
    case "secret":
      return `secret ${field}`;
    case "denied":
      return `denied ${field}`;
    case "expired":
      return `expired ${field}`;
    case "empty":
      return `empty ${field}`;
    default:
      return assertNever(error.code, "unhandled loom error");
  }
}

function fromZod(error: z.ZodError, fallback: string): LoomError {
  const issue = error.issues[0];
  if (issue === undefined) {
    return loomError("malformed", fallback);
  }
  const field =
    issue.path.length === 0 ? fallback : issue.path.map((segment) => String(segment)).join(".");
  if (issue.code === "too_big") {
    return loomError("oversized", field);
  }
  return loomError("malformed", field);
}

function parseKeyField(value: unknown, field: string, fallback: string): Result<string, LoomError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== "string" || value.includes("\0")) {
    return err(loomError("malformed", field));
  }
  if (value.length > MAX_LOOM_KEY_FIELD) {
    return err(loomError("oversized", field));
  }
  return ok(value);
}

function parseClosedUnion<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  unsupported = false,
): Result<T, LoomError> {
  if (value === undefined) {
    return err(loomError("malformed", field));
  }
  if (typeof value !== "string") {
    return err(loomError("malformed", field));
  }
  if (!(allowed as readonly string[]).includes(value)) {
    return err(loomError(unsupported ? "unsupported" : "malformed", field));
  }
  return ok(value as T);
}

function serializeKey(key: LoomCacheKey): string {
  return [
    key.digest,
    key.generation,
    key.strategyVersion,
    key.configuration,
    key.destination,
    key.projection,
    key.member,
    String(key.boundA),
    String(key.boundB),
    String(key.maxBytes),
    key.query,
  ].join("\0");
}

function matchesFilter(entry: StoredEntry, filter: LoomInvalidation): boolean {
  if (filter.all === true) {
    return true;
  }
  if (filter.digest !== undefined && entry.key.digest === filter.digest) {
    return true;
  }
  if (filter.generation !== undefined && entry.key.generation === filter.generation) {
    return true;
  }
  if (
    filter.strategyVersion !== undefined &&
    entry.key.strategyVersion === filter.strategyVersion
  ) {
    return true;
  }
  if (filter.configuration !== undefined && entry.key.configuration === filter.configuration) {
    return true;
  }
  if (filter.destination !== undefined && entry.key.destination === filter.destination) {
    return true;
  }
  if (filter.artifactId !== undefined && entry.artifactId === filter.artifactId) {
    return true;
  }
  return false;
}

export function createLoomCache(maxEntries: number = DEFAULT_LOOM_CACHE_ENTRIES): LoomCache {
  const limit = Math.min(Math.max(1, maxEntries), HARD_LOOM_CACHE_ENTRIES);
  const entries = new Map<string, StoredEntry>();

  return {
    get(key) {
      const serialized = serializeKey(key);
      const stored = entries.get(serialized);
      if (stored === undefined) {
        return null;
      }
      entries.delete(serialized);
      entries.set(serialized, stored);
      return stored.value;
    },
    put(key, value) {
      const serialized = serializeKey(key);
      entries.delete(serialized);
      entries.set(serialized, { key, value, artifactId: key.member });
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    invalidate(filter) {
      let removed = 0;
      for (const [serialized, stored] of entries) {
        if (matchesFilter(stored, filter)) {
          entries.delete(serialized);
          removed += 1;
        }
      }
      return removed;
    },
    get size() {
      return entries.size;
    },
  };
}

function hashBytes(hasher: ContentHasherPort, bytes: Uint8Array): ContentDigest {
  const hash = hasher.create();
  hash.update(bytes);
  return hash.digest();
}

function utf8LeadLength(lead: number): number {
  if ((lead & 0b1000_0000) === 0) {
    return 1;
  }
  if ((lead & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((lead & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((lead & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 1;
}

function sliceUtf8(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  let end = Math.min(bytes.byteLength, offset + length);
  while (end > offset) {
    const previous = bytes[end - 1];
    if (previous === undefined || (previous & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    end -= 1;
  }
  const lead = end > offset ? bytes[end - 1] : undefined;
  if (lead !== undefined && end - 1 + utf8LeadLength(lead) > offset + length) {
    end -= 1;
  }
  return bytes.subarray(offset, end);
}

function byteOffsetOf(text: string, charIndex: number): number {
  return encoder.encode(text.slice(0, charIndex)).byteLength;
}

function groupRecoverable(members: readonly LoomMember[]): boolean {
  return members.every((member) => !member.required || member.availability === "available");
}

export function commitLoomManifest(input: LoomCommitInput): Result<LoomManifest, LoomError> {
  const parsed = commitSchema.safeParse({
    id: input.id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    members: input.members,
    generation: input.generation === undefined ? "" : input.generation,
    retentionUntil: input.retentionUntil === undefined ? null : input.retentionUntil,
  });
  if (!parsed.success) {
    return err(fromZod(parsed.error, "manifest"));
  }
  const seen = new Set<string>();
  for (const member of parsed.data.members) {
    if (seen.has(member.artifactId)) {
      return err(loomError("malformed", "members"));
    }
    seen.add(member.artifactId);
  }
  const generation = parseKeyField(parsed.data.generation, "generation", "");
  if (!generation.ok) {
    return generation;
  }
  const members: LoomMember[] = parsed.data.members.map((member) => ({
    artifactId: member.artifactId,
    digest: member.digest,
    byteLength: member.byteLength,
    mediaType: member.mediaType,
    encoding: member.encoding,
    sensitivity: member.sensitivity,
    availability: member.availability,
    required: member.required,
    protectedFacts: member.protectedFacts,
    summary: member.summary,
  }));
  const retentionUntil = parsed.data.retentionUntil ?? null;
  return ok({
    id: parsed.data.id,
    workspaceId: parsed.data.workspaceId,
    sessionId: parsed.data.sessionId,
    members,
    exactRecoverable: groupRecoverable(members),
    generation: generation.value,
    retentionUntil,
  });
}

type ParsedProjection =
  | {
      readonly kind: "exact";
      readonly member: ArtifactId;
      readonly maxBytes: number;
      readonly boundA: number;
      readonly boundB: number;
      readonly query: string;
    }
  | {
      readonly kind: "range";
      readonly member: ArtifactId;
      readonly offset: number | undefined;
      readonly length: number | undefined;
      readonly maxBytes: number;
      readonly boundA: number;
      readonly boundB: number;
      readonly query: string;
    }
  | {
      readonly kind: "head-tail";
      readonly member: ArtifactId;
      readonly headBytes: number;
      readonly tailBytes: number;
      readonly maxBytes: number;
      readonly boundA: number;
      readonly boundB: number;
      readonly query: string;
    }
  | {
      readonly kind: "search-hits";
      readonly member: ArtifactId;
      readonly query: string;
      readonly maxHits: number;
      readonly contextBytes: number;
      readonly maxBytes: number;
      readonly boundA: number;
      readonly boundB: number;
    };

function parseProjection(value: unknown): Result<ParsedProjection, LoomError> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return err(loomError("malformed", "projection"));
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  if (
    typeof kind === "string" &&
    (LOOM_UNSUPPORTED_PROJECTION_KINDS as readonly string[]).includes(kind)
  ) {
    return err(loomError("unsupported", "projection"));
  }
  const parsed = projectionSchema.safeParse(value);
  if (!parsed.success) {
    return err(fromZod(parsed.error, "projection"));
  }
  const maxBytes = parsed.data.maxBytes ?? DEFAULT_LOOM_PROJECTION_MAX_BYTES;
  switch (parsed.data.kind) {
    case "exact":
      return ok({
        kind: "exact",
        member: parsed.data.member,
        maxBytes,
        boundA: 0,
        boundB: maxBytes,
        query: "",
      });
    case "range":
      return ok({
        kind: "range",
        member: parsed.data.member,
        offset: parsed.data.offset,
        length: parsed.data.length,
        maxBytes,
        boundA: parsed.data.offset ?? 0,
        boundB: parsed.data.length ?? maxBytes,
        query: "",
      });
    case "head-tail":
      return ok({
        kind: "head-tail",
        member: parsed.data.member,
        headBytes: parsed.data.headBytes ?? DEFAULT_LOOM_HEAD_BYTES,
        tailBytes: parsed.data.tailBytes ?? DEFAULT_LOOM_TAIL_BYTES,
        maxBytes,
        boundA: parsed.data.headBytes ?? DEFAULT_LOOM_HEAD_BYTES,
        boundB: parsed.data.tailBytes ?? DEFAULT_LOOM_TAIL_BYTES,
        query: "",
      });
    case "search-hits": {
      const query = parsed.data.query;
      return ok({
        kind: "search-hits",
        member: parsed.data.member,
        query,
        maxHits: parsed.data.maxHits ?? DEFAULT_LOOM_SEARCH_HITS,
        contextBytes: parsed.data.contextBytes ?? DEFAULT_LOOM_SEARCH_CONTEXT_BYTES,
        maxBytes,
        boundA: parsed.data.maxHits ?? DEFAULT_LOOM_SEARCH_HITS,
        boundB: parsed.data.contextBytes ?? DEFAULT_LOOM_SEARCH_CONTEXT_BYTES,
      });
    }
    default:
      return assertNever(parsed.data, "unhandled loom projection");
  }
}

function projectExact(
  bytes: Uint8Array,
  maxBytes: number,
): Result<{ text: string; offset: number; byteLength: number; complete: boolean }, LoomError> {
  if (bytes.byteLength > maxBytes) {
    return err(loomError("oversized", "source"));
  }
  return ok({
    text: decoder.decode(bytes),
    offset: 0,
    byteLength: bytes.byteLength,
    complete: true,
  });
}

function projectRange(
  bytes: Uint8Array,
  offsetInput: number | undefined,
  lengthInput: number | undefined,
  maxBytes: number,
): Result<{ text: string; offset: number; byteLength: number; complete: boolean }, LoomError> {
  const offset = offsetInput ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
    return err(loomError("malformed", "offset"));
  }
  const remaining = bytes.byteLength - offset;
  const requested = lengthInput === undefined ? Math.min(remaining, maxBytes) : lengthInput;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return err(loomError("malformed", "length"));
  }
  if (requested > remaining) {
    return err(loomError("oversized", "length"));
  }
  if (lengthInput === undefined && remaining > maxBytes) {
    return err(loomError("oversized", "source"));
  }
  if (requested > maxBytes) {
    return err(loomError("oversized", "length"));
  }
  const sliced = sliceUtf8(bytes, offset, requested);
  return ok({
    text: decoder.decode(sliced),
    offset,
    byteLength: sliced.byteLength,
    complete: offset === 0 && sliced.byteLength === bytes.byteLength,
  });
}

function projectHeadTail(
  bytes: Uint8Array,
  headBytes: number,
  tailBytes: number,
  maxBytes: number,
): Result<
  {
    text: string;
    offset: number;
    byteLength: number;
    complete: boolean;
    omissions: readonly LoomOmission[];
  },
  LoomError
> {
  if (headBytes + tailBytes > maxBytes) {
    return err(loomError("oversized", "projection"));
  }
  if (bytes.byteLength <= headBytes + tailBytes) {
    const full = projectExact(bytes, maxBytes);
    if (!full.ok) {
      return full;
    }
    return ok({ ...full.value, omissions: [] });
  }
  const head = sliceUtf8(bytes, 0, headBytes);
  const tailOffset = bytes.byteLength - tailBytes;
  const tail = sliceUtf8(bytes, tailOffset, tailBytes);
  const omitted = bytes.byteLength - head.byteLength - tail.byteLength;
  const marker = `\n… ${omitted} bytes omitted …\n`;
  const text = `${decoder.decode(head)}${marker}${decoder.decode(tail)}`;
  return ok({
    text,
    offset: 0,
    byteLength: encoder.encode(text).byteLength,
    complete: false,
    omissions: [{ kind: "bytes", count: omitted }],
  });
}

function projectSearchHits(
  bytes: Uint8Array,
  encoding: ArtifactEncoding,
  query: string,
  maxHits: number,
  contextBytes: number,
  maxBytes: number,
): Result<
  {
    text: string;
    offset: number;
    byteLength: number;
    complete: boolean;
    omissions: readonly LoomOmission[];
    hits: readonly LoomSearchHit[];
  },
  LoomError
> {
  if (encoding !== "identity") {
    return err(loomError("unsupported", "encoding"));
  }
  const text = decoder.decode(bytes);
  const hits: LoomSearchHit[] = [];
  let from = 0;
  let capped = 0;
  while (from < text.length) {
    const index = text.indexOf(query, from);
    if (index === -1) {
      break;
    }
    if (hits.length >= maxHits) {
      capped += 1;
      from = index + query.length;
      continue;
    }
    const start = byteOffsetOf(text, index);
    const contextStart = Math.max(0, start - contextBytes);
    const matchBytes = encoder.encode(query).byteLength;
    const contextLength = start - contextStart + matchBytes + contextBytes;
    const excerptBytes = sliceUtf8(bytes, contextStart, contextLength);
    const excerpt = decoder.decode(excerptBytes);
    hits.push({
      offset: start,
      byteLength: matchBytes,
      text: excerpt,
    });
    from = index + query.length;
  }
  if (hits.length === 0) {
    return err(loomError("empty", "query"));
  }
  const rendered = hits.map((hit) => hit.text).join("\n---\n");
  if (encoder.encode(rendered).byteLength > maxBytes) {
    return err(loomError("oversized", "projection"));
  }
  const omissions: LoomOmission[] = capped > 0 ? [{ kind: "hits-capped", count: capped }] : [];
  return ok({
    text: rendered,
    offset: hits[0]?.offset ?? 0,
    byteLength: encoder.encode(rendered).byteLength,
    complete: false,
    omissions,
    hits,
  });
}

export function retrieveLoomProjection(
  input: LoomRetrieveInput,
  hasher: ContentHasherPort,
  cache?: LoomCache,
): Result<LoomProjectionResult, LoomError> {
  const id = evidenceId.parse(input.id);
  if (!id.ok) {
    return err(loomError("malformed", "id"));
  }
  const freshness = parseClosedUnion(
    input.freshness ?? "live",
    EVIDENCE_FRESHNESSES,
    "freshness",
    true,
  );
  if (!freshness.ok) {
    return freshness;
  }
  const expectedWorkspace = workspaceId.parse(input.expectedWorkspaceId);
  if (!expectedWorkspace.ok) {
    return err(loomError("malformed", "expectedWorkspaceId"));
  }
  const expectedSession = sessionId.parse(input.expectedSessionId);
  if (!expectedSession.ok) {
    return err(loomError("malformed", "expectedSessionId"));
  }
  if (
    expectedWorkspace.value !== input.manifest.workspaceId ||
    expectedSession.value !== input.manifest.sessionId
  ) {
    return err(loomError("denied", "scope"));
  }
  if (input.manifest.retentionUntil !== null) {
    if (input.now === undefined) {
      return err(loomError("malformed", "now"));
    }
    const now = timestampSchema.safeParse(input.now);
    if (!now.success) {
      return err(loomError("malformed", "now"));
    }
    if (
      timestampToEpochMilliseconds(now.data) >=
      timestampToEpochMilliseconds(input.manifest.retentionUntil)
    ) {
      return err(loomError("expired", "retentionUntil"));
    }
  }
  const destination = parseClosedUnion(
    input.destination ?? "local",
    CONTEXT_BUDGET_DESTINATIONS,
    "destination",
    true,
  );
  if (!destination.ok) {
    return destination;
  }
  const generation = parseKeyField(input.generation, "generation", input.manifest.generation);
  if (!generation.ok) {
    return generation;
  }
  const strategyVersion = parseKeyField(
    input.strategyVersion,
    "strategyVersion",
    DEFAULT_LOOM_STRATEGY,
  );
  if (!strategyVersion.ok) {
    return strategyVersion;
  }
  const configuration = parseKeyField(input.configuration, "configuration", "");
  if (!configuration.ok) {
    return configuration;
  }
  const projection = parseProjection(input.projection);
  if (!projection.ok) {
    return projection;
  }

  const declared = input.manifest.members.find(
    (member) => member.artifactId === projection.value.member,
  );
  if (declared === undefined) {
    return err(loomError("unavailable", "member"));
  }
  if (declared.sensitivity === "restricted") {
    return err(loomError("secret", "sensitivity"));
  }

  const supplied = input.members.find((member) => member.artifactId === declared.artifactId);
  const suppliedBytes = supplied?.bytes ?? null;
  const suppliedAvailability = supplied?.availability ?? declared.availability;
  if (suppliedBytes === null || suppliedAvailability !== "available") {
    return err(loomError("unavailable", "member"));
  }
  if (suppliedBytes.byteLength !== declared.byteLength) {
    return err(loomError("checksum", "byteLength"));
  }
  const computed = hashBytes(hasher, suppliedBytes);
  if (computed !== declared.digest) {
    return err(loomError("checksum", "digest"));
  }

  const liveMembers = input.manifest.members.map((member) => {
    const live = input.members.find((candidate) => candidate.artifactId === member.artifactId);
    if (live === undefined) {
      return member.required ? { ...member, availability: "missing" as const } : member;
    }
    const availability =
      live.bytes === null
        ? "missing"
        : ((live.availability ?? member.availability) as ArtifactAvailability);
    return { ...member, availability };
  });
  const exactRecoverable = groupRecoverable(liveMembers);

  const key: LoomCacheKey = {
    digest: declared.digest,
    generation: generation.value,
    strategyVersion: strategyVersion.value,
    configuration: configuration.value,
    destination: destination.value,
    projection: projection.value.kind,
    member: declared.artifactId,
    boundA: projection.value.boundA,
    boundB: projection.value.boundB,
    maxBytes: projection.value.maxBytes,
    query: projection.value.query,
  };
  const cached = cache?.get(key) ?? null;
  if (cached !== null) {
    return ok({ ...cached, cache: "hit", exactRecoverable, freshness: freshness.value });
  }

  let projected: {
    text: string;
    offset: number;
    byteLength: number;
    complete: boolean;
    omissions: readonly LoomOmission[];
    hits: readonly LoomSearchHit[];
    fidelity: EvidenceFidelity;
  };
  switch (projection.value.kind) {
    case "exact": {
      const result = projectExact(suppliedBytes, projection.value.maxBytes);
      if (!result.ok) {
        return result;
      }
      projected = {
        ...result.value,
        omissions: [],
        hits: [],
        fidelity: "exact-source",
      };
      break;
    }
    case "range": {
      const result = projectRange(
        suppliedBytes,
        projection.value.offset,
        projection.value.length,
        projection.value.maxBytes,
      );
      if (!result.ok) {
        return result;
      }
      projected = {
        ...result.value,
        omissions: [],
        hits: [],
        fidelity: result.value.complete ? "exact-source" : "bounded-excerpt",
      };
      break;
    }
    case "head-tail": {
      const result = projectHeadTail(
        suppliedBytes,
        projection.value.headBytes,
        projection.value.tailBytes,
        projection.value.maxBytes,
      );
      if (!result.ok) {
        return result;
      }
      projected = {
        ...result.value,
        hits: [],
        fidelity: result.value.complete ? "exact-source" : "bounded-excerpt",
      };
      break;
    }
    case "search-hits": {
      const result = projectSearchHits(
        suppliedBytes,
        declared.encoding,
        projection.value.query,
        projection.value.maxHits,
        projection.value.contextBytes,
        projection.value.maxBytes,
      );
      if (!result.ok) {
        return result;
      }
      projected = { ...result.value, fidelity: "deterministic-transform" };
      break;
    }
    default:
      return assertNever(projection.value, "unhandled loom projection");
  }

  const claimsExact = projected.fidelity === "exact-source" && projected.complete;
  const expansion: ExactSourceHandle = {
    kind: "artifact",
    artifactId: declared.artifactId,
    digest: declared.digest,
    byteLength: declared.byteLength,
  };
  const result: LoomProjectionResult = {
    id: id.value,
    manifestId: input.manifest.id,
    fidelity: projected.fidelity,
    freshness: freshness.value,
    text: projected.text,
    projection: projection.value.kind,
    offset: projected.offset,
    byteLength: projected.byteLength,
    sourceBytes: declared.byteLength,
    complete: projected.complete,
    claimsExact,
    cache: "miss",
    exactRecoverable,
    exactSource: claimsExact ? expansion : null,
    expansion,
    handle: {
      manifestId: input.manifest.id,
      artifactId: declared.artifactId,
      digest: declared.digest,
      byteLength: declared.byteLength,
      workspaceId: input.manifest.workspaceId,
      sessionId: input.manifest.sessionId,
    },
    omissions: projected.omissions,
    hits: projected.hits,
    protectedFacts: declared.protectedFacts,
    lineage: [DEFAULT_LOOM_STRATEGY, projection.value.kind],
  };
  cache?.put(key, { ...result, cache: "hit" });
  return ok(result);
}
