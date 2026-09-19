/** Shared plain-text summary for CLI and terminal settings. Structured output retains all evidence. */
import type { ModelSettingsResult } from "./model-settings.ts";
export function modelSettingsLines(result: ModelSettingsResult): readonly string[] {
  switch (result.kind) {
    case "route-list":
      return [
        `Named model routes · generation ${result.configurationGeneration}`,
        ...result.routes.map(
          (route) => `${route.id} · revision ${route.revision} · ${route.policy.strategy}`,
        ),
        `File revision: ${result.fileRevision ?? "absent"}`,
      ];
    case "route-inspection": {
      const receipt = result.resolution.receipt;
      return [
        `${result.simulated ? "Simulated" : "Declared"} route: ${result.resolution.kind}`,
        ...(receipt
          ? [
              `${receipt.routeId} · definition ${receipt.definitionRevision} · generation ${receipt.configurationGeneration}`,
              ...receipt.eligible.map(
                (candidate, index) =>
                  `${index === 0 ? "Primary" : "Qualified alternate"}: ${candidate.target.connectionId} / ${candidate.target.providerId} / ${candidate.target.modelId} · ${candidate.uncertainty.join(", ") || "qualified"}`,
              ),
              ...receipt.exclusions.map(
                (entry) =>
                  `Excluded ${entry.target.connectionId} / ${entry.target.modelId}: ${entry.reasons.join(", ")}`,
              ),
            ]
          : ["Route definition missing."]),
        "No provider calls, credential reads or writes. Qualified alternates are not automatic retries.",
      ];
    }
    case "route-validation":
      return result.ok
        ? ["Route declarations valid."]
        : result.errors.map((error) => `${error.path}: ${error.code}`);
    case "route-written":
      return [
        `Saved ${result.definitions.length} named routes.`,
        `File revision: ${result.revision}`,
        ...(result.receipt
          ? [
              `Publication: ${result.receipt.publication}; application: ${result.receipt.application}.`,
            ]
          : []),
      ];
    case "processing-changed":
      return [
        "Processing preference changed; application: pending (next main request).",
        ...modelSettingsLines(result.inspection),
      ];
    case "processing-inspection": {
      const selection = result.selection;
      return [
        `Processing speed · ${result.scope.kind}${result.scope.kind === "session" ? ` · ${result.scope.sessionId}` : ""}`,
        ...(selection === null
          ? ["Model/account unavailable."]
          : [
              `${selection.route.providerProfileId} / ${String(selection.route.modelId)} · thinking ${selection.route.reasoning}`,
              `Requested: ${selection.preference.mode}; local fallback: ${selection.preference.fallback}.`,
              ...selection.modes.map((mode) => {
                const price = "price" in mode ? mode.price : null;
                const known =
                  price?.inputMicrosPerMillion != null && price.outputMicrosPerMillion !== null;
                return `${mode.preference.mode}: ${mode.eligible ? "eligible" : mode.reason} · ${known ? `USD micros per million tokens: input ≤${price.inputMicrosPerMillion}, output ≤${price.outputMicrosPerMillion}` : "price unknown"}`;
              }),
            ]),
        `Last served: ${result.lastServed?.actualMode ?? "unknown"}${result.lastServed ? `; requested ${result.lastServed.binding.preference.mode}; resolved ${result.lastServed.binding.resolvedMode}` : " (no completed attempt in this process)"}.`,
        ...(result.active
          ? [
              `Active request: ${result.active.mode}; actual unknown until provider receipt. Pending preference applies to the next request.`,
            ]
          : []),
        "Stop/Allow Standard controls client fallback; providers may still downgrade successful requests.",
        ...(result.scope.kind === "session"
          ? ["Session only; main model; next admitted request."]
          : [`File revision: ${result.fileRevision ?? "absent"}`]),
      ];
    }
    case "failed":
      return [
        `Model settings: ${result.code}`,
        ...(result.code === "publication-uncertain"
          ? ["Inspect the settings file before retrying; the save could not be confirmed."]
          : []),
      ];
    case "invalid":
      return [result.message];
    case "written":
      return [
        `Saved model policy revision ${result.policyRevision}.`,
        `File revision: ${result.revision}`,
        ...(result.receipt === null
          ? []
          : [
              `Publication: ${result.receipt.publication}; generation: ${result.receipt.generation ?? "none"}; application: ${result.receipt.application}.`,
              ...(result.receipt.transition?.owners.map(
                (owner) =>
                  `${owner.owner}: ${owner.state}; generation ${owner.generation ?? "none"}; ${owner.code}.`,
              ) ?? []),
            ]),
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
        ...(result.migrationRequired
          ? [
              "Legacy model policy: preview and apply migration before changing preferences. Retired compaction routes are inactive.",
            ]
          : []),
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
                  `  saved default: ${"routeId" in savedMain ? `route ${savedMain.routeId}` : `${savedMain.providerProfileId} / ${String(savedMain.modelId)}`} · ${savedMain.reasoning}; session selection takes precedence`,
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
