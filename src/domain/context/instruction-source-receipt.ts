/** Bounded, body-free native provenance retained with the admitted turn. */
import { z } from "zod";
import { digestSchema } from "../extensions/identity.ts";
import {
  INSTRUCTION_SOURCE_LIMITS,
  instructionDirectorySchema,
  instructionSourceIdentitySchema,
  SOURCE_ORIGINS,
} from "./instruction-sources.ts";
import { PROMPT_TOKEN_ESTIMATOR } from "./prompt-composition.ts";

export const sourceDecisionSchema = z.strictObject({
  identity: instructionSourceIdentitySchema,
  origin: z.enum(SOURCE_ORIGINS),
  scope: instructionDirectorySchema,
  source: digestSchema,
  digest: digestSchema.nullable(),
  kind: z.enum(["instruction", "skill", "prompt"]),
  name: z.string().min(1).max(256),
  namespace: z.string().min(1).max(256),
  state: z.enum(["selected", "shadowed", "excluded", "conflicting"]),
  reason: z.string().min(1).max(256),
});

/**
 * Context one admission contributed to the request, estimated with `estimatePromptTokens`.
 */
export const contextContributionSchema = z.strictObject({
  bytes: z.int().nonnegative(),
  tokens: z.int().nonnegative(),
});
export type ContextContribution = z.infer<typeof contextContributionSchema>;

/**
 * One automatic skill routing decision (#136). A loaded route names the admitted source,
 * its digest and the body bytes admitted into the request; others carry only a reason.
 * Receipts written since #1191 also carry the estimated body tokens of a loaded route and
 * the route's own line in the routing section; older receipts lack both.
 */
export const skillRouteSchema = z.strictObject({
  name: z.string().min(1).max(64),
  decision: z.enum(["loaded", "recommended", "unavailable"]),
  reason: z.string().min(1).max(256),
  source: digestSchema.nullable(),
  digest: digestSchema.nullable(),
  bytes: z.int().nonnegative().nullable(),
  tokens: z.int().nonnegative().nullable().optional(),
  listing: contextContributionSchema.optional(),
});
export type SkillRouteFact = z.infer<typeof skillRouteSchema>;
export const skillRoutingSchema = z.strictObject({
  /** Automatically eligible candidates in scope that routing considered. */
  candidates: z.int().nonnegative(),
  routes: z.array(skillRouteSchema).max(INSTRUCTION_SOURCE_LIMITS.pageEntries),
  /** The whole routing section, including text no single route owns (#1191). */
  section: contextContributionSchema.nullable().optional(),
  /** Names the estimate behind every `tokens` figure in this block (#1191). */
  estimator: z.literal(PROMPT_TOKEN_ESTIMATOR).optional(),
});
export type SkillRoutingFact = z.infer<typeof skillRoutingSchema>;

export const instructionSourceReceiptSchema = z.strictObject({
  generation: digestSchema,
  previousGeneration: digestSchema.nullable(),
  configuration: z.string().min(1).max(256),
  workspace: z.string().min(1).max(256),
  scope: z.strictObject({
    root: z.string().min(1).max(256),
    directory: instructionDirectorySchema,
    execution: z.string().min(1).max(256),
    kind: z.enum(["main", "child", "workflow"]),
  }),
  contentDigest: digestSchema,
  sources: z.array(sourceDecisionSchema).max(INSTRUCTION_SOURCE_LIMITS.pageEntries),
  omitted: z.int().nonnegative(),
  reload: z.enum(["committed", "unchanged", "rejected"]),
  observedGeneration: digestSchema.nullable(),
  rejection: z.string().max(256).nullable(),
  rejectedSource: digestSchema.nullable().optional(),
  contentChanged: z.boolean(),
  reused: z.boolean(),
  /** Automatic skill routing for this admission; absent when routing did not run. */
  skills: skillRoutingSchema.optional(),
});
export type InstructionSourceReceipt = z.infer<typeof instructionSourceReceiptSchema>;

export const instructionRejectionSchema = z.strictObject({
  scope: instructionSourceReceiptSchema.shape.scope,
  configuration: z.string().min(1).max(256),
  code: z.string().min(1).max(512),
  observedGeneration: digestSchema.nullable(),
  rejectedSource: digestSchema.nullable(),
  sources: z.array(sourceDecisionSchema).max(INSTRUCTION_SOURCE_LIMITS.pageEntries),
});
export type InstructionRejection = z.infer<typeof instructionRejectionSchema>;
