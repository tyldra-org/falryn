/** Bounded LRU projection cache and invalidation policy for Loom. */

import type { ArtifactId, ContentDigest } from "../artifact.ts";
import type { ContextBudgetDestination } from "../context-budget.ts";
import { MAX_EVIDENCE_BATCH } from "../context-evidence.ts";

export const DEFAULT_LOOM_CACHE_ENTRIES = 32;
export const HARD_LOOM_CACHE_ENTRIES = MAX_EVIDENCE_BATCH;

export type LoomCacheKeyShape = {
  readonly digest: ContentDigest;
  readonly generation: string;
  readonly strategyVersion: string;
  readonly configuration: string;
  readonly destination: ContextBudgetDestination;
  readonly projection: string;
  readonly member: ArtifactId;
  readonly boundA: number;
  readonly boundB: number;
  readonly maxBytes: number;
  readonly query: string;
};

export type LoomInvalidationShape = {
  readonly digest?: ContentDigest;
  readonly generation?: string;
  readonly strategyVersion?: string;
  readonly configuration?: string;
  readonly destination?: ContextBudgetDestination;
  readonly artifactId?: ArtifactId;
  readonly all?: boolean;
};

export type ProjectionCache<Key extends LoomCacheKeyShape, Value> = {
  get(key: Key): Value | null;
  put(key: Key, value: Value): void;
  invalidate(filter: LoomInvalidationShape): number;
  get size(): number;
};

type StoredEntry<Key, Value> = {
  readonly key: Key;
  readonly value: Value;
  readonly artifactId: ArtifactId;
};

export function createLoomCacheStore<Key extends LoomCacheKeyShape, Value>(
  maxEntries: number = DEFAULT_LOOM_CACHE_ENTRIES,
): ProjectionCache<Key, Value> {
  const limit = Math.min(Math.max(1, maxEntries), HARD_LOOM_CACHE_ENTRIES);
  const entries = new Map<string, StoredEntry<Key, Value>>();

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

function serializeKey(key: LoomCacheKeyShape): string {
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

function matchesFilter<Key extends LoomCacheKeyShape, Value>(
  entry: StoredEntry<Key, Value>,
  filter: LoomInvalidationShape,
): boolean {
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
  return filter.artifactId !== undefined && entry.artifactId === filter.artifactId;
}
