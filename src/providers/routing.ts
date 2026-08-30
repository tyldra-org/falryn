/**
 * Intent → role routing, catalog compatibility, and ordered non-recursive fallback.
 *
 * Scoring / circuit health / live cost are deferred; this module records a full
 * routing receipt and refuses illegal states (disabled role, empty catalog match,
 * recursive fallback).
 */

import type { Instant } from "../domain/clock.ts";
import type { ModelId, ProviderId } from "../domain/identity.ts";
import type { ProviderAdapterKind } from "./adapter-kind.ts";
import type { ModelCapability, ModelCatalog } from "./discovery.ts";
import {
  featureIsSupported,
  type MODEL_CAPABILITY_SCHEMA_VERSION,
  type ModelInputModality,
  type ModelResponseDensityControl,
} from "./model-capability.ts";
import {
  isRoleDisabled,
  type ModelPolicy,
  type ReasoningEffort,
  type RoleBudgets,
  type RoleRoute,
  resolveIntentRole,
  roleRouteFor,
} from "./policy.ts";
import {
  defaultRequirementsForIntent,
  mergeRequirements,
  primaryCapabilityForRole,
  type RouteRequirement,
  resolveSpecializedRole,
} from "./role-support.ts";
import type { ModelRole, WorkIntent } from "./roles.ts";

export type { RouteRequirement } from "./role-support.ts";

export type ExplicitModelSelection = {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
};

/** One provider's catalog entry used for multi-provider routing. */
export type RoutedCatalogEntry = {
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly adapterKind: ProviderAdapterKind;
  readonly destinationId: string;
  readonly requestInputModalities: readonly ModelInputModality[];
  readonly requestResponseDensityControls?: readonly ModelResponseDensityControl[];
  readonly catalog: ModelCatalog;
};

export type RouteSelectionReason =
  | "explicit-selection"
  | "role-policy"
  | "intent-mapped-role"
  | "fallback";

export type RoutingReceipt = {
  readonly role: ModelRole;
  readonly intent: WorkIntent | null;
  readonly selectionReason: RouteSelectionReason;
  readonly requiredCapabilities: RouteRequirement;
  readonly providerId: ProviderId;
  readonly providerProfileId: string;
  readonly providerAdapterKind: ProviderAdapterKind;
  readonly providerDestinationId: string;
  readonly modelId: ModelId;
  readonly reasoning: ReasoningEffort;
  readonly reasoningControl: string | null;
  /** Exact model-and-adapter intersection available to Brief for this route. */
  readonly responseDensityControls: readonly ModelResponseDensityControl[];
  readonly fallbackPosition: number;
  readonly budgets: RoleBudgets;
  readonly catalogGeneration: number;
  readonly catalogProvenance: ModelCatalog["provenance"];
  readonly modelCapabilitySchemaVersion: typeof MODEL_CAPABILITY_SCHEMA_VERSION;
  readonly recordedAt: Instant | null;
};

export type RoutingOutcome =
  | {
      readonly kind: "selected";
      readonly receipt: RoutingReceipt;
      readonly capability: ModelCapability;
    }
  | {
      readonly kind: "no-eligible-route";
      readonly role: ModelRole;
      readonly intent: WorkIntent | null;
      readonly code: string;
    }
  | {
      readonly kind: "role-disabled";
      readonly role: ModelRole;
      readonly intent: WorkIntent | null;
    }
  | {
      readonly kind: "role-unconfigured";
      readonly role: ModelRole;
      readonly intent: WorkIntent | null;
    }
  | {
      readonly kind: "policy-invalid";
      readonly code: string;
    };

export type ResolveRouteInput = {
  readonly policy: ModelPolicy;
  readonly catalogs: readonly RoutedCatalogEntry[];
  /** Prefer explicit role when set; otherwise map from intent (default coding). */
  readonly intent?: WorkIntent;
  readonly role?: ModelRole;
  readonly explicit?: ExplicitModelSelection;
  readonly required?: RouteRequirement;
  readonly now?: Instant;
  /**
   * When primary fails and a fallback chain should be walked, pass the 0-based
   * attempt index into the ordered list (0 = primary). Callers advance on failure.
   */
  readonly fallbackPosition?: number;
  /** Provider/model pairs already attempted; proves non-recursion. */
  readonly visited?: ReadonlySet<string>;
};

function routeKey(providerId: ProviderId, modelId: ModelId): string {
  return `${providerId}\0${modelId}`;
}

