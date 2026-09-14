/** Explicit legacy policy import. Nothing here writes or activates a policy. */
import { DEFAULT_INTENT_ROLE_MAP } from "./policy.ts";
import {
  LEGACY_INTENTS,
  legacyPolicySchema,
  previousModelPreferencesSchema,
  storedModelPreferencesSchema,
} from "./policy-compatibility.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  fastRoleSettingsSchema,
  MODEL_POLICY_SCHEMA_VERSION,
  type ModelPreferences,
  modelPreferencesSchema,
  roleRouteBaseSchema,
} from "./policy-schema.ts";
import { previewPreviousModelPolicy } from "./policy-v2-migration.ts";
import { FAST_OPTIONS } from "./roles.ts";

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
  const previous = previousModelPreferencesSchema.safeParse(original);
  if (previous.success)
    return previewPreviousModelPolicy(original, previous.data, current, decisions);
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
  for (const name of ["compact", "fast-read", "fast-edit", "commit"] as const) {
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
    if (intent === "compression" || (intent === "memory" && role === "compact")) {
      changes.push({
        path: `intents.${intent}`,
        kind: "normalized",
        before: role,
        after: DEFAULT_INTENT_ROLE_MAP[intent],
        decision: null,
      });
      continue;
    }
    if (intent === "memory") {
      const option = "memory";
      const assigned = legacy.roles[role];
      const route =
        assigned ?? (role === "vision" || role === "advisor" ? undefined : legacy.roles.default);
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
              processing: route.processing,
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
    for (const [path, value] of [
      ["roles.fast.options.compaction", legacy.roles.fast.options?.compaction],
      ["roles.fast.use.compaction", legacy.roles.fast.use?.compaction],
    ] as const) {
      if (value !== undefined)
        changes.push({ path, kind: "retired", before: value, after: null, decision: null });
    }
    move("roles.fast.default", legacy.roles.fast.default, candidate.roles.fast?.default, () => {
      candidate.roles.fast ??= {};
      candidate.roles.fast.default = legacy.roles.fast?.default;
    });
    const useOptions = fastRoleSettingsSchema.shape.use.unwrap().keyof().options;
    for (const option of FAST_OPTIONS) {
      const route = legacy.roles.fast.options?.[option];
      const useOption = useOptions.find((key) => key === option);
      const helper = useOption !== undefined;
      const use = useOption === undefined ? undefined : legacy.roles.fast.use?.[useOption];
      if (route === undefined && use === undefined) continue;
      const path = `roles.fast.options.${option}`;
      const existingRoute = candidate.roles.fast?.options?.[option];
      const existingUse =
        useOption === undefined ? undefined : candidate.roles.fast?.use?.[useOption];
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
        if (useOption !== undefined) {
          candidate.roles.fast.use ??= {};
          candidate.roles.fast.use[useOption] = use ?? "off";
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

/** Safe read projection only. Retired selections never execute, and source bytes stay authoritative. */
export function readStoredModelPreferences(input: unknown): ModelPreferences {
  const current = modelPreferencesSchema.safeParse(input);
  if (current.success) return current.data;
  const previous = previousModelPreferencesSchema.safeParse(input);
  if (previous.success) {
    const { roles } = previous.data;
    const { compaction: _route, ...options } = roles.fast?.options ?? {};
    const { compaction: _use, ...use } = roles.fast?.use ?? {};
    return modelPreferencesSchema.parse({
      ...previous.data,
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      intents: { ...previous.data.intents, compression: "default" },
      roles: {
        ...roles,
        fast: roles.fast === undefined ? undefined : { ...roles.fast, options, use },
      },
    });
  }
  const stored = storedModelPreferencesSchema.parse(input);
  const seed = modelPreferencesSchema.parse({
    ...EMPTY_MODEL_PREFERENCES,
    revision: stored.revision ?? 0,
    roles: { default: stored.roles.default },
  });
  const preview = previewModelPolicyMigration(stored, seed);
  if (preview.kind !== "preview") throw new Error("Model policy migration is unavailable.");
  return preview.candidate;
}
