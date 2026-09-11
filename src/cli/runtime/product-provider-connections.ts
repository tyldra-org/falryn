import {
  createHostSandbox,
  installationSandboxPolicy,
} from "../../integrations/security/host-sandbox.ts";
/** Product composition for provider state, credentials, and live adapter handoff. */

import {
  createAuthorizedLoginAdapterRegistry,
  createAuthorizedProviderLogin,
  resolveProviderApiKey,
} from "../../application/authentication/index.ts";
import {
  createProviderConnectionService,
  createUserCatalogModelDiscovery,
  type ProviderConnectionHandoffResult,
  type ProviderConnectionService,
  type ProviderConnectionStorePort,
} from "../../application/providers/index.ts";
import { resolveConfigurationFilePath, writeConfigurationValue } from "../../config/index.ts";
import type { ModelCatalogGenerationRepository } from "../../data/index.ts";
import type { ConfigurationValues } from "../../domain/configuration/index.ts";
import {
  createAnthropicSdkAdapter,
  createCommandCodeProviderAdapter,
  createGoogleGenAiSdkAdapter,
  createHostAuthorizedProviderLogin,
  createHostCommandRunner,
  createOfficialModelDiscovery,
  createOpenAiCodexAuthorizedLoginAdapter,
  createOpenAiProviderAdapter,
  hostPlatform,
  type OpenAiSdkFetch,
  type OperatingSystemSecretsPort,
  type OwnedProcessRegistry,
} from "../../integrations/index.ts";
import { providerDestinationId } from "../../integrations/providers/provider-destination.ts";
import type {
  AuthorizationInteractionPort,
  AuthorizedProviderLoginHost,
  ModelDiscoveryPort,
  ProviderAuthorizedLoginAdapter,
  ProviderContinuationStatePort,
} from "../../providers/index.ts";
import {
  COMMAND_CODE_OPENAI_BASE_URL,
  OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
  parseProviderConnectionState,
  resolveProviderTransportCompatibility,
} from "../../providers/index.ts";
import type { ProviderAdapterPort } from "../../providers/protocol/port.ts";
import type { GlobalOptions } from "../options.ts";
import { modelPreferencesFrom } from "./model-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductCredentials } from "./product-credentials.ts";
import {
  createCachedModelDiscovery,
  productModelCatalogCacheOptions,
} from "./product-model-catalog-cache.ts";
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
  resolveProfile(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ProductProviderConnectionHandoff>;
};

export type ProductProviderConnectionOptions = {
  readonly ownedProcesses?: OwnedProcessRegistry;
  /** Reuse an already-loaded generation on bootstrap paths. */
  readonly configuration?: ConfigurationValues;
  /** Injectable controlled transport for provider integration fixtures. */
  readonly providerFetch?: OpenAiSdkFetch;
  /** Injectable discovery boundary for deterministic provider fixtures. */
  readonly modelDiscovery?: ModelDiscoveryPort;
  /** Durable effective generations used by executed model routes. */
  readonly modelCatalogs?: ModelCatalogGenerationRepository;
  /** Durable exact-route state used by stateful provider SDK transports. */
  readonly providerContinuations?: ProviderContinuationStatePort;
  /** Installed provider-specific authorized-login adapters. */
  readonly authorizedLoginAdapters?: readonly ProviderAuthorizedLoginAdapter[];
  /** Injectable complete host for deterministic coordinator tests. */
  readonly authorizedLoginHost?: AuthorizedProviderLoginHost;
  /** Human interaction used by manual and device-code flows. */
  readonly authorizationInteraction?: AuthorizationInteractionPort;
  /** Browser launch remains opt-in and is always disabled in headless mode. */
  readonly allowAuthorizationBrowser?: boolean;
  /** Injectable operating-system vault used by end-to-end tests. */
  readonly credentialSecrets?: OperatingSystemSecretsPort;
};

const credentialOwners = new Map<string, object>();

function credentialOwner(services: Services, globals: GlobalOptions): object {
  const key = JSON.stringify([services.configurationRoot, globals.profile]);
  let owner = credentialOwners.get(key);
  if (owner === undefined) {
    owner = {};
    credentialOwners.set(key, owner);
  }
  return owner;
}

