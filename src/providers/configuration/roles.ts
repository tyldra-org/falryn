/**
 * Public generative model roles and internal work intents.
 *
 * Roles are configuration concepts, not separate agent protocols. Intent → role
 * mapping and fallback live in `policy.ts` / `routing.ts`.
 */

export const MODEL_ROLES = [
  "default",
  "compact",
  "vision",
  "plan",
  "advisor",
  "commit",
  "fast-read",
  "fast-edit",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value);
}

export const WORK_INTENTS = [
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

export type WorkIntent = (typeof WORK_INTENTS)[number];

export function isWorkIntent(value: unknown): value is WorkIntent {
  return typeof value === "string" && (WORK_INTENTS as readonly string[]).includes(value);
}
