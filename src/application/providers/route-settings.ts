/** Bounded route management through the model-settings owner. Inspection has no effect ports. */
import { z } from "zod";
import {
  type NamedRouteDefinition,
  namedRouteCandidateSchema,
  namedRouteIdSchema,
  namedRouteRegistrySchema,
} from "../../providers/configuration/named-route.ts";
import {
  type NamedRouteRequest,
  type RouteCandidateFacts,
  resolveNamedRoute,
  routeCandidateKey,
  routeEvaluationSchema,
} from "../../providers/routing/named-route.ts";
import type { ModelSettingsSnapshot, ModelSettingsStore } from "./model-settings.ts";

const id = namedRouteIdSchema;
const revision = z.string().min(1).nullable();
const simulation = z.strictObject({
  target: namedRouteCandidateSchema,
  quota: z.enum(["available", "exhausted", "unknown", "stale"]).optional(),
  lifecycle: z.enum(["active", "paused", "draining"]).optional(),
  credential: z.enum(["declared", "missing", "revoked"]).optional(),
  trusted: z.boolean().optional(),
  allowed: z.boolean().optional(),
  includedEnforced: z.boolean().optional(),
  maximumCostMicros: z.number().int().nonnegative().nullable().optional(),
  fast: z.enum(["supported", "unsupported", "unknown"]).optional(),
});
export const routeSettingsRequests = [
  z.strictObject({ kind: z.literal("route-list") }),
  z.strictObject({
    kind: z.literal("route-inspect"),
    id,
    evaluation: routeEvaluationSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("route-explain"),
    id,
    evaluation: routeEvaluationSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("route-simulate"),
    id,
    facts: z.array(simulation).max(17),
    evaluation: routeEvaluationSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("route-validate"), definitions: z.unknown() }),
  z.strictObject({
    kind: z.literal("route-save"),
    definitions: z.unknown(),
    expectedRevision: revision,
  }),
  z.strictObject({ kind: z.literal("route-reset"), id, expectedRevision: revision }),
] as const;
export type RouteSettingsRequest = z.infer<(typeof routeSettingsRequests)[number]>;
export function isRouteSettingsRequest(request: { kind: string }): request is RouteSettingsRequest {
  return routeSettingsRequests.some((schema) => schema.shape.kind.value === request.kind);
}
export function validateRouteDefinitions(raw: unknown, facts: readonly RouteCandidateFacts[]) {
  const parsed = namedRouteRegistrySchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false as const,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".").slice(0, 512),
        code: issue.code,
      })),
    };
  const errors: { path: string; code: string }[] = [];
  for (const [index, route] of parsed.data.entries())
    for (const [candidateIndex, candidate] of [route.primary, ...route.alternatives].entries()) {
      if (
        !facts.some(
          (fact) =>
            fact.target.connectionId === candidate.connectionId &&
            fact.target.providerId === candidate.providerId &&
            fact.target.modelId === candidate.modelId &&
            fact.target.variant === candidate.variant &&
            fact.capability !== null &&
            fact.transportId !== "",
        )
      )
        errors.push({
          path: `${index}.${candidateIndex === 0 ? "primary" : `alternatives.${candidateIndex - 1}`}`,
          code: "target-unqualified",
        });
    }
  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, definitions: parsed.data };
}
export async function executeRouteSettings(
  request: RouteSettingsRequest,
  snapshot: ModelSettingsSnapshot,
  store: ModelSettingsStore,
  signal?: AbortSignal,
) {
  const routes = snapshot.namedRoutes ?? [];
  const facts = snapshot.routeFacts ?? [];
  if (request.kind === "route-list")
    return {
      kind: "route-list" as const,
      routes,
      fileRevision: snapshot.fileRevision,
      configurationGeneration: snapshot.generation,
    };
  if (
    request.kind === "route-inspect" ||
    request.kind === "route-explain" ||
    request.kind === "route-simulate"
  ) {
    const definition = routes.find((route) => route.id === request.id);
    const supplied =
      request.kind === "route-simulate"
        ? facts.map((fact) => {
            const override = request.facts.find(
              (entry) => routeCandidateKey(entry.target) === routeCandidateKey(fact.target),
            );
            return override
              ? {
                  ...fact,
                  quota: override.quota ?? fact.quota,
                  lifecycle: override.lifecycle ?? fact.lifecycle,
                  credential: override.credential ?? fact.credential,
                  trusted: override.trusted ?? fact.trusted,
                  allowed: override.allowed ?? fact.allowed,
                  includedEnforced: override.includedEnforced ?? fact.includedEnforced,
                  maximumCostMicros:
                    override.maximumCostMicros === undefined
                      ? fact.maximumCostMicros
                      : override.maximumCostMicros,
                  fast: override.fast ?? fact.fast,
                }
              : fact;
          })
        : facts;
    const input: NamedRouteRequest = {
      configurationGeneration: snapshot.generation,
      factsRevision: Math.max(0, ...facts.map((fact) => fact.revision)),
      ...(snapshot.preferences.processing ? { processing: snapshot.preferences.processing } : {}),
      ...request.evaluation,
    };
    return {
      kind: "route-inspection" as const,
      simulated: request.kind === "route-simulate",
      resolution: resolveNamedRoute(definition, supplied, input),
      fileRevision: snapshot.fileRevision,
    };
  }
  const proposed: unknown =
    request.kind === "route-reset"
      ? routes.filter((route) => route.id !== request.id)
      : request.definitions;
  const candidate = namedRouteRegistrySchema.safeParse(proposed);
  const available =
    candidate.success && store.routeFacts ? await store.routeFacts(candidate.data, signal) : facts;
  if (signal?.aborted) return { kind: "failed" as const, code: "cancelled" };
  const validation =
    request.kind === "route-reset" && candidate.success
      ? { ok: true as const, definitions: candidate.data }
      : validateRouteDefinitions(proposed, available);
  if (request.kind === "route-validate" || !validation.ok)
    return { kind: "route-validation" as const, ...validation };
  if (snapshot.scope !== "user")
    return { kind: "failed" as const, code: "route-definitions-global-only" };
  if (request.expectedRevision !== snapshot.fileRevision)
    return { kind: "failed" as const, code: "stale-settings" };
  for (const next of validation.definitions) {
    const prior = routes.find((route) => route.id === next.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(next) && next.revision <= prior.revision)
      return { kind: "failed" as const, code: "route-revision-must-advance" };
  }
  if (!store.writeRoutes) return { kind: "failed" as const, code: "route-save-unavailable" };
  const written = await store.writeRoutes(validation.definitions, snapshot.fileRevision, signal);
  return written.kind === "written"
    ? {
        kind: "route-written" as const,
        revision: written.revision,
        receipt: written.receipt ?? null,
        definitions: validation.definitions,
      }
    : { kind: "failed" as const, code: written.code };
}
export type RouteDefinitionWriter = (
  definitions: readonly NamedRouteDefinition[],
  expectedRevision: string | null,
  signal?: AbortSignal,
) => ReturnType<ModelSettingsStore["write"]>;
