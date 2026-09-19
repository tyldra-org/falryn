/** Declarative destinations, never credentials or executable provider factories. */
import { z } from "zod";
import { processingPreferenceSchema } from "../../domain/sessions/model-processing.ts";
import { REASONING_EFFORTS } from "./policy.ts";

export const namedRouteIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const identity = z.string().min(1).max(256);
export const ROUTE_TRIGGERS = [
  "transport",
  "rate-limit",
  "timeout",
  "server",
  "quota-unavailable",
] as const;
export const namedRouteCandidateSchema = z.strictObject({
  connectionId: identity,
  providerId: identity,
  modelId: identity,
  variant: identity.optional(),
});
export const namedRoutePolicySchema = z.strictObject({
  strategy: z
    .enum(["ordered", "prefer-current", "prefer-availability", "strict-target"])
    .default("prefer-current"),
  maxWaitMs: z.number().int().min(0).max(300_000).default(0),
  triggers: z.array(z.enum(ROUTE_TRIGGERS)).max(ROUTE_TRIGGERS.length).default([]),
  maxAttempts: z.number().int().min(1).max(17).default(1),
  maxCostMicros: z.number().int().positive().optional(),
  billing: z.enum(["any", "included-only"]).default("any"),
  allowPremiumProcessing: z.boolean().default(false),
  maxSensitivity: z.enum(["public", "user-content", "sensitive"]).default("user-content"),
  requiredDisclosures: z.array(identity).max(16).default([]),
  trustedOnly: z.boolean().default(true),
});
export const namedRouteDefinitionSchema = z
  .strictObject({
    id: namedRouteIdSchema,
    label: z.string().min(1).max(128).optional(),
    revision: z.number().int().nonnegative(),
    primary: namedRouteCandidateSchema,
    alternatives: z.array(namedRouteCandidateSchema).max(16).default([]),
    policy: namedRoutePolicySchema.default(() => namedRoutePolicySchema.parse({})),
  })
  .superRefine((route, ctx) => {
    const seen = new Set<string>();
    for (const [index, candidate] of [route.primary, ...route.alternatives].entries()) {
      const key = JSON.stringify([
        candidate.connectionId,
        candidate.providerId,
        candidate.modelId,
        candidate.variant ?? null,
      ]);
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: index === 0 ? ["primary"] : ["alternatives", index - 1],
          message: "Duplicate route target.",
        });
      seen.add(key);
    }
    if (new Set(route.policy.triggers).size !== route.policy.triggers.length)
      ctx.addIssue({ code: "custom", path: ["policy", "triggers"], message: "Duplicate trigger." });
  });
export const namedRouteRegistrySchema = z
  .array(namedRouteDefinitionSchema)
  .max(64)
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    for (const [index, route] of routes.entries()) {
      if (seen.has(route.id))
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate route identity." });
      seen.add(route.id);
    }
  });
export const namedRouteReferenceSchema = z.strictObject({
  kind: z.literal("route"),
  routeId: namedRouteIdSchema,
  reasoning: z.enum(REASONING_EFFORTS).default("provider-default"),
  processing: processingPreferenceSchema.optional(),
});
export type NamedRouteDefinition = z.infer<typeof namedRouteDefinitionSchema>;
export type NamedRouteCandidate = z.infer<typeof namedRouteCandidateSchema>;
export type NamedRouteReference = z.infer<typeof namedRouteReferenceSchema>;
export type NamedRoutePolicy = z.infer<typeof namedRoutePolicySchema>;
