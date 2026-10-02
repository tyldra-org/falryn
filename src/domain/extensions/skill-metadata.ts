/**
 * The SKILL.md entrypoint contract (#136), shared by packaged and standalone skills.
 *
 * The Agent Skills header is the portable floor. Two host controls decide who may
 * invoke a skill, as strict booleans: a malformed restriction never becomes a
 * permissive default. Fields that would change how a skill executes are recognized,
 * and a skill declaring one is unavailable until its owner honors it, rather than
 * silently run without it. Everything else is inert metadata.
 */
import { z } from "zod";

export const skillHeaderSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1_024),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    /** An inspectable compatibility hint only; it grants nothing. */
    "allowed-tools": z.string().optional(),
  })
  .catchall(z.unknown());

/** Who may invoke a skill: an admitted user action, and automatic selection. */
export type SkillInvocation = { readonly user: boolean; readonly automatic: boolean };

const INVOCATION_FIELDS = ["disable-model-invocation", "user-invocable"] as const;
/** Recognized execution-affecting fields this build does not yet honor (#1181). */
export const SKILL_EXECUTION_FIELDS = ["model", "effort", "context", "agent", "hooks"] as const;

export type SkillEntrypoint =
  | {
      readonly ok: true;
      readonly name: string;
      readonly description: string;
      readonly invocation: SkillInvocation;
      /** The first unsupported execution-affecting field, or null. */
      readonly unsupported: (typeof SKILL_EXECUTION_FIELDS)[number] | null;
    }
  | {
      readonly ok: false;
      readonly problem: "malformed-metadata" | "name-mismatch" | "malformed-eligibility";
      /**
       * The frontmatter field at fault, for diagnosis (#1124): a header field, an
       * invocation control, or null when the header as a whole is not an object.
       */
      readonly field: string | null;
    };

/** Read decoded frontmatter for the bundle directory it was found in. */
export function readSkillEntrypoint(
  metadata: Readonly<Record<string, unknown>>,
  directory: string,
): SkillEntrypoint {
  const header = skillHeaderSchema.safeParse(metadata);
  if (!header.success) {
    const field = header.error.issues[0]?.path[0];
    return {
      ok: false,
      problem: "malformed-metadata",
      field: typeof field === "string" ? field : null,
    };
  }
  if (header.data.name !== directory) return { ok: false, problem: "name-mismatch", field: "name" };
  const eligibility = INVOCATION_FIELDS.find(
    (field) => Object.hasOwn(metadata, field) && typeof metadata[field] !== "boolean",
  );
  if (eligibility !== undefined)
    return { ok: false, problem: "malformed-eligibility", field: eligibility };
  return {
    ok: true,
    name: header.data.name,
    description: header.data.description,
    invocation: {
      user: metadata["user-invocable"] !== false,
      automatic: metadata["disable-model-invocation"] !== true,
    },
    unsupported: SKILL_EXECUTION_FIELDS.find((field) => Object.hasOwn(metadata, field)) ?? null,
  };
}
