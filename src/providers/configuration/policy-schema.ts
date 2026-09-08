/**
 * Zod parse for ModelPolicy JSON at the configuration boundary.
 */

import { z } from "zod";

import { brandedString } from "../../domain/foundation/branded-schema.ts";
import { modelId, providerId } from "../../domain/foundation/identity.ts";
import { DEFAULT_INTENT_ROLE_MAP, type ModelPolicy, REASONING_EFFORTS } from "./policy.ts";
import { FAST_OPTIONS, MODEL_ROLES, SUBAGENT_PRESETS, WORK_INTENTS } from "./roles.ts";

const providerIdSchema = brandedString(providerId);
const modelIdSchema = brandedString(modelId);

export const budgetsSchema = z
  .object({
    attempts: z.number().int().positive().optional(),
    inputTokens: z.number().int().positive().optional(),
    outputTokens: z.number().int().positive().optional(),
    wallTimeMs: z.number().int().positive().optional(),
    cost: z.int().positive().optional(),
  })
  .strict()
  .default({});

const fallbackTargetSchema = z
  .object({
    providerProfileId: z.string().min(1).max(4_096),
    providerId: providerIdSchema,
    modelId: modelIdSchema,
  })
  .strict();

export const roleRouteBaseSchema = z
  .object({
    providerProfileId: z.string().min(1).max(4_096),
    providerId: providerIdSchema,
    modelId: modelIdSchema,
    reasoning: z.enum(REASONING_EFFORTS).default("provider-default"),
    fallbacks: z.array(fallbackTargetSchema).max(16).readonly().default([]),
    budgets: budgetsSchema,
  })
  .strict();

export const visionRoleRouteSchema = roleRouteBaseSchema.extend({
  use: z.enum(["fallback", "always", "off"]).default("fallback"),
});

export const advisorRoleRouteSchema = roleRouteBaseSchema.extend({
  use: z.enum(["explicit", "evaluated", "off"]).default("explicit"),
});

export const MODEL_POLICY_SCHEMA_VERSION = 2;
export const MAX_MODEL_DEFINITIONS = 1_000;
export const MAX_WORKFLOW_MODEL_STEPS = 256;
export const contributionIdentitySchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[a-zA-Z0-9._/-]+:[a-zA-Z0-9._/-]+$/);
export const nodeIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._/-]+$/)
  .refine(
    (key) => !["__proto__", "constructor", "prototype"].includes(key),
    "Reserved node identity.",
  );
const revisionMetadata = {
  definitionRevision: z.string().min(1).max(256).optional(),
  schemaRevision: z.number().int().nonnegative().optional(),
};
function boundedRecord<K extends z.ZodType<string>, V extends z.ZodType>(
  key: K,
  value: V,
  maximum: number,
) {
  return z.preprocess(
    (input, context) => {
      // Zod's record parser intentionally skips __proto__; reject it before that projection.
      if (input !== null && typeof input === "object" && Object.hasOwn(input, "__proto__"))
        context.addIssue({ code: "custom", message: "Reserved record identity." });
      return input;
    },
    z
      .record(key, value)
      .refine(
        (record) => Object.keys(record).length <= maximum,
        `At most ${maximum} entries are allowed.`,
      ),
  );
}
export const fastRoleSettingsSchema = z.strictObject({
  default: roleRouteBaseSchema.optional(),
  options: z.partialRecord(z.enum(FAST_OPTIONS), roleRouteBaseSchema).optional(),
  use: z
    .strictObject({
      memory: z.enum(["evaluated", "off"]).optional(),
      compaction: z.enum(["evaluated", "off"]).optional(),
    })
    .optional(),
});
export const agentPreferenceSchema = z.strictObject({
  route: roleRouteBaseSchema.optional(),
  preset: z.enum(["default", ...SUBAGENT_PRESETS]).optional(),
  ...revisionMetadata,
});
export const subagentRoleSettingsSchema = z.strictObject({
  default: roleRouteBaseSchema.optional(),
  presets: z.partialRecord(z.enum(SUBAGENT_PRESETS), roleRouteBaseSchema).optional(),
  agents: boundedRecord(
    contributionIdentitySchema,
    agentPreferenceSchema,
    MAX_MODEL_DEFINITIONS,
  ).optional(),
});
export const workflowPreferenceSchema = z.strictObject({
  default: roleRouteBaseSchema.optional(),
  steps: boundedRecord(
    nodeIdentitySchema,
    roleRouteBaseSchema,
    MAX_WORKFLOW_MODEL_STEPS,
  ).optional(),
  ...revisionMetadata,
});
export const workflowRoleSettingsSchema = z.strictObject({
  default: roleRouteBaseSchema.optional(),
  definitions: boundedRecord(
    contributionIdentitySchema,
    workflowPreferenceSchema,
    MAX_MODEL_DEFINITIONS,
  ).optional(),
});
export type FastRoleSettings = z.infer<typeof fastRoleSettingsSchema>;
export type SubagentRoleSettings = z.infer<typeof subagentRoleSettingsSchema>;
export type WorkflowRoleSettings = z.infer<typeof workflowRoleSettingsSchema>;

