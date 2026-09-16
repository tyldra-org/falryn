/** Bounded, body-free native provenance retained with the admitted turn. */
import { z } from "zod";
import { digestSchema } from "../extensions/identity.ts";
import {
  INSTRUCTION_SOURCE_LIMITS,
  instructionDirectorySchema,
  instructionSourceIdentitySchema,
  SOURCE_ORIGINS,
} from "./instruction-sources.ts";

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
