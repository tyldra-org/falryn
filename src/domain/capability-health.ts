/**
 * One immutable, consumer-specific view of capability health.
 *
 * The registry says what was published. This module answers whether those
 * declarations are usable by a named consumer at one observation point. It is
 * deliberately pure: dependency, credential, resource, probe, platform, and
 * host facts are supplied by application adapters and never discovered here.
 */

import type {
  CapabilityAvailability,
  CapabilityFamily,
  CapabilityRegistry,
  CapabilityRegistryEntry,
  CapabilitySource,
} from "./capability-registry.ts";
import { capabilityCard, capabilityLifecycle } from "./capability-registry.ts";
import type { Instant } from "./clock.ts";
import type { CapabilityId, ConfigurationGeneration } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";
import type { EffectClass } from "./work.ts";

export const CAPABILITY_HEALTH_SCHEMA_VERSION = 1;
export const DEFAULT_CAPABILITY_HEALTH_QUERY_LIMIT = 32;
export const MAX_CAPABILITY_HEALTH_QUERY_LIMIT = 256;
export const MAX_CAPABILITY_HEALTH_REASON_LENGTH = 256;
export const MAX_CAPABILITY_HEALTH_QUERY_TEXT_LENGTH = 256;

export const CAPABILITY_CONSUMERS = [
  "native-model",
  "cli",
  "opentui",
  "headless",
  "external-host",
] as const;

export type CapabilityConsumer = (typeof CAPABILITY_CONSUMERS)[number];

export const CAPABILITY_EFFECTIVE_HEALTH_STATES = [
  "healthy",
  "degraded",
  "unavailable",
  "incompatible",
  "denied",
  "quarantined",
  "unknown",
] as const;

export type CapabilityEffectiveHealthState = (typeof CAPABILITY_EFFECTIVE_HEALTH_STATES)[number];

export const CAPABILITY_HEALTH_CODES = [
  "not-installed",
  "not-configured",
  "policy-denied",
  "quarantined",
  "platform-incompatible",
  "architecture-incompatible",
  "missing-dependency",
  "dependency-unknown",
  "credential-missing",
  "credential-expired",
  "credential-unknown",
  "resource-constrained",
  "resource-unavailable",
  "runtime-degraded",
  "runtime-unavailable",
  "probe-degraded",
  "probe-unavailable",
  "probe-unknown",
  "probe-stale",
  "probe-cancelled",
  "probe-timed-out",
  "missing-attempt-runner",
  "missing-provider",
  "missing-workspace",
  "host-not-installed",
  "host-disconnected",
  "host-schema-rejected",
] as const;

export type CapabilityHealthCode = (typeof CAPABILITY_HEALTH_CODES)[number];

export type CapabilityRecovery = {
  readonly kind:
    | "configure"
    | "authenticate"
    | "install"
    | "allow"
    | "reload"
    | "retry"
    | "reconnect"
    | "inspect";
  /** Opaque action identity. It never contains credentials or input payloads. */
  readonly handle: string;
};

export type CapabilityHealthDiagnostic = {
  readonly code: CapabilityHealthCode;
  readonly state: Exclude<CapabilityEffectiveHealthState, "healthy">;
  readonly message: string;
  readonly source:
    | "registry"
    | "platform"
    | "dependency"
    | "credential"
    | "resource"
    | "policy"
    | "probe"
    | "consumer";
  readonly recovery: CapabilityRecovery | null;
  readonly observedAt: Instant | null;
  readonly expiresAt: Instant | null;
};

export type CapabilityDependencyState = "available" | "unavailable" | "unknown";
export type CapabilityCredentialState =
  | "valid"
  | "missing"
  | "expired"
  | "unknown"
  | "not-required";
export type CapabilityResourceState = "available" | "constrained" | "unavailable" | "unknown";

export type CapabilityProbeObservation = {
  readonly state: "healthy" | "degraded" | "unavailable" | "unknown";
  readonly code:
    | "probe-degraded"
    | "probe-unavailable"
    | "probe-unknown"
    | "probe-cancelled"
    | "probe-timed-out";
  readonly message: string;
  readonly observedAt: Instant;
  readonly expiresAt: Instant;
  readonly recovery: CapabilityRecovery | null;
};

export type CapabilityRuntimeReadiness = {
  readonly attemptRunner: "available" | "missing" | "unknown";
  readonly provider: "available" | "missing" | "unknown";
  readonly workspace: "available" | "missing" | "unknown";
};

