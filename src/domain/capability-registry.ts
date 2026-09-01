/**
 * Immutable discovery catalog shared by every Falryn capability primitive.
 *
 * This registry answers what exists and what may be selected. Execution stays
 * with the primitive-specific runtime (tool runner, skill loader, hook host,
 * workflow engine, provider adapter, and so on). Keeping those concerns apart
 * prevents a discoverable contribution from becoming executable by accident.
 */

import { z } from "zod";

import { toCodecIssues } from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import type { CapabilityId, ConfigurationGeneration } from "./identity.ts";
import { capabilityId } from "./identity.ts";
import { MAX_IDENTIFIER_LENGTH } from "./limits.ts";
import { err, ok, type Result } from "./result.ts";
import { EFFECT_CLASSES, type EffectClass } from "./work.ts";

export const CAPABILITY_REGISTRY_SCHEMA_VERSION = 1;
export const DEFAULT_CAPABILITY_QUERY_LIMIT = 32;
export const MAX_CAPABILITY_QUERY_LIMIT = 256;
export const MAX_CAPABILITY_SUMMARY_BYTES = 2 * 1024;
export const MAX_CAPABILITY_DEPENDENCIES = 64;
export const MAX_CAPABILITY_REASON_LENGTH = 256;
export const MAX_CAPABILITY_QUERY_TEXT_LENGTH = 256;

export const CAPABILITY_FAMILIES = [
  "search",
  "read",
  "edit",
  "run",
  "browser",
  "computer",
  "delegate",
  "capability",
] as const;

export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];

export const CAPABILITY_CONTRIBUTION_KINDS = [
  "tool",
  "mcp-tool",
  "mcp-resource",
  "mcp-prompt",
  "skill",
  "hook",
  "plugin",
  "command",
  "agent",
  "subagent",
  "workflow",
  "provider",
  "ui",
] as const;

export type CapabilityContributionKind = (typeof CAPABILITY_CONTRIBUTION_KINDS)[number];

export const CAPABILITY_SOURCES = [
  "builtin",
  "integration",
  "mcp",
  "skill",
  "plugin",
  "workflow",
  "provider",
  "marketplace",
  "workspace",
  "user",
] as const;

export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export const CAPABILITY_AVAILABILITIES = [
  "available",
  "degraded",
  "unavailable",
  "unknown",
] as const;

export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITIES)[number];

export const CAPABILITY_HEALTH_STATES = ["healthy", "degraded", "unavailable", "unknown"] as const;
export type CapabilityHealthState = (typeof CAPABILITY_HEALTH_STATES)[number];

export const CAPABILITY_COST_CLASSES = ["none", "low", "medium", "high", "unknown"] as const;
export type CapabilityCostClass = (typeof CAPABILITY_COST_CLASSES)[number];

export const CAPABILITY_LATENCY_CLASSES = [
  "instant",
  "interactive",
  "background",
  "unknown",
] as const;
export type CapabilityLatencyClass = (typeof CAPABILITY_LATENCY_CLASSES)[number];

export type CapabilityIdentity = {
  readonly kind: CapabilityContributionKind;
  readonly source: CapabilitySource;
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
};

export type CapabilityProvenance = {
  /** Stable source/package/server/profile identity. Never a credential or URL with credentials. */
  readonly sourceId: string;
  readonly sourceVersion: string | null;
};

export type CapabilityCompatibility = {
  readonly os: readonly ("darwin" | "linux" | "win32")[];
  readonly arch: readonly ("arm64" | "x64")[];
  /** Stable capability IDs or external dependency names required for availability. */
  readonly dependencies: readonly string[];
};

export type CapabilityLimits = {
  readonly maxInputBytes: number | null;
  readonly maxOutputBytes: number | null;
  readonly defaultTimeoutMs: number | null;
  readonly maxConcurrency: number | null;
};

export type CapabilityRoutingMetadata = {
  readonly costClass: CapabilityCostClass;
  readonly latencyClass: CapabilityLatencyClass;
};

export type CapabilityOperationalState = {
  readonly installed: boolean;
  readonly configured: boolean;
  readonly allowed: boolean;
  readonly selected: boolean;
  readonly active: boolean;
  readonly denied: boolean;
  readonly incompatible: boolean;
  readonly quarantined: boolean;
  readonly deferred: boolean;
  readonly omitted: boolean;
};

