/**
 * Model role policy: role routes, intent maps, budgets, and fallback entries.
 *
 * Exact configuration keys may migrate; this module owns the typed policy the
 * router consumes and the Zod parse for untrusted config JSON.
 */

import type { ProviderModelIdentity } from "../catalog/model-identity.ts";
import type {
  ParsedModelRoleSettings,
  ParsedRoleBudgets,
  ParsedRoleRoute,
} from "./policy-schema.ts";
import {
  type FastOption,
  MODEL_ROLES,
  type ModelRole,
  WORK_INTENTS,
  type WorkIntent,
} from "./roles.ts";

export const REASONING_EFFORTS = [
  "minimal",
  "balanced",
  "deep",
  "max",
  "provider-default",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export type RoleBudgets = ParsedRoleBudgets;
export type FallbackTarget = ProviderModelIdentity;
export type RoleRoute = ParsedRoleRoute;

export type VisionRoleRoute = RoleRoute & {
  readonly use: "fallback" | "always" | "off";
};

export type AdvisorRoleRoute = RoleRoute & {
  readonly use: "explicit" | "evaluated" | "off";
};

export type ModelRoleRoutes = ParsedModelRoleSettings & { readonly default: RoleRoute };

export type IntentRoleMap = {
  readonly [K in WorkIntent]: ModelRole;
};

/** Design-table defaults: intent → generative role. */
export const DEFAULT_INTENT_ROLE_MAP = {
  coding: "default",
  read: "default",
  toolRouting: "default",
  edit: "default",
  planning: "plan",
  deepReview: "default",
  verification: "default",
  visualUnderstanding: "vision",
  independentCritique: "advisor",
  compression: "fast",
  memory: "fast",
} as const satisfies IntentRoleMap;

export type ModelPolicy = {
  readonly roles: ModelRoleRoutes;
  readonly intents: IntentRoleMap;
};

export function isCompleteIntentMap(value: unknown): value is IntentRoleMap {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const intent of WORK_INTENTS) {
    const role = record[intent];
    if (typeof role !== "string" || !(MODEL_ROLES as readonly string[]).includes(role)) {
      return false;
    }
  }
  return true;
}

export function resolveIntentRole(policy: ModelPolicy, intent: WorkIntent): ModelRole {
  if (intent === "coding" || intent === "read" || intent === "toolRouting" || intent === "edit")
    return "default";
  return policy.intents[intent];
}

/** A Fast option is explicit operation context, never inferred from a model name. */
export function fastOptionForIntent(intent: WorkIntent | null): FastOption | undefined {
  return intent === "compression" ? "compaction" : intent === "memory" ? "memory" : undefined;
}

export function roleRouteFor(
  policy: ModelPolicy,
  role: ModelRole,
  option?: FastOption,
): RoleRoute | VisionRoleRoute | AdvisorRoleRoute | undefined {
  switch (role) {
    case "default":
      return policy.roles.default;
    case "fast":
      return (
        (option === undefined ? undefined : policy.roles.fast?.options?.[option]) ??
        policy.roles.fast?.default ??
        policy.roles.default
      );
    case "subagents":
      return policy.roles.subagents?.default ?? policy.roles.default;
    case "workflows":
      return policy.roles.workflows?.default ?? policy.roles.default;
    case "plan":
      return policy.roles.plan ?? policy.roles.default;
    case "vision":
      return policy.roles.vision;
    case "advisor":
      return policy.roles.advisor;
  }
}

export function isRoleDisabled(
  route: RoleRoute | VisionRoleRoute | AdvisorRoleRoute,
  role: ModelRole,
): boolean {
  return (role === "vision" || role === "advisor") && "use" in route && route.use === "off";
}
