/** Local composition for the shared model settings service. No model calls on save. */

import { loadWorkflowFiles } from "../../application/orchestration/workflow-files.ts";
import { createUserCatalogModelDiscovery } from "../../application/providers/model-catalogs.ts";
import {
  createModelSettingsService,
  type ModelSettingsSnapshot,
} from "../../application/providers/model-settings.ts";
import { inspectProcessingRoute } from "../../application/providers/processing-controls.ts";
import { parseConfigurationDocument } from "../../config/document/document.ts";
import { configurationObject } from "../../config/document/organized.ts";
import { usesOrganizedConfiguration } from "../../config/document/schema-family.ts";
import { writeConfigurationEdits } from "../../config/host/writer.ts";
import { resolveConfigurationFilePath, writeConfigurationValue } from "../../config/index.ts";
import {
  PROCESSING_MODES,
  resolveProcessingPreference,
} from "../../domain/sessions/model-processing.ts";
import { joinPath } from "../../domain/workspace/index.ts";
import { createSha256Hasher } from "../../integrations/filesystem/content-digest.ts";
import { parseProviderConnectionState } from "../../providers/configuration/connection-schema.ts";
import type { RoleRoute } from "../../providers/configuration/policy.ts";
import { modelPreferencesSchema } from "../../providers/configuration/policy-schema.ts";
import { reasoningControlFor } from "../../providers/routing/routing.ts";
import type { GlobalOptions } from "../options.ts";
import { agentRegistryFrom } from "./agent-configuration.ts";
import {
  MODEL_POLICY_CONFIGURATION_KEY,
  modelPreferencesFrom,
  modelPreferencesValue,
} from "./model-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
  validateProductConfigurationCandidate,
} from "./product-configuration.ts";
import { composeProductProviderConnections } from "./product-provider-connections.ts";
import {
  DEFAULT_PROVIDER_CONNECTION_STATE,
  PROVIDER_CONNECTIONS_CONFIGURATION_KEY,
} from "./provider-configuration.ts";
import type { Services } from "./services.ts";
import { ownedModelOverridePaths, workingModelEdits } from "./working-model-edits.ts";

