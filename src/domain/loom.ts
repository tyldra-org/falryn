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
  type ArtifactId,
  artifactId,
  contentDigest,
  MAX_ARTIFACT_BYTES,
  MAX_MEDIA_TYPE_LENGTH,
} from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import { brandedString, timestampSchema } from "./branded-schema.ts";
import { CONTEXT_BUDGET_DESTINATIONS } from "./context-budget.ts";
import {
  EVIDENCE_FRESHNESSES,
  type EvidenceFidelity,
  type EvidenceFreshness,
  type ExactSourceHandle,
} from "./context-evidence.ts";
import { type EvidenceId, evidenceId, loomManifestId, sessionId, workspaceId } from "./identity.ts";
import { createLoomCacheStore, DEFAULT_LOOM_CACHE_ENTRIES } from "./loom/cache.ts";
import {
  DEFAULT_LOOM_HEAD_BYTES,
  DEFAULT_LOOM_PROJECTION_MAX_BYTES,
  DEFAULT_LOOM_SEARCH_CONTEXT_BYTES,
  DEFAULT_LOOM_SEARCH_HITS,
  DEFAULT_LOOM_STRATEGY,
  DEFAULT_LOOM_TAIL_BYTES,
  HARD_LOOM_PROJECTION_MAX_BYTES,
  HARD_LOOM_SEARCH_HITS,
  LOOM_UNSUPPORTED_PROJECTION_KINDS,
  type LoomArtifactReadPlan,
  type LoomCache,
  type LoomCacheKey,
  type LoomCommitInput,
  type LoomError,
  type LoomErrorCode,
  type LoomManifest,
  type LoomMember,
  type LoomMemberBytes,
  type LoomOmission,
  type LoomProjectionResult,
  type LoomProjectionSource,
  type LoomRetrieveInput,
  type LoomSearchHit,
  MAX_LOOM_KEY_FIELD,
  MAX_LOOM_MEMBERS,
  MAX_LOOM_PROTECTED_FACT_BYTES,
  MAX_LOOM_PROTECTED_FACTS,
  MAX_LOOM_QUERY_BYTES,
  MAX_LOOM_SUMMARY_BYTES,
} from "./loom/contracts.ts";
import {
  hashLoomBytes,
  loomGroupRecoverable,
  projectLoomExact,
  projectLoomHeadTail,
  projectLoomHeadTailWindows,
  projectLoomRange,
  projectLoomRangeWindow,
  projectLoomSearchHits,
} from "./loom/projections.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import { timestampToEpochMilliseconds } from "./time.ts";

export * from "./loom/contracts.ts";

export function createLoomCache(maxEntries = DEFAULT_LOOM_CACHE_ENTRIES): LoomCache {
  return createLoomCacheStore<LoomCacheKey, LoomProjectionResult>(maxEntries);
}

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
    exactRecoverable: loomGroupRecoverable(members),
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

export type LoomRetrievalPlan = {
  readonly input: LoomRetrieveInput;
  readonly id: EvidenceId;
  readonly freshness: EvidenceFreshness;
  readonly projection: ParsedProjection;
  readonly declared: LoomMember;
  readonly key: LoomCacheKey;
  readonly read: LoomArtifactReadPlan;
  readonly exactRecoverable: boolean;
  readonly metadataVerified: boolean;
  readonly cached: LoomProjectionResult | null;
};

