/** Product composition for provider state, credentials, and live adapter handoff. */

import {
  composeProductCredentials,
  createProviderConnectionService,
  type ProviderConnectionHandoffResult,
  type ProviderConnectionService,
  type ProviderConnectionStorePort,
  resolveProviderApiKey,
} from "../application/index.ts";
import { resolveConfigurationFilePath, writeConfigurationValue } from "../config/index.ts";
import type { ConfigurationValues } from "../domain/index.ts";
import {
  createHostCommandRunner,
  hostPlatform,
  type OwnedProcessRegistry,
} from "../integrations/index.ts";
import { parseProviderConnectionState } from "../providers/index.ts";
import type { OpenAiCompatibleFetch } from "../providers/openai-compatible-adapter.ts";
import { createOpenAiCompatibleAdapter } from "../providers/openai-compatible-adapter.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import type { GlobalOptions } from "./options.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import {
  DEFAULT_PROVIDER_CONNECTION_STATE,
  PROVIDER_CONNECTIONS_CONFIGURATION_KEY,
} from "./provider-configuration.ts";
import type { Services } from "./services.ts";

export type ProductProviderConnectionHandoff =
  | {
      readonly kind: "ready";
      readonly adapter: ProviderAdapterPort;
      readonly session: Extract<ProviderConnectionHandoffResult, { readonly kind: "ready" }>;
    }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly session: ProviderConnectionHandoffResult;
    };

export type ProductProviderConnections = {
  readonly service: ProviderConnectionService;
  resolveSelected(signal?: AbortSignal): Promise<ProductProviderConnectionHandoff>;
};

export type ProductProviderConnectionOptions = {
  readonly ownedProcesses?: OwnedProcessRegistry;
  /** Reuse an already-loaded generation on bootstrap paths. */
  readonly configuration?: ConfigurationValues;
  /** Injectable controlled transport for provider integration fixtures. */
  readonly providerFetch?: OpenAiCompatibleFetch;
};

export function composeProductProviderConnections(
  services: Services,
  globals: GlobalOptions,
  options: ProductProviderConnectionOptions = {},
): ProductProviderConnections {
  const commands = createHostCommandRunner(
    options.ownedProcesses === undefined ? {} : { ownedProcesses: options.ownedProcesses },
  );
  const credentials = composeProductCredentials({
    clock: services.clock,
    commands,
    platform: hostPlatform(),
    environment: services.environment,
  });
  const store = configurationStore(services, globals, options.configuration);
  const service = createProviderConnectionService({ store, credentials, clock: services.clock });

  return {
    service,
    async resolveSelected(signal) {
      const session = await service.openSelected(signal);
      if (session.kind !== "ready") {
        return { kind: "unavailable", code: session.issue.code, session };
      }
      const { profile } = session.connection;
      if (profile.adapterKind !== "openai-compatible" || profile.endpoint === null) {
        return { kind: "unavailable", code: "provider-adapter-unavailable", session };
      }
      const reference = profile.credential;
      if (reference === null) {
        return { kind: "unavailable", code: "credential-unset", session };
      }
      return {
        kind: "ready",
        session,
        adapter: createOpenAiCompatibleAdapter({
          profileId: profile.profileId,
          providerId: String(profile.providerId),
          displayName: profile.displayName,
          baseUrl: profile.endpoint,
          supportedModels: session.catalog.models.map((model) => String(model.modelId)),
          resolveApiKey: (requestSignal) =>
            resolveProviderApiKey(credentials.resolver, reference, requestSignal),
          ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
        }),
      };
    },
  };
}

function configurationStore(
  services: Services,
  globals: GlobalOptions,
  initialValues: ConfigurationValues | undefined,
): ProviderConnectionStorePort {
  let supplied = initialValues;
  const scope = globals.profile === null ? "user" : "profile";

  return {
    async read(signal) {
      const values =
        supplied ??
        (await loadProductConfiguration(services, productConfigurationLoadRequest(globals), signal))
          .values;
      supplied = undefined;
      const parsed = parseProviderConnectionState(
        values[PROVIDER_CONNECTIONS_CONFIGURATION_KEY] ?? DEFAULT_PROVIDER_CONNECTION_STATE,
      );

      const home = await services.configurationHomeForRead(signal);
      const readRoot =
        home.kind === "current" || home.kind === "legacy" || home.kind === "empty"
          ? home.root
          : services.configurationRoot;
      const path = resolveConfigurationFilePath({
        configurationRoot: readRoot,
        workspaceRoot: services.workspaceRoot,
        profile: globals.profile,
        scope,
      });
      const stated = path.ok ? await services.fileSystem.stat(path.value, signal) : null;
      return {
        state: parsed.ok ? parsed.value : DEFAULT_PROVIDER_CONNECTION_STATE,
        fileRevision: stated?.ok && stated.value !== null ? stated.value.revision : null,
      };
    },
    async write(state, expectedFileRevision, signal) {
      const outcome = await writeConfigurationValue(
        services.registry,
        services.fileSystem,
        {
          configurationRoot: services.configurationRoot,
          legacyConfigurationRoot: services.legacyConfigurationRoot,
          workspaceRoot: services.workspaceRoot,
          profile: globals.profile,
          scope,
          keyPath: PROVIDER_CONNECTIONS_CONFIGURATION_KEY,
          value: state,
          expectedRevision: expectedFileRevision,
          requireAbsent: expectedFileRevision === null,
        },
        signal,
      );
      switch (outcome.kind) {
        case "written":
          return { kind: "written", fileRevision: outcome.revision };
        case "stale-write":
          return { kind: "stale" };
        case "cancelled":
          return { kind: "cancelled" };
        case "rejected":
          return { kind: "failed", code: "configuration-rejected" };
        case "workspace-required":
        case "profile-required":
        case "filesystem":
          return { kind: "failed", code: outcome.kind };
      }
    },
  };
}
