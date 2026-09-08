/** Typed edits used by every settings surface; one selected override per edit. */
import { z } from "zod";
import type { ModelSelectionTarget } from "./model-selection.ts";
import {
  contributionIdentitySchema,
  type ModelPreferences,
  modelPreferencesSchema,
  nodeIdentitySchema,
  roleRouteBaseSchema,
} from "./policy-schema.ts";
import { FAST_OPTIONS, MODEL_ROLES, SUBAGENT_PRESETS } from "./roles.ts";

export const modelSelectionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("role"), role: z.enum(MODEL_ROLES) }),
  z.strictObject({ kind: z.literal("fast"), option: z.enum(FAST_OPTIONS) }),
  z.strictObject({ kind: z.literal("preset"), preset: z.enum(SUBAGENT_PRESETS) }),
  z.strictObject({ kind: z.literal("agent"), id: contributionIdentitySchema }),
  z.strictObject({ kind: z.literal("workflow"), id: contributionIdentitySchema }),
  z.strictObject({
    kind: z.literal("step"),
    id: contributionIdentitySchema,
    key: nodeIdentitySchema,
  }),
]);
export const modelSettingsEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("configure"),
    target: modelSelectionTargetSchema,
    route: roleRouteBaseSchema,
  }),
  z.strictObject({ kind: z.literal("reset"), target: modelSelectionTargetSchema }),
  z.strictObject({
    kind: z.literal("membership"),
    id: contributionIdentitySchema,
    preset: z.enum(["default", ...SUBAGENT_PRESETS]).nullable(),
  }),
  z.strictObject({
    kind: z.literal("use"),
    option: z.enum(["memory", "compaction"]),
    use: z.enum(["evaluated", "off"]),
  }),
]);
export type ModelSettingsEdit = z.infer<typeof modelSettingsEditSchema>;
export function modelPreferencePath(target: ModelSelectionTarget): readonly string[] {
  switch (target.kind) {
    case "role":
      return [
        "roles",
        target.role,
        ...(["fast", "subagents", "workflows"].includes(target.role) ? ["default"] : []),
      ];
    case "fast":
      return ["roles", "fast", "options", target.option];
    case "preset":
      return ["roles", "subagents", "presets", target.preset];
    case "agent":
      return ["roles", "subagents", "agents", target.id, "route"];
    case "workflow":
      return ["roles", "workflows", "definitions", target.id, "default"];
    case "step":
      return ["roles", "workflows", "definitions", target.id, "steps", target.key];
  }
}
export function editModelPreferences(
  preferences: ModelPreferences,
  edit: ModelSettingsEdit,
): ModelPreferences {
  const candidate = structuredClone(preferences);
  const path =
    edit.kind === "membership"
      ? ["roles", "subagents", "agents", edit.id, "preset"]
      : edit.kind === "use"
        ? ["roles", "fast", "use", edit.option]
        : modelPreferencePath(edit.target);
  const value =
    edit.kind === "configure"
      ? edit.route
      : edit.kind === "membership"
        ? (edit.preset ?? undefined)
        : edit.kind === "use"
          ? edit.use
          : undefined;
  assignPreference(candidate, path, value);
  const resetTarget =
    edit.kind === "reset"
      ? edit.target
      : edit.kind === "membership" && edit.preset === null
        ? { kind: "agent", id: edit.id }
        : null;
  if (resetTarget !== null && "id" in resetTarget) {
    if (resetTarget.kind === "agent") {
      const saved = candidate.roles.subagents?.agents?.[resetTarget.id];
      if (saved?.route === undefined && saved?.preset === undefined)
        delete candidate.roles.subagents?.agents?.[resetTarget.id];
    } else {
      const saved = candidate.roles.workflows?.definitions?.[resetTarget.id];
      if (saved?.default === undefined && Object.keys(saved?.steps ?? {}).length === 0)
        delete candidate.roles.workflows?.definitions?.[resetTarget.id];
    }
  }
  // Specialized use defaults remain unchanged when only their route changes.
  if (edit.kind === "configure" && edit.target.kind === "role") {
    if (edit.target.role === "vision")
      assignPreference(
        candidate,
        ["roles", "vision", "use"],
        preferences.roles.vision?.use ?? "off",
      );
    if (edit.target.role === "advisor")
      assignPreference(
        candidate,
        ["roles", "advisor", "use"],
        preferences.roles.advisor?.use ?? "off",
      );
  }
  return modelPreferencesSchema.parse(candidate);
}
function assignPreference(root: object, path: readonly string[], value: unknown): void {
  let node = root as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(node, key)) node[key] = {};
    const next = node[key];
    if (next === null || typeof next !== "object" || Array.isArray(next))
      throw new Error("Invalid preference path.");
    node = next as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (key === undefined) throw new Error("Empty preference path.");
  if (value === undefined) delete node[key];
  else node[key] = value;
}
