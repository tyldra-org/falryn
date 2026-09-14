/** Read-only codecs for recoverable policy versions. They never authorize a write. */
import { z } from "zod";
import { DEFAULT_INTENT_ROLE_MAP } from "./policy.ts";
import {
  advisorRoleRouteSchema,
  fastRoleSettingsSchema,
  intentMapSchema,
  modelPreferencesSchema,
  roleRouteBaseSchema,
  subagentRoleSettingsSchema,
  visionRoleRouteSchema,
  workflowRoleSettingsSchema,
} from "./policy-schema.ts";
import { FAST_OPTIONS } from "./roles.ts";

export const LEGACY_ROLES = [
  "default",
  "compact",
  "vision",
  "plan",
  "advisor",
  "commit",
  "fast-read",
  "fast-edit",
] as const;
export const LEGACY_INTENTS = [
  "coding",
  "read",
  "toolRouting",
  "fastEdit",
  "planning",
  "deepReview",
  "verification",
  "visualUnderstanding",
  "independentCritique",
  "compression",
  "memory",
] as const;

// Follow the current registry when independent options land; retire only compaction.
const previousFastSchema = fastRoleSettingsSchema.extend({
  options: z.partialRecord(z.enum([...FAST_OPTIONS, "compaction"]), roleRouteBaseSchema).optional(),
  use: fastRoleSettingsSchema.shape.use
    .unwrap()
    .extend({
      compaction: z.enum(["evaluated", "off"]).optional(),
    })
    .optional(),
});
export const previousModelPreferencesSchema = modelPreferencesSchema.extend({
  schemaVersion: z.literal(2),
  roles: modelPreferencesSchema.shape.roles.extend({ fast: previousFastSchema.optional() }),
  intents: intentMapSchema
    .removeDefault()
    .extend({ compression: z.literal("fast") })
    .default({ ...DEFAULT_INTENT_ROLE_MAP, compression: "fast" }),
});
export const legacyPolicySchema = z.strictObject({
  schemaVersion: z.literal(1).optional(),
  revision: z.number().int().nonnegative().optional(),
  roles: z.strictObject({
    default: roleRouteBaseSchema,
    compact: roleRouteBaseSchema
      .extend({ use: z.enum(["evaluated", "off"]).default("evaluated") })
      .optional(),
    "fast-read": roleRouteBaseSchema.optional(),
    "fast-edit": roleRouteBaseSchema.optional(),
    commit: roleRouteBaseSchema.optional(),
    plan: roleRouteBaseSchema.optional(),
    vision: visionRoleRouteSchema.optional(),
    advisor: advisorRoleRouteSchema.optional(),
    fast: previousFastSchema
      .extend({
        subagents: subagentRoleSettingsSchema.optional(),
        workflows: workflowRoleSettingsSchema.optional(),
      })
      .optional(),
    subagents: subagentRoleSettingsSchema.optional(),
    workflows: workflowRoleSettingsSchema.optional(),
  }),
  intents: z.partialRecord(z.enum(LEGACY_INTENTS), z.enum(LEGACY_ROLES)).optional(),
});
export const storedModelPreferencesSchema = z.union([
  modelPreferencesSchema,
  previousModelPreferencesSchema,
  legacyPolicySchema,
]);
