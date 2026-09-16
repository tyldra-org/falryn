import { z } from "zod";
import { objectKey } from "../../config/index.ts";
import {
  sourcePathSchema,
  sourcePreferencesSchema,
} from "../../domain/context/instruction-sources.ts";

/** Explicit source registration; automatic location discovery belongs to its native loader. */
export const configuredInstructionSourcesSchema = z
  .strictObject({
    version: z.literal(1),
    entries: z
      .array(
        z.strictObject({
          root: z.string().min(1).max(256),
          path: sourcePathSchema,
          scope: z
            .string()
            .max(4_096)
            .refine((s) => s === "" || sourcePathSchema.safeParse(s).success),
          enabled: z.boolean(),
          references: z.array(sourcePathSchema).max(64),
          conflicts: z.array(sourcePathSchema).max(64).default([]),
        }),
      )
      .max(1_024),
  })
  .superRefine((value, ctx) => {
    const keys = value.entries.map((entry) => `${entry.root}:${entry.path}`);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Duplicate instruction source." });
  });

export const INSTRUCTION_CONFIGURATION_KEYS = [
  objectKey({
    path: "instructions.sources",
    summary:
      "Explicit instruction paths under the configuration home or an admitted named workspace root. Registration grants no executable authority.",
    objectSchema: configuredInstructionSourcesSchema,
    defaultValue: { version: 1, entries: [] },
    scopes: ["user", "profile"],
    applicationClass: "next-operation",
    sensitivity: "sensitive",
  }),
  objectKey({
    path: "instructions.preferences",
    summary:
      "Versioned source choices and deny-only invocation restrictions, bound to normalized source identity.",
    objectSchema: sourcePreferencesSchema,
    defaultValue: { version: 1, choices: [], restrictions: [] },
    scopes: ["user", "project", "profile"],
    applicationClass: "next-operation",
    sensitivity: "sensitive",
  }),
] as const;
