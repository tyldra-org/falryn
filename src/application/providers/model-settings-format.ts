/** Shared plain-text summary for CLI and terminal settings. Structured output retains all evidence. */
import type { ModelSettingsResult } from "./model-settings.ts";
export function modelSettingsLines(result: ModelSettingsResult): readonly string[] {
  switch (result.kind) {
    case "failed":
      return [`Model settings: ${result.code}`];
    case "invalid":
      return [result.message];
    case "written":
      return [
        `Saved model policy revision ${result.policyRevision}.`,
        `File revision: ${result.revision}`,
        ...(result.backup === null ? [] : [`Recovery copy: ${result.backup}`]),
      ];
    case "clear-preview":
      return [
        `Clear ${result.paths.length} saved preferences:`,
        ...result.paths,
        `File revision: ${result.expectedRevision ?? "absent"}`,
      ];
    case "preview":
      return [
        "Migration preview; no settings changed.",
        ...result.changes.map(
          (change) =>
            `${change.kind}: ${change.path}${change.decision === null ? "" : ` (${change.decision})`}`,
        ),
        ...result.unresolved.map((path) => `Decision required: ${path}`),
      ];
    case "inspection":
      return [
        `Model roles · ${result.scope} · policy revision ${result.preferences.revision}`,
        `File revision: ${result.fileRevision ?? "absent"}`,
        ...result.rows.flatMap(({ target, selection, compatibility, definition }) => {
          const label =
            target.kind === "role"
              ? target.role
              : target.kind === "fast"
                ? `fast / ${target.option}`
                : target.kind === "preset"
                  ? `subagents / ${target.preset}`
                  : target.kind === "step"
                    ? `${target.id} / ${target.key}`
                    : target.id;
          if (selection === null) return [`${label}: main model unavailable`];
          if (selection.kind === "no-model") return [`${label}: deterministic; no model`];
          const { route } = selection;
          const savedMain =
            target.kind === "role" && target.role === "default"
              ? result.preferences.roles.default
              : undefined;
          return [
            `${label}: ${route.providerProfileId} / ${String(route.modelId)} · ${route.reasoning}`,
            `  from ${selection.source} · ${selection.availability}${compatibility?.ok === false ? ` · ${compatibility.code}` : ""}`,
            ...(savedMain === undefined
              ? []
              : [
                  `  saved default: ${savedMain.providerProfileId} / ${String(savedMain.modelId)} · ${savedMain.reasoning}; session selection takes precedence`,
                ]),
            ...(selection.reason === null ? [] : [`  ${selection.reason}`]),
            ...(definition === null
              ? []
              : [
                  `  ${definition.provenance} · ${definition.id} · revision ${definition.revision}`,
                ]),
          ];
        }),
        ...(result.catalog === null
          ? []
          : [
              `Advanced: ${result.catalog.total} definitions${result.catalog.nextOffset === null ? "" : `; next offset ${result.catalog.nextOffset}`}`,
            ]),
      ];
  }
}
