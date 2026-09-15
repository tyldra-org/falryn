/** Working-profile inspection and explicit selection saves. Never prepares a provider. */
import { fromConfigurationIssues } from "../../application/diagnostics/index.ts";
import {
  applyConfigurationMigration,
  previewConfigurationMigration,
} from "../../config/host/migration.ts";
import { writeConfigurationEdits } from "../../config/host/writer.ts";
import { inspectGeneration } from "../../config/index.ts";
import { listWorkingProfiles } from "../../config/resolution/working-profile.ts";
import type { ConfigurationInspection } from "../../domain/configuration/index.ts";
import type { GlobalOptions } from "../options.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { errorsFrom, resultFor } from "./shared.ts";

export type WorkingConfigurationArguments =
  | { readonly action: "list" }
  | { readonly action: "show"; readonly id?: string }
  | { readonly action: "default"; readonly id: string; readonly revision?: string }
  | {
      readonly action: "migrate";
      readonly scope: "user" | "project" | "private-project" | "profile";
      readonly confirmation?: string;
      readonly revision?: string;
    };

export type WorkingConfigurationPayload =
  | {
      readonly kind: "profiles";
      readonly profiles: readonly {
        readonly id: string;
        readonly file: string | null;
        readonly revision: string | null;
      }[];
    }
  | { readonly kind: "profile"; readonly inspection: ConfigurationInspection }
  | {
      readonly kind: "saved";
      readonly receipt: Awaited<ReturnType<typeof writeConfigurationEdits>>;
    }
  | {
      readonly kind: "migration";
      readonly preview: Omit<
        Extract<Awaited<ReturnType<typeof previewConfigurationMigration>>, { kind: "preview" }>,
        "source" | "edits"
      >;
    }
  | {
      readonly kind: "migration-applied";
      readonly result: Awaited<ReturnType<typeof applyConfigurationMigration>>;
    }
  | { readonly kind: "refused"; readonly code: string; readonly remedy: string };

export async function runWorkingConfiguration(
  services: ServiceProvider,
  args: WorkingConfigurationArguments,
  globals: GlobalOptions,
  signal?: AbortSignal,
  onMutationStart?: () => void,
) {
  const command = args.action === "migrate" ? ("config.migrate" as const) : ("profile" as const);
  const result = (
    payload: WorkingConfigurationPayload,
    failed = false,
    effect: "none" | "completed" | "uncertain" = "none",
  ) =>
    resultFor(command, payload, [], failed ? { kind: "failed", effect } : { kind: "completed" }, {
      intent:
        args.action === "default" || (args.action === "migrate" && args.confirmation !== undefined)
          ? "mutate"
          : "none",
      observed: effect,
    });
  const refuse = (code: string) =>
    result(
      {
        kind: "refused",
        code,
        remedy:
          "Repair the named source or explicitly reset its selection; inspect migration before applying it.",
      },
      true,
    );
  const graph = services();
  const workspace = await graph.ensureWorkspaceSet(signal);
  if (!workspace.ok) return refuse("workspace-unavailable");
  const home = await graph.configurationHomeForRead(signal);
  if (!["current", "legacy", "empty"].includes(home.kind) || !("root" in home))
    return refuse("configuration-home-unavailable");
  const profile =
    args.action === "show"
      ? (args.id ?? globals.profile)
      : args.action === "default"
        ? args.id
        : globals.profile;
  const request = { configurationRoot: home.root, workspaceRoot: graph.workspaceRoot, profile };
  if (args.action === "list") {
    const listed = await listWorkingProfiles(graph.fileSystem, home.root, signal);
    if (listed.issues.length > 0) return refuse("profile-catalog-unavailable-or-ambiguous");
    return result({
      kind: "profiles",
      profiles: listed.profiles.some((entry) => entry.id === "default")
        ? listed.profiles
        : [{ id: "default", file: null, revision: null }, ...listed.profiles],
    });
  }
  if (args.action === "migrate") {
    await graph.loader.load(request, signal);
    const migration = {
      ...request,
      scope: args.scope,
      ...(onMutationStart === undefined ? {} : { onMutationStart }),
      validateCandidate: (
        path: import("../../domain/workspace/index.ts").LocalPath,
        text: string,
        abort?: AbortSignal,
      ) => graph.loader.validate(request, { path, text }, abort),
    };
    if (args.confirmation !== undefined) {
      if (args.revision === undefined) return refuse("migration-revision-required");
      const applied = await applyConfigurationMigration(
        graph.registry,
        graph.fileSystem,
        migration,
        { id: args.confirmation, revision: args.revision },
        signal,
      );
      return result(
        { kind: "migration-applied", result: applied },
        applied.kind !== "applied" || applied.saved.kind !== "written",
        applied.kind === "applied"
          ? applied.saved.kind === "filesystem" && applied.saved.code === "publication-uncertain"
            ? "uncertain"
            : "completed"
          : "effect" in applied
            ? applied.effect
            : "none",
      );
    }
    const preview = await previewConfigurationMigration(
      graph.registry,
      graph.fileSystem,
      migration,
      signal,
    );
    if (preview.kind !== "preview") return refuse(preview.code);
    return result({ kind: "migration", preview });
  }
  const loaded = await graph.loader.load(request, signal);
  if (loaded.kind !== "published" && loaded.kind !== "unchanged") {
    if (loaded.kind === "rejected")
      return resultFor(
        command,
        null,
        errorsFrom(
          fromConfigurationIssues(loaded.issues, { operation: "resolve working profile" }),
        ),
      );
    return refuse("configuration-unavailable");
  }
  if (args.action === "show")
    return result({
      kind: "profile",
      inspection: inspectGeneration(graph.registry, loaded.record),
    });
  const receipt = await writeConfigurationEdits(
    graph.registry,
    graph.fileSystem,
    {
      ...request,
      scope: "user",
      edits: [{ kind: "set", path: ["profiles", "default"], value: args.id }],
      ...(args.revision === undefined ? {} : { expectedRevision: args.revision }),
      ...(onMutationStart === undefined ? {} : { onMutationStart }),
      validateCandidate: (path, text, abort) =>
        graph.loader.validate({ ...request, profile: null }, { path, text }, abort),
    },
    signal,
  );
  return result(
    { kind: "saved", receipt },
    receipt.kind !== "written" && receipt.kind !== "unchanged",
    receipt.kind === "written" && receipt.save === "saved"
      ? "completed"
      : receipt.kind === "filesystem" && receipt.code === "publication-uncertain"
        ? "uncertain"
        : "none",
  );
}