export type CapabilityRuntimeState = {
  readonly availability: CapabilityAvailability;
  readonly availabilityReason: string | null;
  readonly health: CapabilityHealthState;
  readonly healthReason: string | null;
  /** True only when the owning runtime has a live execution binding. */
  readonly executable: boolean;
  readonly executionReason: string | null;
  readonly operational: CapabilityOperationalState;
};

export type CapabilitySchemaSummary = {
  readonly inputDigest: string | null;
  readonly outputDigest: string | null;
};

export type CapabilityRegistryDocument = {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
  readonly source: CapabilitySource;
  readonly kind: CapabilityContributionKind;
  readonly title: string;
  /** Compact model- and human-facing purpose, not an implementation body. */
  readonly summary: string;
  readonly family: CapabilityFamily | null;
  readonly effect: EffectClass;
  readonly provenance: CapabilityProvenance;
  readonly compatibility: CapabilityCompatibility;
  readonly limits: CapabilityLimits;
  readonly routing: CapabilityRoutingMetadata;
  readonly state: CapabilityRuntimeState;
  readonly schemas: CapabilitySchemaSummary;
};

export type CapabilityRegistryEntry = CapabilityRegistryDocument & {
  readonly identity: CapabilityIdentity;
  readonly capabilityId: CapabilityId;
  /** Collision key excludes source and version: only one active owner may publish it. */
  readonly registryKey: string;
};

export type CapabilityRegistryEntryOptions = {
  /**
   * Adopt an already-published canonical identity, such as a ToolRegistry ID.
   * The caller is a trusted adapter; untrusted documents cannot supply it.
   */
  readonly capabilityId?: CapabilityId;
};

export type CapabilityLifecycle = {
  readonly registered: true;
  readonly available: boolean;
  readonly disclosed: boolean;
  readonly executable: boolean;
  readonly projected: boolean;
  readonly availability: CapabilityAvailability;
  readonly health: CapabilityHealthState;
  readonly reasons: readonly string[];
};

export type CapabilityCard = {
  readonly capabilityId: CapabilityId;
  readonly title: string;
  readonly summary: string;
  readonly kind: CapabilityContributionKind;
  readonly family: CapabilityFamily | null;
  readonly effect: EffectClass;
  readonly source: CapabilitySource;
  readonly sourceId: string;
  readonly version: number;
  readonly costClass: CapabilityCostClass;
  readonly latencyClass: CapabilityLatencyClass;
  readonly lifecycle: CapabilityLifecycle;
};

export type CapabilityRegistry = {
  readonly schemaVersion: typeof CAPABILITY_REGISTRY_SCHEMA_VERSION;
  readonly generation: ConfigurationGeneration;
  readonly entries: readonly CapabilityRegistryEntry[];
  resolveById(id: CapabilityId): CapabilityRegistryEntry | null;
  resolveByKey(key: string): CapabilityRegistryEntry | null;
};

export type CapabilityRegistryError =
  | { readonly code: "invalid-document"; readonly issues: readonly CodecIssue[] }
  | { readonly code: "invalid-identity"; readonly reason: string }
  | { readonly code: "duplicate-capability-id"; readonly capabilityId: CapabilityId }
  | { readonly code: "namespace-collision"; readonly registryKey: string }
  | { readonly code: "invalid-query-limit"; readonly maximum: number }
  | { readonly code: "invalid-query-offset" }
  | { readonly code: "invalid-query-text"; readonly maximum: number }
  | {
      readonly code: "stale-generation";
      readonly expected: ConfigurationGeneration;
      readonly actual: ConfigurationGeneration;
    };

export type CapabilityRegistryQuery = {
  readonly generation?: ConfigurationGeneration;
  readonly text?: string;
  readonly families?: readonly CapabilityFamily[];
  readonly kinds?: readonly CapabilityContributionKind[];
  readonly sources?: readonly CapabilitySource[];
  readonly availabilities?: readonly CapabilityAvailability[];
  readonly executable?: boolean;
  readonly offset?: number;
  readonly limit?: number;
};