export function composeProductProviderConnections(
  services: Services,
  globals: GlobalOptions,
  options: ProductProviderConnectionOptions = {},
): ProductProviderConnections {
  // Authentication is a trusted host operation, disclosed separately by doctor.
  const commands = createHostCommandRunner({
    sandbox: createHostSandbox({ policy: installationSandboxPolicy }),
    ...(options.ownedProcesses === undefined ? {} : { ownedProcesses: options.ownedProcesses }),
  });
  const credentialOptions = {
    clock: services.clock,
    commands,
    platform: hostPlatform(),
    environment: services.environment,
  };
  const credentials =
    options.credentialSecrets === undefined
      ? composeProductCredentials(credentialOptions)
      : composeProductCredentials({ ...credentialOptions, secrets: options.credentialSecrets });
  const authorizedAdapters = options.authorizedLoginAdapters ?? [
    createOpenAiCodexAuthorizedLoginAdapter(),
  ];
  let authorizedLogin: ReturnType<typeof createAuthorizedProviderLogin> | undefined;
  if (authorizedAdapters.length > 0) {
    let host = options.authorizedLoginHost;
    if (host === undefined) {
      const hostOptions = {
        commands,
        platform: hostPlatform(),
        environment: services.environment,
        allowBrowser: options.allowAuthorizationBrowser === true && !globals.nonInteractive,
      };
      host =
        options.authorizationInteraction === undefined
          ? createHostAuthorizedProviderLogin(hostOptions)
          : createHostAuthorizedProviderLogin({
              ...hostOptions,
              interaction: options.authorizationInteraction,
            });
    }
    authorizedLogin = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry(authorizedAdapters),
      credentials,
      clock: services.clock,
      host,
    });
  }
  const store = configurationStore(services, globals, options.configuration);
  const remoteDiscovery =
    options.modelDiscovery ??
    createCachedModelDiscovery(
      createOfficialModelDiscovery({
        resolveApiKey: async (profile, signal) => {
          const reference = profile.credential;
          return reference === null
            ? null
            : resolveProviderApiKey(credentials.resolver, reference, signal);
        },
      }),
      productModelCatalogCacheOptions(services),
    );
  const staticDiscovery = createUserCatalogModelDiscovery({
    fileSystem: services.fileSystem,
    async configurationRoot() {
      const home = await services.configurationHomeForRead();
      return home.kind === "current" || home.kind === "legacy" || home.kind === "empty"
        ? home.root
        : services.configurationRoot;
    },
  });
  const service = createProviderConnectionService({
    store,
    credentials,
    clock: services.clock,
    session: { staticDiscovery, remoteDiscovery },
    ...(authorizedLogin === undefined ? {} : { authorizedLogin }),
  });

  async function resolve(
    profileId: string | undefined,
    signal?: AbortSignal,
    admitted = false,
  ): Promise<ProductProviderConnectionHandoff> {
    const values =
      options.configuration ??
      (await loadProductConfiguration(services, productConfigurationLoadRequest(globals), signal))
        .values;
    const session = await service.openSelected(
      signal,
      profileId ?? modelPreferencesFrom(values).roles.default?.providerProfileId,
    );
    if (session.kind !== "ready") {
      return { kind: "unavailable", code: session.issue.code, session };
    }
    let handedOff = false;
    try {
      const { profile } = session.connection;
      if (options.modelCatalogs !== undefined) {
        const published = options.modelCatalogs.publish({
          profileId: profile.profileId,
          providerId: profile.providerId,
          adapterKind: profile.adapterKind,
          endpoint: profile.endpoint,
          destinationId: providerDestinationId(profile.adapterKind, profile.endpoint),
          catalog: session.catalog,
          publishedAt: services.clock.now(),
        });
        if (!published.ok) {
          return { kind: "unavailable", code: `catalog-${published.error.code}`, session };
        }
      }
      const reference = profile.credential;
      if (reference === null) {
        return { kind: "unavailable", code: "credential-unset", session };
      }
      const common = {
        profileId: profile.profileId,
        providerId: String(profile.providerId),
        displayName: profile.displayName,
        requestTimeoutMs: profile.timeouts.requestMs,
        supportedModels: session.catalog.models.map((model) => String(model.modelId)),
        modelCompatibility: profile.modelTransportCompatibility ?? [],
        resolveApiKey: (requestSignal: AbortSignal) =>
          resolveProviderApiKey(credentials.resolver, reference, requestSignal),
      };
      const compatibility = resolveProviderTransportCompatibility(
        profile.adapterKind,
        profile.transportCompatibility,
      );
      if (!compatibility.ok) {
        return {
          kind: "unavailable",
          code: `transport-compatibility-${compatibility.error.code}`,
          session,
        };
      }
      let adapter: ProviderAdapterPort;
      switch (profile.adapterKind) {
        case "openai":
          if (profile.endpoint === null) {
            return { kind: "unavailable", code: "provider-adapter-unavailable", session };
          }
          if (
            compatibility.value.declaration.dialect !== "openai-chat-completions" &&
            compatibility.value.declaration.dialect !== "openai-responses"
          ) {
            return { kind: "unavailable", code: "transport-compatibility-mismatch", session };
          }
          adapter = createOpenAiProviderAdapter({
            ...common,
            baseUrl: profile.endpoint,
            compatibility: compatibility.value.declaration,
            organization: profile.organization,
            project: profile.project,
            ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
            ...(options.providerContinuations === undefined
              ? {}
              : { continuationState: options.providerContinuations }),
            now: () => services.clock.now(),
          });
          break;
        case "anthropic":
          if (compatibility.value.declaration.dialect !== "anthropic-messages") {
            return { kind: "unavailable", code: "transport-compatibility-mismatch", session };
          }
          adapter = createAnthropicSdkAdapter({
            ...common,
            baseUrl: profile.endpoint,
            compatibility: compatibility.value.declaration,
            ...(options.providerContinuations === undefined
              ? {}
              : { continuationState: options.providerContinuations }),
            now: () => services.clock.now(),
          });
          break;
        case "google":
          if (compatibility.value.declaration.dialect !== "google-generate-content") {
            return { kind: "unavailable", code: "transport-compatibility-mismatch", session };
          }
          adapter = createGoogleGenAiSdkAdapter({
            ...common,
            baseUrl: profile.endpoint,
            compatibility: compatibility.value.declaration,
            ...(options.providerContinuations === undefined
              ? {}
              : { continuationState: options.providerContinuations }),
            now: () => services.clock.now(),
          });
          break;
        case "commandcode":
          if (profile.endpoint !== COMMAND_CODE_OPENAI_BASE_URL) {
            return { kind: "unavailable", code: "provider-adapter-unavailable", session };
          }
          if (compatibility.value.declaration.dialect !== "command-code-router") {
            return { kind: "unavailable", code: "transport-compatibility-mismatch", session };
          }
          adapter = createCommandCodeProviderAdapter({
            ...common,
            compatibility: compatibility.value.declaration,
            ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }),
          });
          break;
        case "openai-codex":
          return {
            kind: "unavailable",
            code: OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
            session,
          };
        case "custom":
        case "deterministic":
          return { kind: "unavailable", code: "provider-adapter-unavailable", session };
        default: {
          const exhaustive: never = profile.adapterKind;
          return exhaustive;
        }
      }
      const boundAdapter = adapter;
      if (!admitted)
        adapter = {
          ...boundAdapter,
          async *stream(request, streamOptions) {
            const current = await resolve(profile.profileId, streamOptions.signal, true);
            if (current.kind !== "ready") throw new Error(`provider-${current.code}`);
            try {
              if (
                current.adapter.identity.destinationId !== boundAdapter.identity.destinationId ||
                current.adapter.identity.transportCompatibilityId !==
                  boundAdapter.identity.transportCompatibilityId ||
                current.adapter.identity.providerId !== boundAdapter.identity.providerId
              )
                throw new Error("provider-generation-stale");
              yield* current.adapter.stream(request, streamOptions);
            } finally {
              await current.session.release();
            }
          },
        };
      handedOff = admitted;
      return {
        kind: "ready",
        session,
        adapter,
      };
    } finally {
      if (!handedOff) await session.release();
    }
  }
  return {
    service,
    resolveSelected: (signal) => resolve(undefined, signal),
    resolveProfile: (profileId, signal) => resolve(profileId, signal),
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
    ownership: credentialOwner(services, globals),
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