export function composeProductModelSettings(
  services: Services,
  globals: GlobalOptions,
  main?: () => RoleRoute | null,
  transitions?: {
    afterSave(
      revision: string,
      signal?: AbortSignal,
    ): Promise<
      import("../../domain/configuration/profile-transition.ts").ProfileTransitionReceipt | null
    >;
  },
) {
  const scope = globals.profile === null ? "user" : "profile";
  const request = {
    configurationRoot: services.configurationRoot,
    workspaceRoot: services.workspaceRoot,
    profile: globals.profile,
    scope,
  } as const;
  const sourcePath = async (signal?: AbortSignal) => {
    const home = await services.configurationHomeForRead(signal);
    if (home.kind !== "current" && home.kind !== "legacy" && home.kind !== "empty")
      throw new Error("Settings home is unavailable.");
    const path = resolveConfigurationFilePath({ ...request, configurationRoot: home.root });
    if (!path.ok) throw new Error("Settings scope is unavailable.");
    return path.value;
  };
  const readConfiguration = async (signal?: AbortSignal) => {
    if (transitions) {
      const project = await services.workspaceTrust.project(signal);
      const outcome = await services.loader.preview(
        {
          ...request,
          legacyConfigurationRoot: services.legacyConfigurationRoot,
          projectText: project.text,
          privateProjectText: project.privateText ?? null,
        },
        signal,
      );
      if (outcome.kind !== "candidate" && outcome.kind !== "unchanged")
        throw new Error(
          "Configuration is unavailable; repair it before changing model preferences.",
        );
      return {
        trust: project.report,
        values: outcome.record.values,
        generation: outcome.record.generation,
      };
    }
    const loaded = await loadProductConfiguration(
      services,
      productConfigurationLoadRequest(globals),
      signal,
    );
    if (loaded.outcome.kind !== "published" && loaded.outcome.kind !== "unchanged")
      throw new Error("Configuration is unavailable; repair it before changing model preferences.");
    return loaded;
  };
  return createModelSettingsService({
    async inspectProcessing(route, signal) {
      const localDiscovery = createUserCatalogModelDiscovery({
        fileSystem: services.fileSystem,
        configurationRoot: async () => {
          const home = await services.configurationHomeForRead(signal);
          return home.kind === "current" || home.kind === "legacy" || home.kind === "empty"
            ? home.root
            : services.configurationRoot;
        },
      });
      const provider = await composeProductProviderConnections(services, globals, {
        authorizedLoginAdapters: [],
        modelDiscovery: localDiscovery,
      }).resolveProfile(route.providerProfileId, signal);
      if (provider.kind === "ready")
        return inspectProcessingRoute(provider.adapter, provider.session.catalog, route);
      const preference = resolveProcessingPreference([route.processing]);
      return {
        route,
        preference,
        modes: PROCESSING_MODES.map((mode) => ({
          eligible: false as const,
          reason: provider.code,
          preference: { ...preference, mode },
        })),
      };
    },
    async read(signal): Promise<ModelSettingsSnapshot> {
      const path = await sourcePath(signal);
      const before = await services.fileSystem.stat(path, signal);
      if (!before.ok) throw new Error("Settings file is unavailable.");
      const loaded = await readConfiguration(signal);
      const bytes =
        before.value === null ? null : await services.fileSystem.readText(path, 262144, signal);
      if (bytes !== null && !bytes.ok) throw new Error("Settings source is unavailable.");
      const source = bytes === null ? null : parseConfigurationDocument(bytes.value);
      const organized = bytes === null || (source !== null && usesOrganizedConfiguration(source));
      const settings = source?.[scope === "profile" ? "overrides" : "defaults"];
      const models = configurationObject(settings) ? settings.models : undefined;
      const owned = configurationObject(models) ? models.policy : undefined;
      const after = await services.fileSystem.stat(path, signal);
      if (
        !after.ok ||
        before.value?.revision !== after.value?.revision ||
        path !== (await sourcePath(signal))
      )
        throw new Error("Settings changed during inspection.");
      const preferences = modelPreferencesFrom(loaded.values);
      const workflows = await loadWorkflowFiles(
        {
          fileSystem: services.fileSystem,
          configurationRoot: services.configurationRoot,
          workspaceRoot: services.workspaceRoot,
          trust: loaded.trust,
        },
        signal,
      );
      if (!workflows.ok) throw new Error(workflows.error.code);
      const connections = parseProviderConnectionState(
        loaded.values[PROVIDER_CONNECTIONS_CONFIGURATION_KEY] ?? DEFAULT_PROVIDER_CONNECTION_STATE,
      );
      const selected = connections.ok
        ? connections.value.connections.find(
            (entry) => entry.profile.profileId === connections.value.selectedProfileId,
          )
        : undefined;
      const selectedModel = selected?.profile.enabledModels[0];
      const captured =
        main?.() ??
        preferences.roles.default ??
        (selected === undefined || selectedModel === undefined
          ? null
          : {
              providerProfileId: selected.profile.profileId,
              providerId: selected.profile.providerId,
              modelId: selectedModel,
              reasoning: "provider-default" as const,
              fallbacks: [],
              budgets: {},
            });
      return {
        preferences,
        ...(organized ? { ownedOverridePaths: ownedModelOverridePaths(owned) } : {}),
        ...(!modelPreferencesSchema.safeParse(loaded.values[MODEL_POLICY_CONFIGURATION_KEY]).success
          ? { legacyPolicy: loaded.values[MODEL_POLICY_CONFIGURATION_KEY] }
          : {}),
        fileRevision: after.value?.revision ?? null,
        scope,
        generation: Number(loaded.generation),
        main: captured,
        definitions: [...agentRegistryFrom(loaded.values).models(), ...workflows.value.models()],
      };
    },
    async write(preferences, expectedRevision, signal, mutation) {
      const path = await sourcePath(signal);
      const source =
        expectedRevision === null ? null : await services.fileSystem.readText(path, 262144, signal);
      if (source !== null && !source.ok)
        return { kind: "failed", code: "settings-source-unavailable" };
      const document = source === null ? null : parseConfigurationDocument(source.value);
      const organized =
        source === null || (document !== null && usesOrganizedConfiguration(document));
      const result =
        organized && mutation !== undefined
          ? await writeConfigurationEdits(
              services.registry,
              services.fileSystem,
              {
                ...request,
                legacyConfigurationRoot: services.legacyConfigurationRoot,
                expectedRevision,
                edits: workingModelEdits(
                  [scope === "profile" ? "overrides" : "defaults", "models", "policy"],
                  preferences,
                  mutation,
                ),
                validateCandidate: (path, text, abort) =>
                  validateProductConfigurationCandidate(
                    services,
                    globals.profile,
                    path,
                    text,
                    abort,
                  ),
              },
              signal,
            )
          : await writeConfigurationValue(
              services.registry,
              services.fileSystem,
              {
                ...request,
                legacyConfigurationRoot: services.legacyConfigurationRoot,
                keyPath: MODEL_POLICY_CONFIGURATION_KEY,
                value: modelPreferencesValue(preferences),
                expectedRevision,
                requireAbsent: expectedRevision === null,
                validateCandidate: (path, text, abort) =>
                  validateProductConfigurationCandidate(
                    services,
                    globals.profile,
                    path,
                    text,
                    abort,
                  ),
              },
              signal,
            );
      if (result.kind === "written") {
        try {
          if (transitions) {
            const transition = await transitions.afterSave(result.revision, signal);
            return {
              kind: "written",
              revision: result.revision,
              receipt: {
                ...result,
                transition,
                publication: transition?.publishedGeneration == null ? "failed" : "published",
                generation: transition?.publishedGeneration ?? null,
                application: transition?.code === "applied" ? "applied" : "pending",
              },
            };
          }
          const loaded = await readConfiguration(signal);
          return {
            kind: "written",
            revision: result.revision,
            receipt: {
              ...result,
              publication: "published",
              generation: Number(loaded.generation),
              application: "pending",
            },
          };
        } catch {
          return {
            kind: "written",
            revision: result.revision,
            receipt: { ...result, publication: "failed", generation: null, application: "failed" },
          };
        }
      }
      return {
        kind:
          result.kind === "stale-write"
            ? "stale"
            : result.kind === "cancelled"
              ? "cancelled"
              : "failed",
        code: result.kind === "filesystem" ? result.code : result.kind,
      };
    },
    async backup(original, expectedRevision, signal) {
      const path = await sourcePath(signal).catch(() => null);
      if (path === null) return { ok: false, code: "backup-source-unavailable" };
      const before = await services.fileSystem.stat(path, signal);
      if (!before.ok || (before.value?.revision ?? null) !== expectedRevision)
        return { ok: false, code: "stale-settings" };
      let text: string | null = null;
      if (before.value !== null) {
        const source = await services.fileSystem.readBytes(path, 1_048_576, signal);
        if (!source.ok) return { ok: false, code: "backup-source-unavailable" };
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.value);
        } catch {
          return { ok: false, code: "backup-source-encoding" };
        }
      }
      const after = await services.fileSystem.stat(path, signal);
      if (
        !after.ok ||
        (after.value?.revision ?? null) !== expectedRevision ||
        path !== (await sourcePath(signal).catch(() => null))
      )
        return { ok: false, code: "stale-settings" };
      const bytes = new TextEncoder().encode(
        JSON.stringify(
          { schemaVersion: 2, expectedRevision, original, source: { path, text } },
          null,
          2,
        ),
      );
      if (bytes.length > 1_048_576) return { ok: false, code: "migration-backup-too-large" };
      const hasher = createSha256Hasher().create();
      hasher.update(bytes);
      // Recovery must survive a configuration-home move and must not populate
      // the destination before the comment-preserving writer validates it.
      const stateRoot = services.localData.layout.roots.find((root) => root.root === "state");
      if (stateRoot === undefined) return { ok: false, code: "backup-path-invalid" };
      const directory = joinPath(stateRoot.path, "model-policy-backups");
      if (!directory.ok) return { ok: false, code: "backup-path-invalid" };
      const backup = joinPath(directory.value, `${String(hasher.digest()).split(":").at(-1)}.json`);
      if (!backup.ok) return { ok: false, code: "backup-path-invalid" };
      const made = await services.fileSystem.createDirectory(directory.value, 0o700, signal);
      if (!made.ok) return { ok: false, code: "backup-directory-unavailable" };
      const written = await services.fileSystem.writeBytes(backup.value, bytes, signal);
      if (!written.ok) return { ok: false, code: "backup-write-failed" };
      return { ok: true, location: String(backup.value) };
    },
    async validateRoute(route, signal) {
      const loaded = await readConfiguration(signal);
      const parsed = parseProviderConnectionState(
        loaded.values[PROVIDER_CONNECTIONS_CONFIGURATION_KEY],
      );
      const profile = parsed.ok
        ? parsed.value.connections.find(
            (entry) =>
              entry.profile.profileId === route.providerProfileId &&
              entry.profile.providerId === route.providerId,
          )?.profile
        : undefined;
      if (profile === undefined) return { ok: false, code: "provider-profile-missing" };
      const catalog = await createUserCatalogModelDiscovery({
        fileSystem: services.fileSystem,
        async configurationRoot() {
          return services.configurationRoot;
        },
      }).discover(profile, {
        signal: signal ?? new AbortController().signal,
        now: services.clock.now(),
      });
      const capability =
        catalog.kind === "catalog"
          ? catalog.catalog.models.find((entry) => entry.modelId === route.modelId)
          : undefined;
      if (capability === undefined || capability.availability === "unavailable")
        return { ok: false, code: "model-unavailable" };
      if (
        route.reasoning !== "provider-default" &&
        reasoningControlFor(capability, route.reasoning, profile.adapterKind) === null
      )
        return { ok: false, code: "unsupported-thinking" };
      return { ok: true };
    },
  });
}