export type CapabilityRegistryQueryResult = {
  readonly generation: ConfigurationGeneration;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly entries: readonly CapabilityRegistryEntry[];
};

const legalSegment = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const safeOpaqueId = /^[!-~]+$/;
const encoder = new TextEncoder();

const optionalPositiveInteger = z.int().min(1).max(Number.MAX_SAFE_INTEGER).nullable();
const digestSchema = z
  .string()
  .regex(/^sha-256:[0-9a-f]{64}$/u)
  .nullable();
const operationalSchema: z.ZodType<CapabilityOperationalState> = z
  .object({
    installed: z.boolean(),
    configured: z.boolean(),
    allowed: z.boolean(),
    selected: z.boolean(),
    active: z.boolean(),
    denied: z.boolean(),
    incompatible: z.boolean(),
    quarantined: z.boolean(),
    deferred: z.boolean(),
    omitted: z.boolean(),
  })
  .strict();

const documentSchema: z.ZodType<CapabilityRegistryDocument> = z
  .object({
    namespace: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    name: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    version: z.int().min(1),
    source: z.enum(CAPABILITY_SOURCES),
    kind: z.enum(CAPABILITY_CONTRIBUTION_KINDS),
    title: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    summary: z.string().max(MAX_CAPABILITY_SUMMARY_BYTES),
    family: z.enum(CAPABILITY_FAMILIES).nullable(),
    effect: z.enum(EFFECT_CLASSES),
    provenance: z
      .object({
        sourceId: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
        sourceVersion: z.string().min(1).max(MAX_IDENTIFIER_LENGTH).nullable(),
      })
      .strict(),
    compatibility: z
      .object({
        os: z.array(z.enum(["darwin", "linux", "win32"])).max(3),
        arch: z.array(z.enum(["arm64", "x64"])).max(2),
        dependencies: z
          .array(z.string().min(1).max(MAX_IDENTIFIER_LENGTH))
          .max(MAX_CAPABILITY_DEPENDENCIES),
      })
      .strict(),
    limits: z
      .object({
        maxInputBytes: optionalPositiveInteger,
        maxOutputBytes: optionalPositiveInteger,
        defaultTimeoutMs: optionalPositiveInteger,
        maxConcurrency: optionalPositiveInteger,
      })
      .strict(),
    routing: z
      .object({
        costClass: z.enum(CAPABILITY_COST_CLASSES),
        latencyClass: z.enum(CAPABILITY_LATENCY_CLASSES),
      })
      .strict(),
    state: z
      .object({
        availability: z.enum(CAPABILITY_AVAILABILITIES),
        availabilityReason: z.string().max(MAX_CAPABILITY_REASON_LENGTH).nullable(),
        health: z.enum(CAPABILITY_HEALTH_STATES),
        healthReason: z.string().max(MAX_CAPABILITY_REASON_LENGTH).nullable(),
        executable: z.boolean(),
        executionReason: z.string().max(MAX_CAPABILITY_REASON_LENGTH).nullable(),
        operational: operationalSchema,
      })
      .strict(),
    schemas: z
      .object({
        inputDigest: digestSchema,
        outputDigest: digestSchema,
      })
      .strict(),
  })
  .strict();

function validateIdentity(identity: CapabilityIdentity): string | null {
  if (!legalSegment.test(identity.namespace)) return "invalid-namespace";
  if (!legalSegment.test(identity.name)) return "invalid-name";
  if (!Number.isInteger(identity.version) || identity.version < 1) return "invalid-version";
  return null;
}

export function capabilityRegistryKey(identity: CapabilityIdentity): string {
  return `${identity.kind}:${identity.namespace}/${identity.name}`;
}

export function encodeCapabilityIdentity(
  identity: CapabilityIdentity,
): Result<CapabilityId, CapabilityRegistryError> {
  const invalid = validateIdentity(identity);
  if (invalid !== null) return err({ code: "invalid-identity", reason: invalid });
  const parsed = capabilityId.parse(
    `${identity.source}:${identity.kind}:${identity.namespace}/${identity.name}@${identity.version}`,
  );
  return parsed.ok
    ? ok(parsed.value)
    : err({ code: "invalid-identity", reason: parsed.error.code });
}

