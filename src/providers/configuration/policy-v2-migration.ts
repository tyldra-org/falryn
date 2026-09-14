import type { z } from "zod";
import { DEFAULT_INTENT_ROLE_MAP } from "./policy.ts";
import type { previousModelPreferencesSchema } from "./policy-compatibility.ts";
import type {
  MigrationDecision,
  ModelMigrationChange,
  ModelMigrationPreview,
} from "./policy-migration.ts";
import { type ModelPreferences, modelPreferencesSchema } from "./policy-schema.ts";

/** Preserve every unrelated preference; only the retired route and use setting disappear. */
export function previewPreviousModelPolicy(
  original: unknown,
  previous: z.infer<typeof previousModelPreferencesSchema>,
  current: ModelPreferences,
  decisions: Readonly<Record<string, MigrationDecision>>,
): ModelMigrationPreview {
  let candidate = structuredClone(current);
  const changes: ModelMigrationChange[] = [
    {
      path: "roles.default",
      kind: "preserved-main",
      before: previous.roles.default ?? null,
      after: current.roles.default ?? null,
      decision: null,
    },
  ];
  const unresolved: string[] = [];
  const move = (path: string, before: unknown, existing: unknown, apply: () => void) => {
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
    if (conflict && decision !== "keep-current" && decision !== "use-legacy") unresolved.push(path);
    if (!conflict || decision === "use-legacy") apply();
  };
  move("processing", previous.processing, current.processing, () => {
    candidate.processing = previous.processing;
  });
  for (const role of ["vision", "plan", "advisor", "subagents", "workflows"] as const) {
    const value = previous.roles[role];
    move(`roles.${role}`, value, current.roles[role], () => {
      candidate = { ...candidate, roles: { ...candidate.roles, [role]: value } };
    });
  }
  const fast = previous.roles.fast;
  if (fast !== undefined) {
    const { compaction: retiredRoute, ...options } = fast.options ?? {};
    const { compaction: retiredUse, ...use } = fast.use ?? {};
    for (const [path, value] of [
      ["roles.fast.options.compaction", retiredRoute],
      ["roles.fast.use.compaction", retiredUse],
    ] as const) {
      if (value !== undefined)
        changes.push({ path, kind: "retired", before: value, after: null, decision: null });
    }
    move("roles.fast.default", fast.default, current.roles.fast?.default, () => {
      candidate.roles.fast = { ...candidate.roles.fast, default: fast.default };
    });
    for (const [key, route] of Object.entries(options)) {
      move(
        `roles.fast.options.${key}`,
        route,
        current.roles.fast?.options?.[key as keyof typeof options],
        () => {
          candidate.roles.fast = {
            ...candidate.roles.fast,
            options: { ...candidate.roles.fast?.options, [key]: route },
          };
        },
      );
    }
    for (const [key, setting] of Object.entries(use)) {
      move(
        `roles.fast.use.${key}`,
        setting,
        current.roles.fast?.use?.[key as keyof typeof use],
        () => {
          candidate.roles.fast = {
            ...candidate.roles.fast,
            use: { ...candidate.roles.fast?.use, [key]: setting },
          };
        },
      );
    }
  }
  changes.push({
    path: "intents.compression",
    kind: "normalized",
    before: "fast",
    after: "default",
    decision: null,
  });
  for (const [key, value] of Object.entries(previous.intents)) {
    if (key === "compression") continue;
    const intent = key as keyof typeof previous.intents;
    move(
      `intents.${key}`,
      value,
      current.intents[intent] === DEFAULT_INTENT_ROLE_MAP[intent]
        ? undefined
        : current.intents[intent],
      () => {
        candidate = { ...candidate, intents: { ...candidate.intents, [key]: value } };
      },
    );
  }
  return {
    kind: "preview",
    original: structuredClone(original),
    destinationRevision: current.revision,
    candidate: modelPreferencesSchema.parse(candidate),
    changes,
    unresolved,
    decisions: { ...decisions },
  };
}