export type CapabilityExternalHostReadiness = {
  readonly installation: "installed" | "missing" | "unknown";
  readonly connection: "connected" | "disconnected" | "unknown";
  readonly schema: "accepted" | "rejected" | "unknown";
};

export type CapabilityHealthEvidence = {
  readonly now?: Instant;
  readonly os?: "darwin" | "linux" | "win32";
  readonly arch?: "arm64" | "x64";
  readonly dependencies?: Readonly<Record<string, CapabilityDependencyState>>;
  readonly credentials?: Readonly<Record<string, CapabilityCredentialState>>;
  readonly resources?: Readonly<Record<string, CapabilityResourceState>>;
  readonly probes?: Readonly<Record<string, CapabilityProbeObservation>>;
  readonly deniedEffects?: readonly EffectClass[];
  readonly deniedNames?: readonly string[];
  readonly disclosed?: readonly CapabilityId[];
  readonly projected?: readonly CapabilityId[];
  readonly selected?: readonly CapabilityId[];
  readonly active?: readonly CapabilityId[];
  readonly runtime?: CapabilityRuntimeReadiness;
  readonly externalHost?: CapabilityExternalHostReadiness;
};

export type CapabilityHealthEntry = {
  readonly capabilityId: CapabilityId;
  readonly title: string;
  readonly summary: string;
  readonly kind: CapabilityRegistryEntry["kind"];
  readonly family: CapabilityFamily | null;
  readonly source: CapabilitySource;
  readonly sourceId: string;
  readonly version: number;
  readonly generation: ConfigurationGeneration;
  readonly consumer: CapabilityConsumer;
  readonly effect: EffectClass;
  readonly availability: CapabilityAvailability;
  readonly health: CapabilityEffectiveHealthState;
  readonly registered: true;
  readonly available: boolean;
  readonly disclosed: boolean;
  readonly executable: boolean;
  readonly projected: boolean;
  readonly selected: boolean;
  readonly active: boolean;
  readonly selectable: boolean;
  readonly diagnostics: readonly CapabilityHealthDiagnostic[];
};

export type CapabilityHealthSummary = {
  readonly registered: number;
  readonly available: number;
  readonly disclosed: number;
  readonly executable: number;
  readonly projected: number;
  readonly selected: number;
  readonly active: number;
  readonly selectable: number;
  readonly byHealth: Readonly<Record<CapabilityEffectiveHealthState, number>>;
};

export type CapabilityHealthSnapshot = {
  readonly schemaVersion: typeof CAPABILITY_HEALTH_SCHEMA_VERSION;
  readonly generation: ConfigurationGeneration;
  readonly consumer: CapabilityConsumer;
  readonly observedAt: Instant | null;
  readonly discoveryHandle: string;
  readonly summary: CapabilityHealthSummary;
  readonly entries: readonly CapabilityHealthEntry[];
};

export type CapabilityHealthQuery = {
  readonly generation?: ConfigurationGeneration;
  readonly consumer?: CapabilityConsumer;
  readonly text?: string;
  readonly families?: readonly CapabilityFamily[];
  readonly sources?: readonly CapabilitySource[];
  readonly health?: readonly CapabilityEffectiveHealthState[];
  readonly effects?: readonly EffectClass[];
  readonly available?: boolean;
  readonly disclosed?: boolean;
  readonly executable?: boolean;
  readonly projected?: boolean;
  readonly selected?: boolean;
  readonly active?: boolean;
  readonly selectable?: boolean;
  readonly reasonCode?: CapabilityHealthCode;
  readonly offset?: number;
  readonly limit?: number;
};

export type CapabilityHealthQueryResult = {
  readonly generation: ConfigurationGeneration;
  readonly consumer: CapabilityConsumer;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly entries: readonly CapabilityHealthEntry[];
  readonly nextHandle: string | null;
};

export type CapabilityHealthError =
  | {
      readonly code: "stale-generation";
      readonly expected: ConfigurationGeneration;
      readonly actual: ConfigurationGeneration;
    }
  | { readonly code: "wrong-consumer"; readonly expected: CapabilityConsumer }
  | { readonly code: "invalid-query-limit"; readonly maximum: number }
  | { readonly code: "invalid-query-offset" }
  | { readonly code: "invalid-query-text"; readonly maximum: number };

