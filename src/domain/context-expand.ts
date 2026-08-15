/**
 * Context-engine expansion, cache reuse, invalidation, and exact retrieval
 * (#86).
 *
 * Verifies an exact-source or expansion handle against supplied bytes, then
 * returns the full source or a bounded range. Complete verified retrieval is
 * exact-source; a range is bounded-excerpt and never claims exactness. Stale
 * freshness is preserved. Restricted content is refused and never cached.
 * This gate does not ingest Loom manifests, expand workspace files, or render
 * provider prompts.
 */

import {
  ARTIFACT_AVAILABILITIES,
  ARTIFACT_SENSITIVITIES,
  type ArtifactId,
  artifactId,
  type ContentDigest,
  contentDigest,
} from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import { CONTEXT_BUDGET_DESTINATIONS, type ContextBudgetDestination } from "./context-budget.ts";
import {
  EVIDENCE_FRESHNESSES,
  type EvidenceFidelity,
  type EvidenceFreshness,
  type ExactSourceHandle,
  MAX_EVIDENCE_BATCH,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import { type EvidenceId, evidenceId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEFAULT_CONTEXT_EXPAND_STRATEGY = "expand.v1";
export const DEFAULT_CONTEXT_EXPAND_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const HARD_CONTEXT_EXPAND_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const DEFAULT_CONTEXT_EXPAND_CACHE_ENTRIES = 32;
export const HARD_CONTEXT_EXPAND_CACHE_ENTRIES = MAX_EVIDENCE_BATCH;
export const MAX_CONTEXT_EXPAND_KEY_FIELD = 128;

export type ContextExpandErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "unavailable"
  | "checksum"
  | "secret";

export type ContextExpandError = {
  readonly kind: "context-expand";
  readonly code: ContextExpandErrorCode;
  readonly field: string | null;
};

export type ContextExpandCacheStatus = "hit" | "miss";

export type ContextExpandInlineSource = {
  readonly kind: "inline";
  readonly text: string;
  readonly digest: string;
  readonly byteLength: number;
};

export type ContextExpandArtifactSource = {
  readonly kind: "artifact";
  readonly artifactId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array | null;
  readonly availability?: string;
};

export type ContextExpandSource = ContextExpandInlineSource | ContextExpandArtifactSource;

export type ContextExpandInput = {
  readonly id: string;
  readonly freshness: string;
  readonly sensitivity: string;
  readonly source: ContextExpandSource;
  readonly destination?: string;
  readonly generation?: string;
  readonly strategyVersion?: string;
  readonly configuration?: string;
  readonly offset?: number;
  readonly length?: number;
  readonly maxBytes?: number;
};

export type ContextExpandResult = {
  readonly id: EvidenceId;
  readonly fidelity: EvidenceFidelity;
  readonly freshness: EvidenceFreshness;
  readonly text: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly sourceBytes: number;
  readonly complete: boolean;
  readonly claimsExact: boolean;
  readonly cache: ContextExpandCacheStatus;
  readonly exactSource: ExactSourceHandle;
};

export type ContextExpandCacheKey = {
  readonly digest: ContentDigest;
  readonly generation: string;
  readonly strategyVersion: string;
  readonly configuration: string;
  readonly destination: ContextBudgetDestination;
  readonly offset: number;
  readonly length: number;
  readonly maxBytes: number;
};

export type ContextExpandInvalidation = {
  readonly digest?: ContentDigest;
  readonly generation?: string;
  readonly strategyVersion?: string;
  readonly configuration?: string;
  readonly destination?: ContextBudgetDestination;
  readonly artifactId?: ArtifactId;
  readonly all?: boolean;
};

export type ContextExpandCache = {
  get(key: ContextExpandCacheKey): ContextExpandResult | null;
  put(key: ContextExpandCacheKey, value: ContextExpandResult): void;
  invalidate(filter: ContextExpandInvalidation): number;
  get size(): number;
};

type StoredEntry = {
  readonly key: ContextExpandCacheKey;
  readonly value: ContextExpandResult;
  readonly artifactId: ArtifactId | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function expandError(code: ContextExpandErrorCode, field: string | null): ContextExpandError {
  return { kind: "context-expand", code, field };
}

export function describeContextExpandError(error: ContextExpandError): string {
  const field = error.field === null ? "expansion" : error.field;
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
    default:
      return assertNever(error.code, "unhandled context expand error");
  }
}

function parseClosedUnion<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  unsupported = false,
): Result<T, ContextExpandError> {
  if (typeof value !== "string") {
    return err(expandError("malformed", field));
  }
  if (!(allowed as readonly string[]).includes(value)) {
    return err(expandError(unsupported ? "unsupported" : "malformed", field));
  }
  return ok(value as T);
}

function parseKeyField(
  value: string | undefined,
  field: string,
  fallback: string,
): Result<string, ContextExpandError> {
  const raw = value === undefined ? fallback : value;
  if (raw.includes("\0")) {
    return err(expandError("malformed", field));
  }
  if (raw.length > MAX_CONTEXT_EXPAND_KEY_FIELD) {
    return err(expandError("oversized", field));
  }
  return ok(raw);
}

function parseBound(
  value: number | undefined,
  field: string,
  fallback: number,
  maximum: number,
  minimum = 0,
): Result<number, ContextExpandError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    return err(expandError("malformed", field));
  }
  if (value > maximum) {
    return err(expandError("oversized", field));
  }
  return ok(value);
}