export function modelMatchesRequirements(
  capability: ModelCapability,
  required: RouteRequirement,
): boolean {
  if (capability.availability === "unavailable") {
    return false;
  }
  if (required.tools === true && !featureIsSupported(capability.tools)) {
    return false;
  }
  if (required.structuredOutput === true && !featureIsSupported(capability.structuredOutput)) {
    return false;
  }
  if (required.streaming === true && !featureIsSupported(capability.streaming)) {
    return false;
  }
  if (required.reasoning === true && !featureIsSupported(capability.reasoning)) {
    return false;
  }
  if (required.reasoningControls !== undefined) {
    for (const control of required.reasoningControls) {
      if (!capability.reasoningControls.includes(control)) {
        return false;
      }
    }
  }
  if (
    required.minContextTokens !== undefined &&
    (capability.contextTokens === null || capability.contextTokens < required.minContextTokens)
  ) {
    return false;
  }
  if (
    required.minOutputTokens !== undefined &&
    (capability.outputTokens === null || capability.outputTokens < required.minOutputTokens)
  ) {
    return false;
  }
  if (required.modalities !== undefined) {
    for (const modality of required.modalities) {
      if (!capability.inputModalities.includes(modality)) {
        return false;
      }
    }
  }
  if (required.outputModalities !== undefined) {
    for (const modality of required.outputModalities) {
      if (!capability.outputModalities.includes(modality)) {
        return false;
      }
    }
  }
  return true;
}

function findCapability(
  catalogs: readonly RoutedCatalogEntry[],
  providerId: ProviderId,
  modelId: ModelId,
  now?: Instant,
): { capability: ModelCapability; entry: RoutedCatalogEntry } | undefined {
  for (const entry of catalogs) {
    if (entry.providerId !== providerId) {
      continue;
    }
    if (
      now !== undefined &&
      entry.catalog.expiresAt !== null &&
      Number(entry.catalog.expiresAt) <= Number(now)
    ) {
      continue;
    }
    const capability = entry.catalog.models.find((model) => model.modelId === modelId);
    if (capability !== undefined) {
      return { capability, entry };
    }
  }
  return undefined;
}

const REASONING_CONTROL_PREFERENCES = {
  deterministic: {
    minimal: ["minimal", "low", "none"],
    balanced: ["balanced", "medium"],
    deep: ["deep", "high", "xhigh"],
    max: ["max"],
    "provider-default": [],
  },
  openai: {
    minimal: ["minimal", "low", "none"],
    balanced: ["medium"],
    deep: ["high", "xhigh"],
    max: ["max"],
    "provider-default": [],
  },
  anthropic: {
    minimal: ["low"],
    balanced: ["medium"],
    deep: ["high", "xhigh"],
    max: ["max"],
    "provider-default": [],
  },
  google: {
    minimal: ["minimal", "low"],
    balanced: ["medium"],
    deep: ["high"],
    max: [],
    "provider-default": [],
  },
  commandcode: {
    minimal: ["low"],
    balanced: ["medium"],
    deep: ["high", "xhigh"],
    max: ["max"],
    "provider-default": [],
  },
  custom: {
    minimal: ["minimal", "low", "none"],
    balanced: ["balanced", "medium"],
    deep: ["deep", "high", "xhigh"],
    max: ["max"],
    "provider-default": [],
  },
} as const satisfies Record<ProviderAdapterKind, Record<ReasoningEffort, readonly string[]>>;

