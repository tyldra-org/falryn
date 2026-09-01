/**
 * Specialized role support: vision use-policy, thinking/reasoning helpers,
 * fast-edit/read requirement defaults, and compact evaluated/off selection.
 *
 * Pure library helpers consumed by `resolveModelRoute`. No live provider
 * thinking streams or vendor adapters.
 */

import type { ModelCapability } from "./discovery.ts";
import type { ModelInputModality, ModelOutputModality } from "./model-capability.ts";
import {
  type ModelPolicy,
  type ReasoningEffort,
  type RoleRoute,
  resolveIntentRole,
  roleRouteFor,
} from "./policy.ts";
import type { ModelRole, WorkIntent } from "./roles.ts";

export type RouteRequirement = {
  readonly modalities?: readonly ModelInputModality[];
  readonly outputModalities?: readonly ModelOutputModality[];
  readonly tools?: boolean;
  readonly structuredOutput?: boolean;
  readonly streaming?: boolean;
  readonly reasoning?: boolean;
  /** Provider-native controls required by the selected operation. */
  readonly reasoningControls?: readonly string[];
  readonly minContextTokens?: number;
  readonly minOutputTokens?: number;
};

export function defaultRequirementsForIntent(intent: WorkIntent): RouteRequirement {
  switch (intent) {
    case "coding":
      return { tools: true, streaming: true };
    case "read":
      return { streaming: true };
    case "toolRouting":
      return { tools: true };
    case "fastEdit":
      return { tools: true, streaming: true };
    case "planning":
      return { reasoning: true };
    case "deepReview":
      return { reasoning: true };
    case "verification":
      return { tools: true };
    case "visualUnderstanding":
      return { modalities: ["image"] };
    case "independentCritique":
      return {};
    case "compression":
      return {};
    case "memory":
      return {};
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

export function mergeRequirements(
  base: RouteRequirement,
  override: RouteRequirement,
): RouteRequirement {
  const merged: {
    modalities?: readonly ModelInputModality[];
    outputModalities?: readonly ModelOutputModality[];
    tools?: boolean;
    structuredOutput?: boolean;
    streaming?: boolean;
    reasoning?: boolean;
    reasoningControls?: readonly string[];
    minContextTokens?: number;
    minOutputTokens?: number;
  } = {};
  const modalities = override.modalities ?? base.modalities;
  if (modalities !== undefined) {
    merged.modalities = modalities;
  }
  const outputModalities = override.outputModalities ?? base.outputModalities;
  if (outputModalities !== undefined) {
    merged.outputModalities = outputModalities;
  }
  const tools = override.tools ?? base.tools;
  if (tools !== undefined) {
    merged.tools = tools;
  }
  const structuredOutput = override.structuredOutput ?? base.structuredOutput;
  if (structuredOutput !== undefined) {
    merged.structuredOutput = structuredOutput;
  }
  const streaming = override.streaming ?? base.streaming;
  if (streaming !== undefined) {
    merged.streaming = streaming;
  }
  const reasoning = override.reasoning ?? base.reasoning;
  if (reasoning !== undefined) {
    merged.reasoning = reasoning;
  }
  const reasoningControls = override.reasoningControls ?? base.reasoningControls;
  if (reasoningControls !== undefined) {
    merged.reasoningControls = reasoningControls;
  }
  const minContextTokens = override.minContextTokens ?? base.minContextTokens;
  if (minContextTokens !== undefined) {
    merged.minContextTokens = minContextTokens;
  }
  const minOutputTokens = override.minOutputTokens ?? base.minOutputTokens;
  if (minOutputTokens !== undefined) {
    merged.minOutputTokens = minOutputTokens;
  }
  return merged;
}

export function intentRequiresImage(
  intent: WorkIntent | null,
  required: RouteRequirement,
): boolean {
  if (required.modalities?.includes("image" satisfies ModelInputModality)) {
    return true;
  }
  return intent === "visualUnderstanding";
}

export function capabilityHasImage(capability: ModelCapability | null | undefined): boolean {
  return capability?.inputModalities.includes("image") === true;
}

/** Whether the intent prefers a declared reasoning-effort binding (deep/plan path). */
export function intentPrefersReasoningEffort(intent: WorkIntent): boolean {
  switch (intent) {
    case "planning":
    case "deepReview":
      return true;
    case "coding":
    case "read":
    case "toolRouting":
    case "fastEdit":
    case "verification":
    case "visualUnderstanding":
    case "independentCritique":
    case "compression":
    case "memory":
      return false;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

export function reasoningEffortForRoute(route: RoleRoute): ReasoningEffort {
  return route.reasoning;
}

export type SpecializedRoleOutcome =
  | {
      readonly kind: "resolved";
      readonly role: ModelRole;
      readonly required: RouteRequirement;
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
    };

export type ResolveSpecializedRoleInput = {
  readonly policy: ModelPolicy;
  readonly intent?: WorkIntent | null;
  readonly role?: ModelRole;
  readonly required?: RouteRequirement;
  /**
   * Capability of the tentative (pre-escalation) primary route when known.
   * Used for vision `use: "fallback"` when deciding whether the primary lacks image.
   */
  readonly primaryCapability?: ModelCapability | null;
};

/**
 * Resolve role + requirement defaults for specialized workloads (vision use,
 * compact evaluated/off, fast-edit/read defaults). Callers still run catalog
 * compatibility via `resolveModelRoute`.
 */
export function resolveSpecializedRole(input: ResolveSpecializedRoleInput): SpecializedRoleOutcome {
  const intent = input.intent ?? null;
  const mappedRole =
    input.role ?? (intent !== null ? resolveIntentRole(input.policy, intent) : "default");
  const required = mergeRequirements(
    intent !== null ? defaultRequirementsForIntent(intent) : {},
    input.required ?? {},
  );

  const imageNeeded = intentRequiresImage(intent, required);
  const primaryLacksImage =
    input.primaryCapability !== undefined &&
    input.primaryCapability !== null &&
    !capabilityHasImage(input.primaryCapability);

  let role = mappedRole;

  // Compact: evaluated allows selection when mapped; off fails closed.
  if (role === "compact") {
    const compact = input.policy.roles.compact;
    if (compact === undefined) {
      return { kind: "role-unconfigured", role: "compact", intent };
    }
    if (compact.use === "off") {
      return { kind: "role-disabled", role: "compact", intent };
    }
    return { kind: "resolved", role, required };
  }

  // Vision: enforce use policy and escalate when image modality is required.
  const vision = input.policy.roles.vision;
  const considerVision = role === "vision" || imageNeeded;

  if (considerVision) {
    if (vision === undefined) {
      return { kind: "role-unconfigured", role: "vision", intent };
    }
    if (vision.use === "off") {
      return { kind: "role-disabled", role: "vision", intent };
    }

    if (vision.use === "always") {
      // Prefer vision for visualUnderstanding and any image-required work.
      role = "vision";
      const withImage = mergeRequirements(required, {
        modalities: required.modalities ?? ["image"],
      });
      return { kind: "resolved", role, required: withImage };
    }

    // use === "fallback": vision only when image required or primary lacks image.
    if (imageNeeded || primaryLacksImage) {
      role = "vision";
      const withImage = imageNeeded
        ? required
        : mergeRequirements(required, { modalities: ["image"] });
      return { kind: "resolved", role, required: withImage };
    }

    // Mapped to vision but neither condition holds — demote to default.
    if (mappedRole === "vision") {
      return {
        kind: "resolved",
        role: "default",
        required,
      };
    }
  }

  return { kind: "resolved", role, required };
}

/**
 * Look up the primary catalog capability for a role route, if present.
 * Used before specialized resolution so vision fallback can see primary image support.
 */
export function primaryCapabilityForRole(
  policy: ModelPolicy,
  role: ModelRole,
  findCapability: (
    providerProfileId: RoleRoute["providerProfileId"],
    providerId: RoleRoute["providerId"],
    modelId: RoleRoute["modelId"],
  ) => ModelCapability | undefined,
): ModelCapability | null {
  const route = roleRouteFor(policy, role);
  if (route === undefined) {
    return null;
  }
  return findCapability(route.providerProfileId, route.providerId, route.modelId) ?? null;
}