const HEALTH_PRECEDENCE: Readonly<Record<CapabilityEffectiveHealthState, number>> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  unavailable: 3,
  incompatible: 4,
  denied: 5,
  quarantined: 6,
};

function boundedReason(reason: string): string {
  return reason.length <= MAX_CAPABILITY_HEALTH_REASON_LENGTH
    ? reason
    : reason.slice(0, MAX_CAPABILITY_HEALTH_REASON_LENGTH);
}

function recovery(
  kind: CapabilityRecovery["kind"],
  capability: CapabilityRegistryEntry,
): CapabilityRecovery {
  return { kind, handle: `capability:${kind}:${capability.capabilityId}` };
}

function diagnostic(
  capability: CapabilityRegistryEntry,
  code: CapabilityHealthCode,
  state: Exclude<CapabilityEffectiveHealthState, "healthy">,
  message: string,
  source: CapabilityHealthDiagnostic["source"],
  recoveryKind: CapabilityRecovery["kind"] | null,
  observedAt: Instant | null = null,
  expiresAt: Instant | null = null,
): CapabilityHealthDiagnostic {
  return {
    code,
    state,
    message: boundedReason(message),
    source,
    recovery: recoveryKind === null ? null : recovery(recoveryKind, capability),
    observedAt,
    expiresAt,
  };
}

function registryDiagnostics(entry: CapabilityRegistryEntry): CapabilityHealthDiagnostic[] {
  const diagnostics: CapabilityHealthDiagnostic[] = [];
  const operational = entry.state.operational;
  if (!operational.installed) {
    diagnostics.push(
      diagnostic(
        entry,
        "not-installed",
        "unavailable",
        "capability is not installed",
        "registry",
        "install",
      ),
    );
  }
  if (!operational.configured) {
    diagnostics.push(
      diagnostic(
        entry,
        "not-configured",
        "unavailable",
        "capability is not configured",
        "registry",
        "configure",
      ),
    );
  }
  if (!operational.allowed || operational.denied) {
    diagnostics.push(
      diagnostic(
        entry,
        "policy-denied",
        "denied",
        "capability is denied by effective policy",
        "policy",
        "allow",
      ),
    );
  }
  if (operational.quarantined) {
    diagnostics.push(
      diagnostic(
        entry,
        "quarantined",
        "quarantined",
        "capability is quarantined",
        "registry",
        "inspect",
      ),
    );
  }
  if (operational.incompatible) {
    diagnostics.push(
      diagnostic(
        entry,
        "platform-incompatible",
        "incompatible",
        "capability is marked incompatible",
        "registry",
        null,
      ),
    );
  }
  if (entry.state.availability === "unavailable") {
    diagnostics.push(
      diagnostic(
        entry,
        "runtime-unavailable",
        "unavailable",
        entry.state.availabilityReason ?? "capability runtime is unavailable",
        "registry",
        "retry",
      ),
    );
  } else if (entry.state.availability === "unknown" || entry.state.health === "unknown") {
    diagnostics.push(
      diagnostic(
        entry,
        "runtime-unavailable",
        "unknown",
        entry.state.availabilityReason ??
          entry.state.healthReason ??
          "capability runtime state is unknown",
        "registry",
        "reload",
      ),
    );
  } else if (entry.state.availability === "degraded" || entry.state.health === "degraded") {
    diagnostics.push(
      diagnostic(
        entry,
        "runtime-degraded",
        "degraded",
        entry.state.healthReason ??
          entry.state.availabilityReason ??
          "capability runtime is degraded",
        "registry",
        "inspect",
      ),
    );
  } else if (entry.state.health === "unavailable") {
    diagnostics.push(
      diagnostic(
        entry,
        "runtime-unavailable",
        "unavailable",
        entry.state.healthReason ?? "capability runtime is unavailable",
        "registry",
        "retry",
      ),
    );
  }
  return diagnostics;
}