function serializeKey(key: ContextExpandCacheKey): string {
  return [
    key.digest,
    key.generation,
    key.strategyVersion,
    key.configuration,
    key.destination,
    String(key.offset),
    String(key.length),
    String(key.maxBytes),
  ].join("\0");
}

function matchesFilter(entry: StoredEntry, filter: ContextExpandInvalidation): boolean {
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

export function createContextExpandCache(
  maxEntries: number = DEFAULT_CONTEXT_EXPAND_CACHE_ENTRIES,
): ContextExpandCache {
  const limit = Math.min(Math.max(1, maxEntries), HARD_CONTEXT_EXPAND_CACHE_ENTRIES);
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
      entries.set(serialized, {
        key,
        value,
        artifactId: value.exactSource.kind === "artifact" ? value.exactSource.artifactId : null,
      });
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

function resolveBytes(
  source: ContextExpandSource,
): Result<{ bytes: Uint8Array; handle: ExactSourceHandle }, ContextExpandError> {
  switch (source.kind) {
    case "inline": {
      const digest = contentDigest.parse(source.digest);
      if (!digest.ok) {
        return err(expandError("malformed", "digest"));
      }
      if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
        return err(expandError("malformed", "byteLength"));
      }
      const bytes = encoder.encode(source.text);
      if (bytes.byteLength !== source.byteLength) {
        return err(expandError("malformed", "byteLength"));
      }
      return ok({
        bytes,
        handle: { kind: "inline", digest: digest.value, byteLength: source.byteLength },
      });
    }
    case "artifact": {
      const id = artifactId.parse(source.artifactId);
      if (!id.ok) {
        return err(expandError("malformed", "artifactId"));
      }
      const digest = contentDigest.parse(source.digest);
      if (!digest.ok) {
        return err(expandError("malformed", "digest"));
      }
      if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
        return err(expandError("malformed", "byteLength"));
      }
      const availability = parseClosedUnion(
        source.availability ?? "available",
        ARTIFACT_AVAILABILITIES,
        "availability",
        true,
      );
      if (!availability.ok) {
        return availability;
      }
      switch (availability.value) {
        case "available":
          break;
        case "quarantined":
          return err(expandError("checksum", "source"));
        case "reserved":
        case "missing":
          return err(expandError("unavailable", "source"));
        default:
          return assertNever(availability.value, "unhandled artifact availability");
      }
      if (source.bytes === null) {
        return err(expandError("unavailable", "source"));
      }
      if (source.bytes.byteLength !== source.byteLength) {
        return err(expandError("malformed", "byteLength"));
      }
      return ok({
        bytes: source.bytes,
        handle: {
          kind: "artifact",
          artifactId: id.value,
          digest: digest.value,
          byteLength: source.byteLength,
        },
      });
    }
    default:
      return assertNever(source, "unhandled expansion source");
  }
}

