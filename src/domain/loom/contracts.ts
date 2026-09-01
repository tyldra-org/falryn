/** Stable Loom manifests, projection requests, recovery handles, and cache contracts. */

import type {
  ArtifactAvailability,
  ArtifactEncoding,
  ArtifactId,
  ArtifactSensitivity,
  ContentDigest,
} from "../artifact.ts";
import type { ContextBudgetDestination } from "../context-budget.ts";
import {
  type EvidenceFidelity,
  type EvidenceFreshness,
  type ExactSourceHandle,
  MAX_EVIDENCE_INLINE_BYTES,
} from "../context-evidence.ts";
import type { EvidenceId, LoomManifestId, SessionId, WorkspaceId } from "../identity.ts";
import type { Timestamp } from "../time.ts";
import { DEFAULT_LOOM_CACHE_ENTRIES, HARD_LOOM_CACHE_ENTRIES } from "./cache.ts";

export const DEFAULT_LOOM_STRATEGY = "loom.v1";
export const DEFAULT_LOOM_PROJECTION_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const HARD_LOOM_PROJECTION_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export { DEFAULT_LOOM_CACHE_ENTRIES, HARD_LOOM_CACHE_ENTRIES };
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
  readonly bytes?: Uint8Array | null;
  readonly availability?: string;
  readonly digest?: string;
  readonly byteLength?: number;
};

export type LoomArtifactReadPlan =
  | {
      readonly kind: "complete";
      readonly artifactId: ArtifactId;
      readonly offset: 0;
      readonly length: number;
    }
  | {
      readonly kind: "range";
      readonly artifactId: ArtifactId;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "head-tail";
      readonly artifactId: ArtifactId;
      readonly headOffset: 0;
      readonly headLength: number;
      readonly tailOffset: number;
      readonly tailLength: number;
    };

export type LoomProjectionSource =
  | {
      readonly kind: "complete";
      readonly artifactId: ArtifactId;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "range";
      readonly artifactId: ArtifactId;
      readonly offset: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "head-tail";
      readonly artifactId: ArtifactId;
      readonly headOffset: 0;
      readonly headBytes: Uint8Array;
      readonly tailOffset: number;
      readonly tailBytes: Uint8Array;
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