/** Parse an untrusted contribution document without retaining rejected values. */
export function parseCapabilityRegistryDocument(
  value: unknown,
): Result<CapabilityRegistryDocument, readonly CodecIssue[]> {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) return err(toCodecIssues(parsed.error));
  const document = parsed.data;
  if (encoder.encode(document.summary).byteLength > MAX_CAPABILITY_SUMMARY_BYTES) {
    return err([{ path: "summary", code: "too-big" }]);
  }
  if (!safeOpaqueId.test(document.provenance.sourceId)) {
    return err([{ path: "provenance.sourceId", code: "invalid-format" }]);
  }
  const invalid = validateIdentity(document);
  if (invalid !== null) return err([{ path: "identity", code: invalid }]);
  if (
    document.state.executable &&
    document.state.availability !== "available" &&
    document.state.availability !== "degraded"
  ) {
    return err([{ path: "state.executable", code: "contradictory-state" }]);
  }
  if (document.state.operational.denied && document.state.operational.allowed) {
    return err([{ path: "state.operational.allowed", code: "contradictory-state" }]);
  }
  if (document.state.operational.quarantined && document.state.executable) {
    return err([{ path: "state.executable", code: "quarantined" }]);
  }
  return ok(document);
}

export function createCapabilityRegistryEntry(
  document: CapabilityRegistryDocument,
  options: CapabilityRegistryEntryOptions = {},
): Result<CapabilityRegistryEntry, CapabilityRegistryError> {
  const parsed = parseCapabilityRegistryDocument(document);
  if (!parsed.ok) return err({ code: "invalid-document", issues: parsed.error });
  const identity: CapabilityIdentity = {
    kind: parsed.value.kind,
    source: parsed.value.source,
    namespace: parsed.value.namespace,
    name: parsed.value.name,
    version: parsed.value.version,
  };
  const encoded =
    options.capabilityId === undefined
      ? encodeCapabilityIdentity(identity)
      : capabilityId.parse(String(options.capabilityId));
  if (!encoded.ok) {
    return err({ code: "invalid-identity", reason: encoded.error.code });
  }
  return ok({
    ...parsed.value,
    identity,
    capabilityId: encoded.value,
    registryKey: capabilityRegistryKey(identity),
  });
}

/**
 * Build one immutable generation. Installed inventory is intentionally not
 * count-capped; bounded queries and projections control consumer cost.
 */
export function createCapabilityRegistry(
  generation: ConfigurationGeneration,
  entries: readonly CapabilityRegistryEntry[],
): Result<CapabilityRegistry, CapabilityRegistryError> {
  const byId = new Map<CapabilityId, CapabilityRegistryEntry>();
  const byKey = new Map<string, CapabilityRegistryEntry>();
  const ordered = [...entries].sort((left, right) =>
    String(left.capabilityId).localeCompare(String(right.capabilityId)),
  );
  for (const entry of ordered) {
    if (byId.has(entry.capabilityId)) {
      return err({ code: "duplicate-capability-id", capabilityId: entry.capabilityId });
    }
    if (byKey.has(entry.registryKey)) {
      return err({ code: "namespace-collision", registryKey: entry.registryKey });
    }
    byId.set(entry.capabilityId, entry);
    byKey.set(entry.registryKey, entry);
  }
  const frozen = Object.freeze(ordered) as readonly CapabilityRegistryEntry[];
  return ok({
    schemaVersion: CAPABILITY_REGISTRY_SCHEMA_VERSION,
    generation,
    entries: frozen,
    resolveById(id) {
      return byId.get(id) ?? null;
    },
    resolveByKey(key) {
      return byKey.get(key) ?? null;
    },
  });
}

export function capabilityLifecycle(
  entry: CapabilityRegistryEntry,
  observation: { readonly disclosed?: boolean; readonly projected?: boolean } = {},
): CapabilityLifecycle {
  const reasons = [
    entry.state.availabilityReason,
    entry.state.healthReason,
    entry.state.executionReason,
  ].filter((reason): reason is string => reason !== null);
  return {
    registered: true,
    available: entry.state.availability === "available" || entry.state.availability === "degraded",
    disclosed: observation.disclosed ?? false,
    executable: entry.state.executable,
    projected: observation.projected ?? false,
    availability: entry.state.availability,
    health: entry.state.health,
    reasons,
  };
}