function planArtifactRead(
  projection: ParsedProjection,
  sourceByteLength: number,
): Result<LoomArtifactReadPlan, LoomError> {
  switch (projection.kind) {
    case "exact":
      if (sourceByteLength > projection.maxBytes) {
        return err(loomError("oversized", "source"));
      }
      return ok({
        kind: "complete",
        artifactId: projection.member,
        offset: 0,
        length: sourceByteLength,
      });
    case "range": {
      const offset = projection.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > sourceByteLength) {
        return err(loomError("malformed", "offset"));
      }
      const remaining = sourceByteLength - offset;
      const requested = projection.length ?? Math.min(remaining, projection.maxBytes);
      if (!Number.isSafeInteger(requested) || requested < 0) {
        return err(loomError("malformed", "length"));
      }
      if (requested > remaining) {
        return err(loomError("oversized", "length"));
      }
      if (projection.length === undefined && remaining > projection.maxBytes) {
        return err(loomError("oversized", "source"));
      }
      if (requested > projection.maxBytes) {
        return err(loomError("oversized", "length"));
      }
      return offset === 0 && requested === sourceByteLength
        ? ok({
            kind: "complete",
            artifactId: projection.member,
            offset: 0,
            length: sourceByteLength,
          })
        : ok({ kind: "range", artifactId: projection.member, offset, length: requested });
    }
    case "head-tail":
      if (projection.headBytes + projection.tailBytes > projection.maxBytes) {
        return err(loomError("oversized", "projection"));
      }
      if (sourceByteLength <= projection.headBytes + projection.tailBytes) {
        return ok({
          kind: "complete",
          artifactId: projection.member,
          offset: 0,
          length: sourceByteLength,
        });
      }
      return ok({
        kind: "head-tail",
        artifactId: projection.member,
        headOffset: 0,
        headLength: projection.headBytes,
        tailOffset: sourceByteLength - projection.tailBytes,
        tailLength: projection.tailBytes,
      });
    case "search-hits":
      return ok({
        kind: "complete",
        artifactId: projection.member,
        offset: 0,
        length: sourceByteLength,
      });
    default:
      return assertNever(projection, "unhandled loom projection");
  }
}

function memberIsRecoverable(member: LoomMember, live: LoomMemberBytes | undefined): boolean {
  if (live === undefined || live.bytes === null) {
    return !member.required;
  }
  if ((live.availability ?? member.availability) !== "available") {
    return !member.required;
  }
  if (live.digest !== undefined && live.digest !== member.digest) {
    return !member.required;
  }
  if (live.byteLength !== undefined && live.byteLength !== member.byteLength) {
    return !member.required;
  }
  return true;
}

export function planLoomRetrieval(
  input: LoomRetrieveInput,
  cache?: LoomCache,
): Result<LoomRetrievalPlan, LoomError> {
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
  const suppliedAvailability = supplied?.availability ?? declared.availability;
  if (supplied === undefined || supplied.bytes === null || suppliedAvailability !== "available") {
    return err(loomError("unavailable", "member"));
  }
  if (supplied.byteLength !== undefined && supplied.byteLength !== declared.byteLength) {
    return err(loomError("checksum", "byteLength"));
  }
  if (supplied.digest !== undefined && supplied.digest !== declared.digest) {
    return err(loomError("checksum", "digest"));
  }

  const exactRecoverable = input.manifest.members.every((member) =>
    memberIsRecoverable(
      member,
      input.members.find((candidate) => candidate.artifactId === member.artifactId),
    ),
  );

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
  const read = planArtifactRead(projection.value, declared.byteLength);
  if (!read.ok) {
    return read;
  }
  const cached = cache?.get(key) ?? null;
  return ok({
    input,
    id: id.value,
    freshness: freshness.value,
    projection: projection.value,
    declared,
    key,
    read: read.value,
    exactRecoverable,
    metadataVerified: supplied.digest !== undefined && supplied.byteLength !== undefined,
    cached:
      cached === null
        ? null
        : { ...cached, cache: "hit", exactRecoverable, freshness: freshness.value },
  });
}

function validateProjectionSource(
  plan: LoomRetrievalPlan,
  source: LoomProjectionSource,
  hasher: ContentHasherPort,
): Result<void, LoomError> {
  if (source.artifactId !== plan.declared.artifactId) {
    return err(loomError("checksum", "artifactId"));
  }
  if (source.kind === "complete") {
    if (source.bytes.byteLength !== plan.declared.byteLength) {
      return err(loomError("checksum", "byteLength"));
    }
    if (hashLoomBytes(hasher, source.bytes) !== plan.declared.digest) {
      return err(loomError("checksum", "digest"));
    }
    return ok(undefined);
  }
  if (!plan.metadataVerified || source.kind !== plan.read.kind) {
    return err(loomError("checksum", "source"));
  }
  if (source.kind === "range" && plan.read.kind === "range") {
    if (source.offset !== plan.read.offset || source.bytes.byteLength !== plan.read.length) {
      return err(loomError("checksum", "range"));
    }
    return ok(undefined);
  }
  if (source.kind === "head-tail" && plan.read.kind === "head-tail") {
    if (
      source.headOffset !== plan.read.headOffset ||
      source.headBytes.byteLength !== plan.read.headLength ||
      source.tailOffset !== plan.read.tailOffset ||
      source.tailBytes.byteLength !== plan.read.tailLength
    ) {
      return err(loomError("checksum", "range"));
    }
    return ok(undefined);
  }
  return err(loomError("checksum", "source"));
}