function compatibilityDiagnostics(
  entry: CapabilityRegistryEntry,
  evidence: CapabilityHealthEvidence,
): CapabilityHealthDiagnostic[] {
  const diagnostics: CapabilityHealthDiagnostic[] = [];
  if (
    evidence.os !== undefined &&
    entry.compatibility.os.length > 0 &&
    !entry.compatibility.os.includes(evidence.os)
  ) {
    diagnostics.push(
      diagnostic(
        entry,
        "platform-incompatible",
        "incompatible",
        `capability does not support ${evidence.os}`,
        "platform",
        null,
      ),
    );
  }
  if (
    evidence.arch !== undefined &&
    entry.compatibility.arch.length > 0 &&
    !entry.compatibility.arch.includes(evidence.arch)
  ) {
    diagnostics.push(
      diagnostic(
        entry,
        "architecture-incompatible",
        "incompatible",
        `capability does not support ${evidence.arch}`,
        "platform",
        null,
      ),
    );
  }
  for (const dependency of entry.compatibility.dependencies) {
    const state = evidence.dependencies?.[dependency] ?? "unknown";
    if (state === "unavailable") {
      diagnostics.push(
        diagnostic(
          entry,
          "missing-dependency",
          "unavailable",
          `required dependency ${dependency} is unavailable`,
          "dependency",
          "install",
        ),
      );
    } else if (state === "unknown") {
      diagnostics.push(
        diagnostic(
          entry,
          "dependency-unknown",
          "unknown",
          `required dependency ${dependency} has not been checked`,
          "dependency",
          "inspect",
        ),
      );
    }
  }
  return diagnostics;
}

function dynamicDiagnostics(
  entry: CapabilityRegistryEntry,
  evidence: CapabilityHealthEvidence,
): CapabilityHealthDiagnostic[] {
  const diagnostics: CapabilityHealthDiagnostic[] = [];
  if (
    evidence.deniedEffects?.includes(entry.effect) === true ||
    evidence.deniedNames?.includes(entry.name) === true
  ) {
    diagnostics.push(
      diagnostic(
        entry,
        "policy-denied",
        "denied",
        "capability is denied by effective execution policy",
        "policy",
        "allow",
      ),
    );
  }
  const credential = evidence.credentials?.[entry.capabilityId] ?? "not-required";
  if (credential === "missing") {
    diagnostics.push(
      diagnostic(
        entry,
        "credential-missing",
        "unavailable",
        "required credential is unavailable",
        "credential",
        "authenticate",
      ),
    );
  } else if (credential === "expired") {
    diagnostics.push(
      diagnostic(
        entry,
        "credential-expired",
        "unavailable",
        "required credential has expired",
        "credential",
        "authenticate",
      ),
    );
  } else if (credential === "unknown") {
    diagnostics.push(
      diagnostic(
        entry,
        "credential-unknown",
        "unknown",
        "credential state has not been verified",
        "credential",
        "inspect",
      ),
    );
  }
  const resource = evidence.resources?.[entry.capabilityId] ?? "available";
  if (resource === "constrained") {
    diagnostics.push(
      diagnostic(
        entry,
        "resource-constrained",
        "degraded",
        "capability resources are constrained",
        "resource",
        "retry",
      ),
    );
  } else if (resource === "unavailable") {
    diagnostics.push(
      diagnostic(
        entry,
        "resource-unavailable",
        "unavailable",
        "capability resources are unavailable",
        "resource",
        "retry",
      ),
    );
  } else if (resource === "unknown") {
    diagnostics.push(
      diagnostic(
        entry,
        "resource-constrained",
        "unknown",
        "capability resource state is unknown",
        "resource",
        "inspect",
      ),
    );
  }
  const probe = evidence.probes?.[entry.capabilityId];
  if (probe !== undefined) {
    if (
      evidence.now !== undefined &&
      probe.expiresAt < evidence.now &&
      probe.code !== "probe-cancelled" &&
      probe.code !== "probe-timed-out"
    ) {
      diagnostics.push(
        diagnostic(
          entry,
          "probe-stale",
          "unknown",
          "capability probe observation is stale",
          "probe",
          "retry",
          probe.observedAt,
          probe.expiresAt,
        ),
      );
    } else if (probe.state !== "healthy") {
      diagnostics.push({
        code: probe.code,
        state: probe.state,
        message: boundedReason(probe.message),
        source: "probe",
        recovery: probe.recovery,
        observedAt: probe.observedAt,
        expiresAt: probe.expiresAt,
      });
    }
  }
  return diagnostics;
}

