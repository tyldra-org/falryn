/** Explicit legacy policy import. Nothing here writes or activates a policy. */
import { z } from "zod";
import { DEFAULT_INTENT_ROLE_MAP } from "./policy.ts";
import {
  advisorRoleRouteSchema,
  fastRoleSettingsSchema,
  type ModelPreferences,
  modelPreferencesSchema,
  roleRouteBaseSchema,
  subagentRoleSettingsSchema,
  visionRoleRouteSchema,
  workflowRoleSettingsSchema,
} from "./policy-schema.ts";
import { FAST_OPTIONS } from "./roles.ts";

const LEGACY_ROLES = [
  "default",
  "compact",
  "vision",
  "plan",
  "advisor",
  "commit",
  "fast-read",
  "fast-edit",
] as const;
const LEGACY_INTENTS = [
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
const legacyPolicySchema = z.strictObject({
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
    // Recognized development shape only; never accepted by the executable codec.
    fast: fastRoleSettingsSchema
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
const LEGACY_DEFAULTS = {
  ...DEFAULT_INTENT_ROLE_MAP,
  read: "fast-read",
  toolRouting: "fast-read",
  fastEdit: "fast-edit",
  compression: "compact",
  memory: "compact",
} as const;
export type MigrationDecision = "keep-current" | "use-legacy" | "normalize";
export type ModelMigrationChange = {
  readonly path: string;
  readonly kind: "moved" | "retired" | "normalized" | "conflict" | "preserved-main";
  readonly before: unknown;
  readonly after: unknown;
  readonly decision: MigrationDecision | null;
};
export type ModelMigrationPreview = {
  readonly kind: "preview";
  readonly original: unknown;
  readonly destinationRevision: number;
  readonly candidate: ModelPreferences;
  readonly changes: readonly ModelMigrationChange[];
  readonly unresolved: readonly string[];
  readonly decisions: Readonly<Record<string, MigrationDecision>>;
};
export function previewModelPolicyMigration(
  original: unknown,
  current: ModelPreferences,
  decisions: Readonly<Record<string, MigrationDecision>> = {},
): ModelMigrationPreview | { readonly kind: "invalid"; readonly message: string } {
  const parsed = legacyPolicySchema.safeParse(original);
  if (!parsed.success)
    return {
      kind: "invalid",
      message: "Expected a bounded legacy model policy; no settings were changed.",
    };
  const legacy = parsed.data;
  const candidate = structuredClone(current);
  const changes: ModelMigrationChange[] = [];
  const unresolved: string[] = [];
  const move = (path: string, before: unknown, existing: unknown, assign: () => void): void => {
    if (before === undefined) return;
    const conflict = existing !== undefined && JSON.stringify(existing) !== JSON.stringify(before);
    const decision = decisions[path] ?? null;
    changes.push({
      path,
      kind: conflict ? "conflict" : "moved",
      before,
      after: conflict && decision !== "use-legacy" ? existing : before,
      decision,
    });
    if (conflict && decision !== "keep-current" && decision !== "use-legacy") {
      unresolved.push(path);
      return;
    }
    if (!conflict || decision === "use-legacy") assign();
  };
  changes.push({
    path: "roles.default",
    kind: "preserved-main",
    before: legacy.roles.default,
    after: current.roles.default ?? null,
    decision: null,
  });
  for (const name of ["fast-read", "fast-edit", "commit"] as const) {
    if (legacy.roles[name] !== undefined)
      changes.push({
        path: `roles.${name}`,
        kind: "retired",
        before: legacy.roles[name],
        after: "main",
        decision: null,
      });
  }
  for (const name of ["vision", "plan", "advisor"] as const) {
    // Each assignment remains type-correlated instead of widening specialized use policies.
    if (name === "vision")
      move("roles.vision", legacy.roles.vision, candidate.roles.vision, () => {
        candidate.roles.vision = legacy.roles.vision;
      });
    if (name === "plan")
      move("roles.plan", legacy.roles.plan, candidate.roles.plan, () => {
        candidate.roles.plan = legacy.roles.plan;
      });
    if (name === "advisor")
      move("roles.advisor", legacy.roles.advisor, candidate.roles.advisor, () => {
        candidate.roles.advisor = legacy.roles.advisor;
      });
  }
  const oldIntents = { ...LEGACY_DEFAULTS, ...legacy.intents };
  for (const intent of LEGACY_INTENTS) {
    const role = oldIntents[intent];
    if (intent === "compression" || intent === "memory") {
      const option = intent === "compression" ? "compaction" : "memory";
      if (
        legacy.roles.compact === undefined &&
        legacy.intents?.[intent] === undefined &&
        (legacy.roles.fast?.options?.[option] !== undefined ||
          legacy.roles.fast?.use?.[option] !== undefined)
      )
        continue;
      const assigned = legacy.roles[role];
      const route =
        assigned ??
        (role === "compact" || role === "vision" || role === "advisor"
          ? undefined
          : legacy.roles.default);
      const use =
        route === undefined || ("use" in route && route.use === "off") ? "off" : "evaluated";
      const plainRoute =
        route === undefined
          ? undefined
          : roleRouteBaseSchema.parse({
              providerProfileId: route.providerProfileId,
              providerId: route.providerId,
              modelId: route.modelId,
              reasoning: route.reasoning,
              fallbacks: route.fallbacks,
              budgets: route.budgets,
            });
      candidate.roles.fast ??= {};
      candidate.roles.fast.options ??= {};
      candidate.roles.fast.use ??= {};
      // Route and enablement migrate as one decision: neither half can be silently lost.
      const incoming = { route: plainRoute ?? null, use };
      const existingRoute = candidate.roles.fast.options[option];
      const existingUse = candidate.roles.fast.use[option];
      const existing =
        existingRoute === undefined && existingUse === undefined
          ? undefined
          : { route: existingRoute ?? null, use: existingUse ?? "off" };
      move(`roles.fast.options.${option}`, incoming, existing, () => {
        const fast = candidate.roles.fast;
        if (fast === undefined) return;
        fast.options ??= {};
        fast.use ??= {};
        if (plainRoute === undefined) delete fast.options[option];
        else fast.options[option] = plainRoute;
        fast.use[option] = use;
      });
      continue;
    }
    const currentIntent = intent === "fastEdit" ? "edit" : intent;
    const ordinary =
      currentIntent === "coding" ||
      currentIntent === "read" ||
      currentIntent === "toolRouting" ||
      currentIntent === "edit";
    const retired =
      role === "compact" || role === "commit" || role === "fast-read" || role === "fast-edit";
    const custom =
      legacy.intents?.[intent] !== undefined && legacy.intents[intent] !== LEGACY_DEFAULTS[intent];
    if (ordinary || retired) {
      const path = `intents.${intent}`;
      changes.push({
        path,
        kind: "normalized",
        before: role,
        after: DEFAULT_INTENT_ROLE_MAP[currentIntent],
        decision: decisions[path] ?? null,
      });
      if (custom && decisions[path] !== "normalize") unresolved.push(path);
    } else {
      move(
        `intents.${currentIntent}`,
        role,
        current.intents[currentIntent] === DEFAULT_INTENT_ROLE_MAP[currentIntent]
          ? undefined
          : current.intents[currentIntent],
        () => {
          candidate.intents[currentIntent] = role;
        },
      );
    }
  }
  // Move only explicitly persisted groups. Never copy the Fast default into either role.
  for (const source of [legacy.roles, legacy.roles.fast]) {
    if (source === undefined) continue;
    move("roles.subagents", source.subagents, candidate.roles.subagents, () => {
      candidate.roles.subagents = source.subagents;
    });
    move("roles.workflows", source.workflows, candidate.roles.workflows, () => {
      candidate.roles.workflows = source.workflows;
    });
  }
  if (legacy.roles.fast !== undefined) {
    move("roles.fast.default", legacy.roles.fast.default, candidate.roles.fast?.default, () => {
      candidate.roles.fast ??= {};
      candidate.roles.fast.default = legacy.roles.fast?.default;
    });
    for (const option of FAST_OPTIONS) {
      const route = legacy.roles.fast.options?.[option];
      const helper = option === "memory" || option === "compaction";
      const use = helper ? legacy.roles.fast.use?.[option] : undefined;
      if (route === undefined && use === undefined) continue;
      const path = `roles.fast.options.${option}`;
      const existingRoute = candidate.roles.fast?.options?.[option];
      const existingUse = helper ? candidate.roles.fast?.use?.[option] : undefined;
      const incoming = helper ? { route: route ?? null, use: use ?? "off" } : route;
      const existing = helper
        ? existingRoute === undefined && existingUse === undefined
          ? undefined
          : { route: existingRoute ?? null, use: existingUse ?? "off" }
        : existingRoute;
      move(path, incoming, existing, () => {
        candidate.roles.fast ??= {};
        candidate.roles.fast.options ??= {};
        if (route === undefined) delete candidate.roles.fast.options[option];
        else candidate.roles.fast.options[option] = route;
        if (helper) {
          candidate.roles.fast.use ??= {};
          candidate.roles.fast.use[option] = use ?? "off";
        }
      });
    }
  }
  const checked = modelPreferencesSchema.safeParse(candidate);
  if (!checked.success)
    return {
      kind: "invalid",
      message: "The migrated candidate exceeds the current policy contract.",
    };
  return {
    kind: "preview",
    original: structuredClone(original),
    destinationRevision: current.revision,
    candidate: checked.data,
    changes,
    unresolved: [...new Set(unresolved)],
    decisions: { ...decisions },
  };
}
