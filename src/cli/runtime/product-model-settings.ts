/** Local composition for the shared model settings service. No model calls on save. */

import { createUserCatalogModelDiscovery } from "../../application/providers/model-catalogs.ts";
import {
  createModelSettingsService,
  type ModelSettingsSnapshot,
} from "../../application/providers/model-settings.ts";
import { resolveConfigurationFilePath, writeConfigurationValue } from "../../config/index.ts";
import { joinPath } from "../../domain/workspace/index.ts";
import { createSha256Hasher } from "../../integrations/filesystem/content-digest.ts";
import { parseProviderConnectionState } from "../../providers/configuration/connection-schema.ts";
import type { RoleRoute } from "../../providers/configuration/policy.ts";
import { reasoningControlFor } from "../../providers/routing/routing.ts";
import type { GlobalOptions } from "../options.ts";
import {
  MODEL_POLICY_CONFIGURATION_KEY,
  modelPreferencesFrom,
  modelPreferencesValue,
} from "./model-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import {
  DEFAULT_PROVIDER_CONNECTION_STATE,
  PROVIDER_CONNECTIONS_CONFIGURATION_KEY,
} from "./provider-configuration.ts";
import type { Services } from "./services.ts";

export function composeProductModelSettings(
  services: Services,
  globals: GlobalOptions,
  main?: () => RoleRoute | null,
) {
  const scope = globals.profile === null ? "user" : "profile";
  const request = {
    configurationRoot: services.configurationRoot,
    workspaceRoot: services.workspaceRoot,
    profile: globals.profile,
    scope,
  } as const;
  const path = resolveConfigurationFilePath(request);
  const readConfiguration = async (signal?: AbortSignal) => {
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
    async read(signal): Promise<ModelSettingsSnapshot> {
      if (!path.ok) throw new Error("Settings scope is unavailable.");
      const before = await services.fileSystem.stat(path.value, signal);
      if (!before.ok) throw new Error("Settings file is unavailable.");
      const loaded = await readConfiguration(signal);
      const after = await services.fileSystem.stat(path.value, signal);
      if (!after.ok || before.value?.revision !== after.value?.revision)
        throw new Error("Settings changed during inspection.");
      const preferences = modelPreferencesFrom(loaded.values);
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
        fileRevision: after.value?.revision ?? null,
        scope,
        generation: Number(loaded.generation),
        main: captured,
        // Definition owners attach their actual catalogs when their runtime ships.
        definitions: [],
      };
    },
    async write(preferences, expectedRevision, signal) {
      const result = await writeConfigurationValue(
        services.registry,
        services.fileSystem,
        {
          ...request,
          legacyConfigurationRoot: services.legacyConfigurationRoot,
          keyPath: MODEL_POLICY_CONFIGURATION_KEY,
          value: modelPreferencesValue(preferences),
          expectedRevision,
          requireAbsent: expectedRevision === null,
        },
        signal,
      );
      if (result.kind === "written") {
        // Publication already happened. A cancelled refresh must not report the write as failed.
        try {
          await readConfiguration(signal);
        } catch {
          // The next inspection/turn reloads through the same configuration owner.
        }
        return { kind: "written", revision: result.revision };
      }
      return {
        kind:
          result.kind === "stale-write"
            ? "stale"
            : result.kind === "cancelled"
              ? "cancelled"
              : "failed",
        code: result.kind,
      };
    },
    async backup(original, expectedRevision, signal) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 1, expectedRevision, original }, null, 2),
      );
      if (bytes.length > 1_048_576) return { ok: false, code: "migration-backup-too-large" };
      const hasher = createSha256Hasher().create();
      hasher.update(bytes);
      const directory = joinPath(services.configurationRoot, "model-policy-backups");
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