function consumerDiagnostics(
  entry: CapabilityRegistryEntry,
  consumer: CapabilityConsumer,
  evidence: CapabilityHealthEvidence,
): CapabilityHealthDiagnostic[] {
  const diagnostics: CapabilityHealthDiagnostic[] = [];
  if (consumer === "native-model" || consumer === "headless") {
    if (evidence.runtime?.attemptRunner === "missing") {
      diagnostics.push(
        diagnostic(
          entry,
          "missing-attempt-runner",
          "unavailable",
          "model attempt runner is unavailable",
          "consumer",
          "reload",
        ),
      );
    }
    if (evidence.runtime?.provider === "missing") {
      diagnostics.push(
        diagnostic(
          entry,
          "missing-provider",
          "unavailable",
          "model provider is unavailable",
          "consumer",
          "configure",
        ),
      );
    }
    if (evidence.runtime?.workspace === "missing") {
      diagnostics.push(
        diagnostic(
          entry,
          "missing-workspace",
          "unavailable",
          "workspace is unavailable",
          "consumer",
          "configure",
        ),
      );
    }
  }
  if (consumer === "external-host") {
    if (evidence.externalHost?.installation === "missing") {
      diagnostics.push(
        diagnostic(
          entry,
          "host-not-installed",
          "unavailable",
          "external host bridge is not installed",
          "consumer",
          "install",
        ),
      );
    }
    if (evidence.externalHost?.connection === "disconnected") {
      diagnostics.push(
        diagnostic(
          entry,
          "host-disconnected",
          "unavailable",
          "external host bridge is disconnected",
          "consumer",
          "reconnect",
        ),
      );
    }
    if (evidence.externalHost?.schema === "rejected") {
      diagnostics.push(
        diagnostic(
          entry,
          "host-schema-rejected",
          "incompatible",
          "external host rejected the capability schema",
          "consumer",
          "inspect",
        ),
      );
    }
  }
  return diagnostics;
}

function effectiveHealth(
  diagnostics: readonly CapabilityHealthDiagnostic[],
): CapabilityEffectiveHealthState {
  return diagnostics.reduce<CapabilityEffectiveHealthState>(
    (current, item) =>
      HEALTH_PRECEDENCE[item.state] > HEALTH_PRECEDENCE[current] ? item.state : current,
    "healthy",
  );
}