export function expandContextEvidence(
  input: ContextExpandInput,
  hasher: ContentHasherPort,
  cache?: ContextExpandCache,
): Result<ContextExpandResult, ContextExpandError> {
  const id = evidenceId.parse(input.id);
  if (!id.ok) {
    return err(expandError("malformed", "id"));
  }
  const freshness = parseClosedUnion(input.freshness, EVIDENCE_FRESHNESSES, "freshness", true);
  if (!freshness.ok) {
    return freshness;
  }
  const sensitivity = parseClosedUnion(
    input.sensitivity,
    ARTIFACT_SENSITIVITIES,
    "sensitivity",
    true,
  );
  if (!sensitivity.ok) {
    return sensitivity;
  }
  if (sensitivity.value === "restricted") {
    return err(expandError("secret", "sensitivity"));
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
  const generation = parseKeyField(input.generation, "generation", "");
  if (!generation.ok) {
    return generation;
  }
  const strategyVersion = parseKeyField(
    input.strategyVersion,
    "strategyVersion",
    DEFAULT_CONTEXT_EXPAND_STRATEGY,
  );
  if (!strategyVersion.ok) {
    return strategyVersion;
  }
  const configuration = parseKeyField(input.configuration, "configuration", "");
  if (!configuration.ok) {
    return configuration;
  }
  const maxBytes = parseBound(
    input.maxBytes,
    "maxBytes",
    DEFAULT_CONTEXT_EXPAND_MAX_BYTES,
    HARD_CONTEXT_EXPAND_MAX_BYTES,
    1,
  );
  if (!maxBytes.ok) {
    return maxBytes;
  }

  const resolved = resolveBytes(input.source);
  if (!resolved.ok) {
    return resolved;
  }
  const computed = hashBytes(hasher, resolved.value.bytes);
  if (computed !== resolved.value.handle.digest) {
    return err(expandError("checksum", "digest"));
  }

  const offset = parseBound(input.offset, "offset", 0, resolved.value.bytes.byteLength);
  if (!offset.ok) {
    return offset;
  }
  const remaining = resolved.value.bytes.byteLength - offset.value;
  const requestedLength =
    input.length === undefined ? Math.min(remaining, maxBytes.value) : input.length;
  const length = parseBound(input.length, "length", requestedLength, remaining);
  if (!length.ok) {
    return length;
  }
  if (input.length === undefined && remaining > maxBytes.value) {
    return err(expandError("oversized", "source"));
  }
  if (length.value > maxBytes.value) {
    return err(expandError("oversized", "length"));
  }

  const key: ContextExpandCacheKey = {
    digest: resolved.value.handle.digest,
    generation: generation.value,
    strategyVersion: strategyVersion.value,
    configuration: configuration.value,
    destination: destination.value,
    offset: offset.value,
    length: length.value,
    maxBytes: maxBytes.value,
  };
  const cached = cache?.get(key) ?? null;
  if (cached !== null) {
    return ok({ ...cached, cache: "hit" });
  }

  const sliced = sliceUtf8(resolved.value.bytes, offset.value, length.value);
  const complete = offset.value === 0 && sliced.byteLength === resolved.value.bytes.byteLength;
  const fidelity: EvidenceFidelity = complete ? "exact-source" : "bounded-excerpt";
  const result: ContextExpandResult = {
    id: id.value,
    fidelity,
    freshness: freshness.value,
    text: decoder.decode(sliced),
    offset: offset.value,
    byteLength: sliced.byteLength,
    sourceBytes: resolved.value.bytes.byteLength,
    complete,
    claimsExact: complete,
    cache: "miss",
    exactSource: resolved.value.handle,
  };
  cache?.put(key, { ...result, cache: "hit" });
  return ok(result);
}
