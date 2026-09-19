/** Configuration-to-admission bridge. All inputs are already loaded, secret-free declarations. */
import type { ConfigurationValues } from "../../domain/configuration/index.ts";
import { modelId, providerId } from "../../domain/foundation/identity.ts";
import { resolveProcessingPreference } from "../../domain/sessions/model-processing.ts";
import {
  freezeRouteValue,
  type NamedRouteReceipt,
  type RouteCandidateFacts,
  resolveNamedRoute,
} from "../routing/named-route.ts";
import { type NamedRouteDefinition, namedRouteRegistrySchema } from "./named-route.ts";
import type { RoleRoute } from "./policy.ts";
import {
  concreteModelPreferencesSchema,
  type ModelPreferences,
  type StoredModelPreferences,
} from "./policy-schema.ts";

export const NAMED_ROUTES_CONFIGURATION_KEY = "models.routes";
export function hasNamedRouteReferences(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ("kind" in value && value.kind === "route" && "routeId" in value) return true;
  return Object.values(value).some(hasNamedRouteReferences);
}
export class UnresolvedNamedRouteError extends Error {
  constructor(
    readonly routeId: string,
    readonly receipt: NamedRouteReceipt | null,
  ) {
    super(receipt === null ? "route-missing" : "route-unavailable");
    this.name = "UnresolvedNamedRouteError";
  }
}
export function namedRoutesFrom(values: ConfigurationValues): readonly NamedRouteDefinition[] {
  const parsed = namedRouteRegistrySchema.safeParse(
    (values[NAMED_ROUTES_CONFIGURATION_KEY] as { definitions?: unknown } | undefined)
      ?.definitions ?? [],
  );
  return parsed.success ? parsed.data : [];
}
export function routeFromNamedReceipt(
  receipt: NamedRouteReceipt,
  reasoning: RoleRoute["reasoning"],
): RoleRoute {
  const primary = receipt.eligible[0];
  if (!primary || primary.waitMs > 0) throw new UnresolvedNamedRouteError(receipt.routeId, receipt);
  return freezeRouteValue({
    providerProfileId: primary.target.connectionId,
    providerId: providerId.from(primary.target.providerId),
    modelId: modelId.from(primary.target.modelId),
    reasoning,
    processing: receipt.processing,
    budgets: {
      attempts: receipt.definition.policy.maxAttempts,
      ...(receipt.definition.policy.maxCostMicros === undefined
        ? {}
        : { cost: receipt.definition.policy.maxCostMicros }),
    },
    // Qualified alternates remain in the receipt; old fallback machinery must not execute them.
    fallbacks: [],
    namedRoute: receipt,
  });
}

/** A new call binds a new generation; previously returned routes never refer to mutable config. */
export function bindNamedModelPreferences(
  preferences: StoredModelPreferences,
  routes: readonly NamedRouteDefinition[],
  facts: readonly RouteCandidateFacts[],
  generation: number,
): ModelPreferences {
  const receipts = new Map<string, NamedRouteReceipt>();
  const unavailable: NonNullable<ModelPreferences["unavailableRoutes"]>[number][] = [];
  function visit(value: unknown, path: readonly string[]): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((entry, index) => visit(entry, [...path, String(index)]));
    if (
      "kind" in value &&
      value.kind === "route" &&
      "routeId" in value &&
      typeof value.routeId === "string"
    ) {
      const target = value as import("./named-route.ts").NamedRouteReference;
      const definition = routes.find((entry) => entry.id === target.routeId);
      const result = resolveNamedRoute(definition, facts, {
        configurationGeneration: generation,
        factsRevision: Math.max(0, ...facts.map((entry) => entry.revision)),
        reasoning: target.reasoning,
        processing: resolveProcessingPreference([target.processing, preferences.processing]),
      });
      if (result.kind === "unresolved" || result.receipt.eligible[0]?.waitMs) {
        unavailable.push({ path, routeId: target.routeId, receipt: result.receipt });
        return undefined;
      }
      receipts.set(JSON.stringify(path), result.receipt);
      const { namedRoute: _receipt, ...route } = routeFromNamedReceipt(
        result.receipt,
        target.reasoning,
      );
      return { ...route, ...("use" in value ? { use: value.use } : {}) };
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entry]) => !(key === "kind" && entry === "concrete"))
        .map(([key, entry]) => [key, visit(entry, [...path, key])]),
    );
  }
  const bound = concreteModelPreferencesSchema.parse(visit(preferences, []));
  function attach(value: unknown, path: readonly string[]): void {
    if (value === null || typeof value !== "object") return;
    const receipt = receipts.get(JSON.stringify(path));
    if (receipt) Object.assign(value, { namedRoute: receipt });
    else for (const [key, entry] of Object.entries(value)) attach(entry, [...path, key]);
  }
  attach(bound, []);
  return freezeRouteValue({
    ...bound,
    ...(unavailable.length > 0 ? { unavailableRoutes: unavailable } : {}),
  });
}