export function completeLoomRetrieval(
  plan: LoomRetrievalPlan,
  source: LoomProjectionSource,
  hasher: ContentHasherPort,
  cache?: LoomCache,
): Result<LoomProjectionResult, LoomError> {
  const verified = validateProjectionSource(plan, source, hasher);
  if (!verified.ok) {
    return verified;
  }
  if (plan.cached !== null) {
    return ok(plan.cached);
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
  switch (plan.projection.kind) {
    case "exact": {
      if (source.kind !== "complete") {
        return err(loomError("checksum", "source"));
      }
      const result = projectLoomExact(source.bytes, plan.projection.maxBytes);
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
      const result =
        source.kind === "complete"
          ? projectLoomRange(
              source.bytes,
              plan.projection.offset,
              plan.projection.length,
              plan.projection.maxBytes,
            )
          : source.kind === "range"
            ? ok(projectLoomRangeWindow(source.bytes, source.offset, plan.declared.byteLength))
            : err(loomError("checksum", "source"));
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
      const result =
        source.kind === "complete"
          ? projectLoomHeadTail(
              source.bytes,
              plan.projection.headBytes,
              plan.projection.tailBytes,
              plan.projection.maxBytes,
            )
          : source.kind === "head-tail"
            ? ok(
                projectLoomHeadTailWindows(
                  source.headBytes,
                  source.tailBytes,
                  plan.declared.byteLength,
                ),
              )
            : err(loomError("checksum", "source"));
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
      if (source.kind !== "complete") {
        return err(loomError("checksum", "source"));
      }
      const result = projectLoomSearchHits(
        source.bytes,
        plan.declared.encoding,
        plan.projection.query,
        plan.projection.maxHits,
        plan.projection.contextBytes,
        plan.projection.maxBytes,
      );
      if (!result.ok) {
        return result;
      }
      projected = { ...result.value, fidelity: "deterministic-transform" };
      break;
    }
    default:
      return assertNever(plan.projection, "unhandled loom projection");
  }

  const claimsExact = projected.fidelity === "exact-source" && projected.complete;
  const expansion: ExactSourceHandle = {
    kind: "artifact",
    artifactId: plan.declared.artifactId,
    digest: plan.declared.digest,
    byteLength: plan.declared.byteLength,
  };
  const result: LoomProjectionResult = {
    id: plan.id,
    manifestId: plan.input.manifest.id,
    fidelity: projected.fidelity,
    freshness: plan.freshness,
    text: projected.text,
    projection: plan.projection.kind,
    offset: projected.offset,
    byteLength: projected.byteLength,
    sourceBytes: plan.declared.byteLength,
    complete: projected.complete,
    claimsExact,
    cache: "miss",
    exactRecoverable: plan.exactRecoverable,
    exactSource: claimsExact ? expansion : null,
    expansion,
    handle: {
      manifestId: plan.input.manifest.id,
      artifactId: plan.declared.artifactId,
      digest: plan.declared.digest,
      byteLength: plan.declared.byteLength,
      workspaceId: plan.input.manifest.workspaceId,
      sessionId: plan.input.manifest.sessionId,
    },
    omissions: projected.omissions,
    hits: projected.hits,
    protectedFacts: plan.declared.protectedFacts,
    lineage: [DEFAULT_LOOM_STRATEGY, plan.projection.kind],
  };
  cache?.put(plan.key, { ...result, cache: "hit" });
  return ok(result);
}

export function retrieveLoomProjection(
  input: LoomRetrieveInput,
  hasher: ContentHasherPort,
  cache?: LoomCache,
): Result<LoomProjectionResult, LoomError> {
  const plan = planLoomRetrieval(input, cache);
  if (!plan.ok) {
    return plan;
  }
  const supplied = input.members.find(
    (member) => member.artifactId === plan.value.declared.artifactId,
  );
  if (supplied?.bytes === undefined || supplied.bytes === null) {
    return err(loomError("unavailable", "member"));
  }
  return completeLoomRetrieval(
    plan.value,
    {
      kind: "complete",
      artifactId: plan.value.declared.artifactId,
      bytes: supplied.bytes,
    },
    hasher,
    cache,
  );
}
