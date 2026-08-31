/**
 * Zod parse for ModelPolicy JSON at the configuration boundary.
 */

import { z } from "zod";

import { brandedString } from "../domain/branded-schema.ts";
import { modelId, providerId } from "../domain/identity.ts";
import { DEFAULT_INTENT_ROLE_MAP, type ModelPolicy, REASONING_EFFORTS } from "./policy.ts";
import { MODEL_ROLES, WORK_INTENTS } from "./roles.ts";

const providerIdSchema = brandedString(providerId);
const modelIdSchema = brandedString(modelId);

const budgetsSchema = z
  .object({
    attempts: z.number().int().positive().optional(),
    inputTokens: z.number().int().positive().optional(),
    outputTokens: z.number().int().positive().optional(),
    wallTimeMs: z.number().int().positive().optional(),
    cost: z.number().positive().optional(),
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

const roleRouteBaseSchema = z
  .object({
    providerProfileId: z.string().min(1).max(4_096),
    providerId: providerIdSchema,
    modelId: modelIdSchema,
    reasoning: z.enum(REASONING_EFFORTS).default("provider-default"),
    fallbacks: z.array(fallbackTargetSchema).max(16).default([]),
    budgets: budgetsSchema,
  })
  .strict();

const visionRoleRouteSchema = roleRouteBaseSchema.extend({
  use: z.enum(["fallback", "always", "off"]).default("fallback"),
});

const advisorRoleRouteSchema = roleRouteBaseSchema.extend({
  use: z.enum(["explicit", "evaluated", "off"]).default("explicit"),
});

const compactRoleRouteSchema = roleRouteBaseSchema.extend({
  use: z.enum(["evaluated", "off"]).default("evaluated"),
});

const intentMapSchema = z
  .object({
    coding: z.enum(MODEL_ROLES),
    read: z.enum(MODEL_ROLES),
    toolRouting: z.enum(MODEL_ROLES),
    fastEdit: z.enum(MODEL_ROLES),
    planning: z.enum(MODEL_ROLES),
    deepReview: z.enum(MODEL_ROLES),
    verification: z.enum(MODEL_ROLES),
    visualUnderstanding: z.enum(MODEL_ROLES),
    independentCritique: z.enum(MODEL_ROLES),
    compression: z.enum(MODEL_ROLES),
    memory: z.enum(MODEL_ROLES),
  })
  .strict()
  .default({ ...DEFAULT_INTENT_ROLE_MAP });

const modelPolicySchema = z
  .object({
    roles: z
      .object({
        default: roleRouteBaseSchema,
        "fast-read": roleRouteBaseSchema.optional(),
        "fast-edit": roleRouteBaseSchema.optional(),
        plan: roleRouteBaseSchema.optional(),
        commit: roleRouteBaseSchema.optional(),
        vision: visionRoleRouteSchema.optional(),
        advisor: advisorRoleRouteSchema.optional(),
        compact: compactRoleRouteSchema.optional(),
      })
      .strict(),
    intents: intentMapSchema,
  })
  .strict();

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
  return { ok: true, value: result.data as ModelPolicy };
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