export const intentMapSchema = z
  .strictObject({
    coding: z.literal("default"),
    read: z.literal("default"),
    toolRouting: z.literal("default"),
    edit: z.literal("default"),
    planning: z.enum(MODEL_ROLES),
    deepReview: z.enum(MODEL_ROLES),
    verification: z.enum(MODEL_ROLES),
    visualUnderstanding: z.enum(MODEL_ROLES),
    independentCritique: z.enum(MODEL_ROLES),
    compression: z.literal("fast"),
    memory: z.literal("fast"),
  })
  .default({ ...DEFAULT_INTENT_ROLE_MAP });

export const modelRoleSettingsSchema = z.strictObject({
  default: roleRouteBaseSchema.optional(),
  fast: fastRoleSettingsSchema.optional(),
  subagents: subagentRoleSettingsSchema.optional(),
  workflows: workflowRoleSettingsSchema.optional(),
  plan: roleRouteBaseSchema.optional(),
  vision: visionRoleRouteSchema.optional(),
  advisor: advisorRoleRouteSchema.optional(),
});
export const modelPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(MODEL_POLICY_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  roles: modelRoleSettingsSchema,
  intents: intentMapSchema,
});
export type ModelPreferences = z.infer<typeof modelPreferencesSchema>;
export const EMPTY_MODEL_PREFERENCES: ModelPreferences = {
  schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
  revision: 0,
  roles: {},
  intents: DEFAULT_INTENT_ROLE_MAP,
};
const modelPolicySchema = z.strictObject({
  roles: modelRoleSettingsSchema.extend({ default: roleRouteBaseSchema }),
  intents: intentMapSchema,
});

/** Capture the main selection once. Saved supporting roles cannot replace it. */
export function bindModelPreferences(
  preferences: ModelPreferences,
  main: ModelPolicy["roles"]["default"],
): ModelPolicy {
  return { roles: { ...preferences.roles, default: main }, intents: preferences.intents };
}

export type ModelPolicyParseError = {
  readonly code: "invalid-model-policy";
  readonly path: string;
  readonly message: string;
};

export function parseModelPolicy(
  input: unknown,
):
  | { readonly ok: true; readonly value: ModelPolicy }
  | { readonly ok: false; readonly error: ModelPolicyParseError } {
  const result = modelPolicySchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: {
        code: "invalid-model-policy",
        path: issue?.path.join(".") ?? "",
        message: issue?.message ?? "invalid",
      },
    };
  }
  return { ok: true, value: result.data };
}

/** Ensures every work intent appears in DEFAULT_INTENT_ROLE_MAP (compile + runtime). */
export function assertDefaultIntentMapComplete(): void {
  for (const intent of WORK_INTENTS) {
    if (!(intent in DEFAULT_INTENT_ROLE_MAP)) {
      throw new Error(`missing default intent role for ${intent}`);
    }
  }
}

export { modelPolicySchema };

export type ParsedRoleRoute = z.infer<typeof roleRouteBaseSchema>;
export type ParsedRoleBudgets = z.infer<typeof budgetsSchema>;
export type ParsedModelRoleSettings = z.infer<typeof modelRoleSettingsSchema>;
