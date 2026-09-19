/** Recovery/consumer schema for captured selections; never accepted as authored settings. */
import { z } from "zod";
import { freezeRouteValue, namedRouteReceiptSchema } from "../routing/named-route.ts";
import { roleRouteBaseSchema } from "./policy-schema.ts";
export const boundRoleRouteSchema = roleRouteBaseSchema
  .extend({ namedRoute: namedRouteReceiptSchema.optional() })
  .superRefine((route, context) => {
    if (!route.namedRoute) return;
    const primary = route.namedRoute.eligible[0]?.target;
    if (
      !primary ||
      primary.connectionId !== route.providerProfileId ||
      primary.providerId !== String(route.providerId) ||
      primary.modelId !== String(route.modelId) ||
      route.fallbacks.length !== 0
    )
      context.addIssue({
        code: "custom",
        path: ["namedRoute"],
        message: "Captured route destination does not match its receipt.",
      });
  });
export const modelSelectionSchema = z
  .strictObject({
    kind: z.literal("route"),
    route: boundRoleRouteSchema,
    source: z.string().min(1).max(256),
    chain: z
      .array(z.strictObject({ source: z.string().min(1).max(256), route: boundRoleRouteSchema }))
      .max(32),
    policyRevision: z.int().nonnegative(),
    configurationGeneration: z.int().nonnegative(),
    definitions: z
      .array(
        z.strictObject({
          id: z.string().max(256),
          revision: z.string().max(256),
          schemaRevision: z.int().nonnegative(),
        }),
      )
      .max(256),
    availability: z.enum(["available", "disabled", "unavailable", "incompatible"]),
    reason: z.string().nullable(),
  })
  .transform(freezeRouteValue);
