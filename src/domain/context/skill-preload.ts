/**
 * Skills a child agent definition or a durable schedule names to preload (#1180).
 *
 * A preload is never a user choice: it is admitted with automatic eligibility, so a
 * manual-only or model-restricted skill cannot enter a child's or scheduled run's
 * context through it. A scheduled preload is pinned to the source and body digest
 * resolved when the schedule was bound; a pin that no longer matches refuses the
 * admission before the body is read.
 */
import { z } from "zod";
import { digestSchema } from "../extensions/identity.ts";
import { SKILL_NAME } from "./skill-invocation.ts";

export const SKILL_PRELOAD_LIMITS = Object.freeze({
  /** Skills one definition or schedule may name; each loads its complete body. */
  skills: 8,
});

export const skillNameSchema = z.string().min(1).max(64).regex(SKILL_NAME);

/** The skill names a child agent definition or schedule declares, without duplicates. */
export const skillPreloadNamesSchema = z
  .array(skillNameSchema)
  .min(1)
  .max(SKILL_PRELOAD_LIMITS.skills)
  .refine((names) => new Set(names).size === names.length, "duplicate-skill");

/** A skill resolved to the exact source and body digest that may load. */
export const skillPinSchema = z.strictObject({
  name: skillNameSchema,
  /** The instruction source key. */
  source: digestSchema,
  /** The complete `SKILL.md` body digest. */
  digest: digestSchema,
});
export type SkillPin = z.infer<typeof skillPinSchema>;

export type SkillPreload = {
  /** Which actor named the skills; recorded as the route reason, never as user origin. */
  readonly origin: "child" | "schedule";
  /** A pinned skill loads only while its current source and digest still match. */
  readonly skills: readonly { readonly name: string; readonly pin: SkillPin | null }[];
};

/** The route reason a loaded preload is recorded with. */
export function skillPreloadReason(origin: SkillPreload["origin"]): string {
  return origin === "child" ? "child-preload" : "schedule-preload";
}
