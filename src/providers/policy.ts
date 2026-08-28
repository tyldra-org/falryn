/**
 * Model role policy: role routes, intent maps, budgets, and fallback entries.
 *
 * Exact configuration keys may migrate; this module owns the typed policy the
 * router consumes and the Zod parse for untrusted config JSON.
 */

import type { ModelId, ProviderId } from "../domain/identity.ts";
import { MODEL_ROLES, type ModelRole, WORK_INTENTS, type WorkIntent } from "./roles.ts";

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

export type RoleBudgets = {
  readonly attempts?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly wallTimeMs?: number;
  readonly cost?: number;
};

export type FallbackTarget = {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
};

export type RoleRoute = {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly reasoning: ReasoningEffort;
  readonly fallbacks: readonly FallbackTarget[];
  readonly budgets: RoleBudgets;
};

export type VisionRoleRoute = RoleRoute & {
  readonly use: "fallback" | "always" | "off";
};

export type AdvisorRoleRoute = RoleRoute & {
  readonly use: "explicit" | "evaluated" | "off";
};

export type CompactRoleRoute = RoleRoute & {
  readonly use: "evaluated" | "off";
};

export type ModelRoleRoutes = {
  readonly default: RoleRoute;
  readonly "fast-read"?: RoleRoute;
  readonly "fast-edit"?: RoleRoute;
  readonly plan?: RoleRoute;
  readonly commit?: RoleRoute;
  readonly vision?: VisionRoleRoute;
  readonly advisor?: AdvisorRoleRoute;
  readonly compact?: CompactRoleRoute;
};

export type IntentRoleMap = {
  readonly [K in WorkIntent]: ModelRole;
};

/** Design-table defaults: intent → generative role. */
export const DEFAULT_INTENT_ROLE_MAP = {
  coding: "default",
  read: "fast-read",
  toolRouting: "fast-read",
  fastEdit: "fast-edit",
  planning: "plan",
  deepReview: "default",
  verification: "default",
  visualUnderstanding: "vision",
  independentCritique: "advisor",
  compression: "compact",
  memory: "compact",
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
  return policy.intents[intent];
}

export function roleRouteFor(
  policy: ModelPolicy,
  role: ModelRole,
): RoleRoute | VisionRoleRoute | AdvisorRoleRoute | CompactRoleRoute | undefined {
  switch (role) {
    case "default":
      return policy.roles.default;
    case "fast-read":
      return policy.roles["fast-read"] ?? policy.roles.default;
    case "fast-edit":
      return policy.roles["fast-edit"] ?? policy.roles.default;
    case "plan":
      return policy.roles.plan ?? policy.roles.default;
    case "commit":
      return policy.roles.commit ?? policy.roles.default;
    case "vision":
      return policy.roles.vision;
    case "advisor":
      return policy.roles.advisor;
    case "compact":
      return policy.roles.compact;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function isRoleDisabled(
  route: RoleRoute | VisionRoleRoute | AdvisorRoleRoute | CompactRoleRoute,
  role: ModelRole,
): boolean {
  switch (role) {
    case "vision":
      return "use" in route && route.use === "off";
    case "advisor":
      return "use" in route && route.use === "off";
    case "compact":
      return "use" in route && route.use === "off";
    case "default":
    case "fast-read":
    case "fast-edit":
    case "plan":
    case "commit":
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}
