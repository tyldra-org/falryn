/** Translate one model action to source-local edits; inheritance stays in the resolver. */
import type { ModelSettingsRequest } from "../../application/providers/model-settings.ts";
import type { ConfigurationDocumentEdit } from "../../config/document/edits.ts";
import type { StoredModelPreferences as ModelPreferences } from "../../providers/configuration/policy-schema.ts";
import { modelPreferencePath } from "../../providers/configuration/settings-actions.ts";

export function workingModelEdits(
  root: readonly string[],
  preferences: ModelPreferences,
  mutation: Extract<ModelSettingsRequest, { kind: "edit" | "apply-clear" | "apply-migration" }>,
): readonly ConfigurationDocumentEdit[] {
  if (mutation.kind === "apply-clear") return [{ kind: "remove", path: root }];
  if (mutation.kind === "apply-migration") return [{ kind: "set", path: root, value: preferences }];
  const edit = mutation.edit;
  const changes: ConfigurationDocumentEdit[] = [];
  const put = (path: readonly string[], value: unknown) =>
    changes.push(
      value === undefined
        ? { kind: "remove", path: [...root, ...path] }
        : { kind: "set", path: [...root, ...path], value },
    );
  if (edit.kind === "processing-default") put(["processing"], edit.processing);
  else if (edit.kind === "processing-route")
    put([...modelPreferencePath(edit.target), "processing"], edit.processing);
  else if (edit.kind === "membership")
    put(["roles", "subagents", "agents", edit.id, "preset"], edit.preset ?? undefined);
  else if (edit.kind === "use") put(["roles", "fast", "use", edit.option], edit.use);
  else {
    const path = modelPreferencePath(edit.target);
    if (edit.kind === "reset") put(path, undefined);
    else {
      // Preserve specialized use policy while replacing precisely the route unit.
      for (const field of [
        "providerProfileId",
        "providerId",
        "modelId",
        "reasoning",
        "processing",
        "fallbacks",
        "budgets",
        "kind",
        "routeId",
      ] as const)
        put(
          [...path, field],
          Object.hasOwn(edit.route, field) ? Reflect.get(edit.route, field) : undefined,
        );
    }
  }
  const target =
    edit.kind === "membership"
      ? { kind: "agent", id: edit.id }
      : edit.kind === "configure" || edit.kind === "reset"
        ? edit.target
        : null;
  if (target !== null && "id" in target) {
    const agentTarget = target.kind === "agent";
    const saved = agentTarget
      ? preferences.roles.subagents?.agents?.[target.id]
      : preferences.roles.workflows?.definitions?.[target.id];
    const path = agentTarget
      ? ["roles", "subagents", "agents", target.id]
      : ["roles", "workflows", "definitions", target.id];
    for (const field of ["definitionRevision", "schemaRevision"] as const) {
      if (
        saved === undefined ||
        edit.kind === "configure" ||
        (edit.kind === "membership" && edit.preset !== null)
      )
        put([...path, field], saved?.[field]);
    }
  }
  put(["revision"], preferences.revision);
  return changes;
}

/** A clear preview lists only authored preferences, excluding inherited values and metadata. */
export function ownedModelOverridePaths(value: unknown, prefix = ""): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  if (Object.hasOwn(value, "modelId")) return [prefix];
  return Object.entries(value)
    .filter(([key]) => prefix !== "" || !["schemaVersion", "revision"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, child]) =>
      ownedModelOverridePaths(child, prefix === "" ? key : `${prefix}.${key}`),
    );
}