export function capabilityCard(
  entry: CapabilityRegistryEntry,
  observation: { readonly disclosed?: boolean; readonly projected?: boolean } = {},
): CapabilityCard {
  return {
    capabilityId: entry.capabilityId,
    title: entry.title,
    summary: entry.summary,
    kind: entry.kind,
    family: entry.family,
    effect: entry.effect,
    source: entry.source,
    sourceId: entry.provenance.sourceId,
    version: entry.version,
    costClass: entry.routing.costClass,
    latencyClass: entry.routing.latencyClass,
    lifecycle: capabilityLifecycle(entry, observation),
  };
}

export function queryCapabilityRegistry(
  registry: CapabilityRegistry,
  query: CapabilityRegistryQuery = {},
): Result<CapabilityRegistryQueryResult, CapabilityRegistryError> {
  if (query.generation !== undefined && query.generation !== registry.generation) {
    return err({
      code: "stale-generation",
      expected: query.generation,
      actual: registry.generation,
    });
  }
  const limit = query.limit ?? DEFAULT_CAPABILITY_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CAPABILITY_QUERY_LIMIT) {
    return err({ code: "invalid-query-limit", maximum: MAX_CAPABILITY_QUERY_LIMIT });
  }
  const offset = query.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    return err({ code: "invalid-query-offset" });
  }
  const text = query.text?.trim().toLocaleLowerCase() ?? "";
  if (text.length > MAX_CAPABILITY_QUERY_TEXT_LENGTH) {
    return err({ code: "invalid-query-text", maximum: MAX_CAPABILITY_QUERY_TEXT_LENGTH });
  }
  const matches = registry.entries.filter((entry) => {
    if (
      query.families !== undefined &&
      (entry.family === null || !query.families.includes(entry.family))
    )
      return false;
    if (query.kinds !== undefined && !query.kinds.includes(entry.kind)) return false;
    if (query.sources !== undefined && !query.sources.includes(entry.source)) return false;
    if (
      query.availabilities !== undefined &&
      !query.availabilities.includes(entry.state.availability)
    )
      return false;
    if (query.executable !== undefined && entry.state.executable !== query.executable) return false;
    if (text.length === 0) return true;
    return `${entry.title}\n${entry.summary}\n${entry.namespace}\n${entry.name}`
      .toLocaleLowerCase()
      .includes(text);
  });
  return ok({
    generation: registry.generation,
    total: matches.length,
    offset,
    limit,
    entries: Object.freeze(matches.slice(offset, offset + limit)),
  });
}

/** Deterministic, secret-free projection for JSON, replay, support, and docs. */
export function serializeCapabilityRegistry(
  registry: CapabilityRegistry,
  maximumCards = DEFAULT_CAPABILITY_QUERY_LIMIT,
): Result<string, CapabilityRegistryError> {
  const result = queryCapabilityRegistry(registry, { limit: maximumCards });
  if (!result.ok) return result;
  const counts = Object.fromEntries(
    CAPABILITY_CONTRIBUTION_KINDS.map((kind) => [
      kind,
      registry.entries.filter((entry) => entry.kind === kind).length,
    ]),
  );
  return ok(
    JSON.stringify({
      schemaVersion: registry.schemaVersion,
      generation: registry.generation,
      total: registry.entries.length,
      counts,
      omitted: Math.max(0, registry.entries.length - result.value.entries.length),
      cards: result.value.entries.map((entry) => capabilityCard(entry)),
    }),
  );
}

export function defaultCapabilityOperationalState(
  overrides: Partial<CapabilityOperationalState> = {},
): CapabilityOperationalState {
  return {
    installed: overrides.installed ?? true,
    configured: overrides.configured ?? true,
    allowed: overrides.allowed ?? true,
    selected: overrides.selected ?? false,
    active: overrides.active ?? false,
    denied: overrides.denied ?? false,
    incompatible: overrides.incompatible ?? false,
    quarantined: overrides.quarantined ?? false,
    deferred: overrides.deferred ?? false,
    omitted: overrides.omitted ?? false,
  };
}