function uniqueDiagnostics(
  diagnostics: readonly CapabilityHealthDiagnostic[],
): readonly CapabilityHealthDiagnostic[] {
  const seen = new Set<CapabilityHealthCode>();
  return diagnostics.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

function healthEntry(
  registry: CapabilityRegistry,
  entry: CapabilityRegistryEntry,
  consumer: CapabilityConsumer,
  evidence: CapabilityHealthEvidence,
): CapabilityHealthEntry {
  const disclosed = evidence.disclosed?.includes(entry.capabilityId) ?? false;
  const projected = evidence.projected?.includes(entry.capabilityId) ?? false;
  const selected =
    evidence.selected?.includes(entry.capabilityId) ?? entry.state.operational.selected;
  const active = evidence.active?.includes(entry.capabilityId) ?? entry.state.operational.active;
  const diagnostics = uniqueDiagnostics([
    ...registryDiagnostics(entry),
    ...compatibilityDiagnostics(entry, evidence),
    ...dynamicDiagnostics(entry, evidence),
    ...consumerDiagnostics(entry, consumer, evidence),
  ]);
  const health = effectiveHealth(diagnostics);
  const lifecycle = capabilityLifecycle(entry, { disclosed, projected });
  const available =
    lifecycle.available &&
    !["unavailable", "incompatible", "denied", "quarantined"].includes(health);
  const executable = lifecycle.executable && available;
  const selectable = executable && (health === "healthy" || health === "degraded");
  const card = capabilityCard(entry, { disclosed, projected });
  return Object.freeze({
    capabilityId: entry.capabilityId,
    title: card.title,
    summary: card.summary,
    kind: card.kind,
    family: card.family,
    source: card.source,
    sourceId: card.sourceId,
    version: card.version,
    generation: registry.generation,
    consumer,
    effect: card.effect,
    availability: entry.state.availability,
    health,
    registered: true,
    available,
    disclosed,
    executable,
    projected,
    selected,
    active,
    selectable,
    diagnostics: Object.freeze(diagnostics),
  });
}

function summary(entries: readonly CapabilityHealthEntry[]): CapabilityHealthSummary {
  const byHealth = Object.fromEntries(
    CAPABILITY_EFFECTIVE_HEALTH_STATES.map((state) => [
      state,
      entries.filter((entry) => entry.health === state).length,
    ]),
  ) as Readonly<Record<CapabilityEffectiveHealthState, number>>;
  return {
    registered: entries.length,
    available: entries.filter((entry) => entry.available).length,
    disclosed: entries.filter((entry) => entry.disclosed).length,
    executable: entries.filter((entry) => entry.executable).length,
    projected: entries.filter((entry) => entry.projected).length,
    selected: entries.filter((entry) => entry.selected).length,
    active: entries.filter((entry) => entry.active).length,
    selectable: entries.filter((entry) => entry.selectable).length,
    byHealth,
  };
}

export function inspectCapabilityHealth(
  registry: CapabilityRegistry,
  consumer: CapabilityConsumer,
  evidence: CapabilityHealthEvidence = {},
): CapabilityHealthSnapshot {
  const entries = Object.freeze(
    registry.entries.map((entry) => healthEntry(registry, entry, consumer, evidence)),
  );
  return Object.freeze({
    schemaVersion: CAPABILITY_HEALTH_SCHEMA_VERSION,
    generation: registry.generation,
    consumer,
    observedAt: evidence.now ?? null,
    discoveryHandle: `capability-health:${registry.generation}:${consumer}`,
    summary: summary(entries),
    entries,
  });
}

export function queryCapabilityHealth(
  snapshot: CapabilityHealthSnapshot,
  query: CapabilityHealthQuery = {},
): Result<CapabilityHealthQueryResult, CapabilityHealthError> {
  if (query.generation !== undefined && query.generation !== snapshot.generation) {
    return err({
      code: "stale-generation",
      expected: query.generation,
      actual: snapshot.generation,
    });
  }
  if (query.consumer !== undefined && query.consumer !== snapshot.consumer) {
    return err({ code: "wrong-consumer", expected: snapshot.consumer });
  }
  const limit = query.limit ?? DEFAULT_CAPABILITY_HEALTH_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CAPABILITY_HEALTH_QUERY_LIMIT) {
    return err({ code: "invalid-query-limit", maximum: MAX_CAPABILITY_HEALTH_QUERY_LIMIT });
  }
  const offset = query.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) return err({ code: "invalid-query-offset" });
  const text = query.text?.trim().toLocaleLowerCase() ?? "";
  if (text.length > MAX_CAPABILITY_HEALTH_QUERY_TEXT_LENGTH) {
    return err({ code: "invalid-query-text", maximum: MAX_CAPABILITY_HEALTH_QUERY_TEXT_LENGTH });
  }
  const matches = snapshot.entries.filter((entry) => {
    if (
      query.families !== undefined &&
      (entry.family === null || !query.families.includes(entry.family))
    )
      return false;
    if (query.sources !== undefined && !query.sources.includes(entry.source)) return false;
    if (query.health !== undefined && !query.health.includes(entry.health)) return false;
    if (query.effects !== undefined && !query.effects.includes(entry.effect)) return false;
    if (query.available !== undefined && entry.available !== query.available) return false;
    if (query.disclosed !== undefined && entry.disclosed !== query.disclosed) return false;
    if (query.executable !== undefined && entry.executable !== query.executable) return false;
    if (query.projected !== undefined && entry.projected !== query.projected) return false;
    if (query.selected !== undefined && entry.selected !== query.selected) return false;
    if (query.active !== undefined && entry.active !== query.active) return false;
    if (query.selectable !== undefined && entry.selectable !== query.selectable) return false;
    if (
      query.reasonCode !== undefined &&
      !entry.diagnostics.some((item) => item.code === query.reasonCode)
    )
      return false;
    if (text.length === 0) return true;
    return `${entry.title}\n${entry.summary}\n${entry.capabilityId}\n${entry.diagnostics.map((item) => `${item.code} ${item.message}`).join("\n")}`
      .toLocaleLowerCase()
      .includes(text);
  });
  const page = Object.freeze(matches.slice(offset, offset + limit));
  const nextOffset = offset + page.length;
  return ok({
    generation: snapshot.generation,
    consumer: snapshot.consumer,
    total: matches.length,
    offset,
    limit,
    entries: page,
    nextHandle:
      nextOffset < matches.length
        ? `${snapshot.discoveryHandle}:offset=${nextOffset}:limit=${limit}`
        : null,
  });
}