function reasoningControlFor(
  capability: ModelCapability,
  reasoning: ReasoningEffort,
  adapterKind: ProviderAdapterKind,
): string | null {
  for (const candidate of REASONING_CONTROL_PREFERENCES[adapterKind][reasoning]) {
    if (capability.reasoningControls.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function responseDensityControlsFor(
  capability: ModelCapability,
  entry: RoutedCatalogEntry,
): readonly ModelResponseDensityControl[] {
  const modelControls = capability.responseDensityControls ?? [];
  const adapterControls = entry.requestResponseDensityControls ?? [];
  return modelControls.filter((control) => adapterControls.includes(control));
}

function adapterMatchesRequirements(
  entry: RoutedCatalogEntry,
  required: RouteRequirement,
): boolean {
  return (
    required.modalities === undefined ||
    required.modalities.every((modality) => entry.requestInputModalities.includes(modality))
  );
}

function buildCandidateList(
  route: RoleRoute,
): readonly { providerId: ProviderId; modelId: ModelId }[] {
  return [
    { providerId: route.providerId, modelId: route.modelId },
    ...route.fallbacks.map((fallback) => ({
      providerId: fallback.providerId,
      modelId: fallback.modelId,
    })),
  ];
}

/**
 * Resolve a provider/model for a work intent or explicit role, applying
 * specialized role support, compatibility filters, and ordered fallback
 * without revisiting routes.
 */
export function resolveModelRoute(input: ResolveRouteInput): RoutingOutcome {
  const intent = input.intent ?? null;
  const visited = new Set(input.visited ?? []);
  const startPosition = input.fallbackPosition ?? 0;

  if (input.explicit !== undefined) {
    const role =
      input.role ?? (intent !== null ? resolveIntentRole(input.policy, intent) : "default");
    const required = mergeRequirements(
      intent !== null ? defaultRequirementsForIntent(intent) : {},
      input.required ?? {},
    );
    const found = findCapability(
      input.catalogs,
      input.explicit.providerId,
      input.explicit.modelId,
      input.now,
    );
    if (
      found === undefined ||
      !modelMatchesRequirements(found.capability, required) ||
      !adapterMatchesRequirements(found.entry, required)
    ) {
      return {
        kind: "no-eligible-route",
        role,
        intent,
        code: "explicit-incompatible",
      };
    }
    const key = routeKey(input.explicit.providerId, input.explicit.modelId);
    if (visited.has(key)) {
      return {
        kind: "no-eligible-route",
        role,
        intent,
        code: "fallback-recursion",
      };
    }
    return {
      kind: "selected",
      capability: found.capability,
      receipt: {
        role,
        intent,
        selectionReason: "explicit-selection",
        requiredCapabilities: required,
        providerId: input.explicit.providerId,
        providerProfileId: found.entry.profileId,
        providerAdapterKind: found.entry.adapterKind,
        providerDestinationId: found.entry.destinationId,
        modelId: input.explicit.modelId,
        reasoning: "provider-default",
        reasoningControl: null,
        responseDensityControls: responseDensityControlsFor(found.capability, found.entry),
        fallbackPosition: 0,
        budgets: {},
        catalogGeneration: found.entry.catalog.generation,
        catalogProvenance: found.entry.catalog.provenance,
        modelCapabilitySchemaVersion: found.capability.schemaVersion,
        recordedAt: input.now ?? null,
      },
    };
  }

  const tentativeRole =
    input.role ?? (intent !== null ? resolveIntentRole(input.policy, intent) : "default");
  const primaryCapability = primaryCapabilityForRole(
    input.policy,
    tentativeRole === "vision" ? "default" : tentativeRole,
    (providerId, modelId) =>
      findCapability(input.catalogs, providerId, modelId, input.now)?.capability,
  );

  const specialized = resolveSpecializedRole({
    policy: input.policy,
    intent,
    primaryCapability,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.required !== undefined ? { required: input.required } : {}),
  });
  if (specialized.kind !== "resolved") {
    return specialized;
  }
  const { role, required } = specialized;

  const route = roleRouteFor(input.policy, role);
  if (route === undefined) {
    return { kind: "role-unconfigured", role, intent };
  }
  if (isRoleDisabled(route, role)) {
    return { kind: "role-disabled", role, intent };
  }

  const candidates = buildCandidateList(route);
  if (startPosition < 0 || startPosition >= candidates.length) {
    return {
      kind: "no-eligible-route",
      role,
      intent,
      code: "fallback-exhausted",
    };
  }

  for (let position = startPosition; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    if (candidate === undefined) {
      continue;
    }
    const key = routeKey(candidate.providerId, candidate.modelId);
    if (visited.has(key)) {
      return {
        kind: "no-eligible-route",
        role,
        intent,
        code: "fallback-recursion",
      };
    }
    visited.add(key);

    const found = findCapability(
      input.catalogs,
      candidate.providerId,
      candidate.modelId,
      input.now,
    );
    if (
      found === undefined ||
      !modelMatchesRequirements(found.capability, required) ||
      !adapterMatchesRequirements(found.entry, required)
    ) {
      continue;
    }

    const reasoningControl = reasoningControlFor(
      found.capability,
      route.reasoning,
      found.entry.adapterKind,
    );
    // Unlike the adaptive postures, max is an exact quality-first request. It
    // must never degrade to a provider default or another provider's "high".
    if (route.reasoning === "max" && reasoningControl === null) {
      continue;
    }

    const selectionReason: RouteSelectionReason =
      position === 0
        ? input.role !== undefined
          ? "role-policy"
          : intent !== null
            ? "intent-mapped-role"
            : "role-policy"
        : "fallback";

    return {
      kind: "selected",
      capability: found.capability,
      receipt: {
        role,
        intent,
        selectionReason,
        requiredCapabilities: required,
        providerId: candidate.providerId,
        providerProfileId: found.entry.profileId,
        providerAdapterKind: found.entry.adapterKind,
        providerDestinationId: found.entry.destinationId,
        modelId: candidate.modelId,
        reasoning: route.reasoning,
        reasoningControl,
        responseDensityControls: responseDensityControlsFor(found.capability, found.entry),
        fallbackPosition: position,
        budgets: route.budgets,
        catalogGeneration: found.entry.catalog.generation,
        catalogProvenance: found.entry.catalog.provenance,
        modelCapabilitySchemaVersion: found.capability.schemaVersion,
        recordedAt: input.now ?? null,
      },
    };
  }

  return {
    kind: "no-eligible-route",
    role,
    intent,
    code: "no-compatible-model",
  };
}

/**
 * Advance to the next fallback after a failed attempt, carrying visited keys
 * so the same provider/model cannot be selected again (non-recursion).
 */
export function resolveNextFallback(
  input: ResolveRouteInput,
  previous: RoutingReceipt,
): RoutingOutcome {
  const visited = new Set(input.visited ?? []);
  visited.add(routeKey(previous.providerId, previous.modelId));
  const { explicit: _ignored, ...rest } = input;
  return resolveModelRoute({
    ...rest,
    fallbackPosition: previous.fallbackPosition + 1,
    visited,
  });
}
