/**
 * Provider connection actions over configuration, credentials, and discovery.
 * Secret bytes exist only during a protected login call and never appear in a
 * result, persisted state, diagnostic, or provider handoff.
 */

import type { CredentialReference } from "../../domain/configuration/index.ts";
import type { ClockPort } from "../../domain/foundation/index.ts";
import {
  type DiscoveryOutcome,
  MAX_PROVIDER_CONNECTIONS,
  type ModelCatalog,
  OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
  openProviderSession,
  PROVIDER_CONNECTION_SCHEMA_VERSION,
  type ProviderAuthorizationReceipt,
  type ProviderAuthSnapshot,
  type ProviderConnection,
  type ProviderConnectionState,
  type ProviderProfile,
  parseProviderConnectionState,
  parseProviderProfile,
  profileCredentialConsumer,
  providerEndpointIsAllowed,
} from "../../providers/index.ts";
import type {
  ProviderConnectionAction,
  ProviderConnectionActionResult,
  ProviderConnectionDiscoveryView,
  ProviderConnectionHandoffResult,
  ProviderConnectionIssueCode,
  ProviderConnectionService,
  ProviderConnectionServicePorts,
  ProviderConnectionStoreSnapshot,
  ProviderConnectionStoreWriteResult,
  ProviderConnectionView,
} from "./provider-connections/contracts.ts";
import {
  createProviderCredentialLifetime,
  type ProviderCredentialLifetime,
  sameCredentialReference as sameReference,
} from "./provider-connections/credential-lifetime.ts";

type ServicePorts = ProviderConnectionServicePorts & {
  readonly lifetime: ProviderCredentialLifetime;
};

export * from "./provider-connections/contracts.ts";

export function createProviderConnectionService(
  supplied: ProviderConnectionServicePorts,
): ProviderConnectionService {
  const lifetime = createProviderCredentialLifetime(supplied);
  const ports: ServicePorts = { ...supplied, store: lifetime.store, lifetime };
  async function execute(
    action: ProviderConnectionAction,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionActionResult> {
    if (signal?.aborted === true) {
      return failure(action.kind, "cancelled", false);
    }
    const snapshot = await ports.store.read(signal);
    const parsed = parseProviderConnectionState(snapshot.state);
    if (!parsed.ok) {
      return failure(action.kind, "state-invalid", false);
    }
    switch (action.kind) {
      case "list":
        return success(
          action.kind,
          parsed.value,
          null,
          null,
          undefined,
          null,
          ports.authorizedLogin,
        );
      case "test":
        return testConnection(action, parsed.value, ports, signal);
      case "add":
        return add(action, snapshot, ports, signal);
      case "configure":
        return configure(action, snapshot, ports, signal);
      case "use":
        return select(action, snapshot, ports, signal);
      case "login-api-key":
        return loginApiKey(action, snapshot, ports, signal);
      case "login-authorized":
        return loginAuthorized(action, snapshot, ports, signal);
      case "logout":
        return logout(action, snapshot, ports, signal);
      case "remove":
        return remove(action, snapshot, ports, signal);
    }
  }

  return {
    execute: (action, signal) =>
      lifetime.run(
        async () => ({ ...(await execute(action, signal)), credentialChange: lifetime.change() }),
        () => failure(action.kind, "state-stale", true),
      ),
    selected: (signal) =>
      lifetime.run(
        () => execute({ kind: "test", profileId: null }, signal),
        () => failure("test", "state-stale", true),
      ),
    reconcile: () =>
      lifetime.run(
        () => lifetime.reconcile(),
        () => [],
      ),
    openSelected: (signal, profileId) =>
      lifetime.run(
        async () => {
          const snapshot = await ports.store.read(signal);
          const parsed = parseProviderConnectionState(snapshot.state);
          if (!parsed.ok || (profileId === undefined && parsed.value.selectedProfileId === null)) {
            return unavailableHandoff("selected-profile-required", false);
          }
          const selectedProfileId = profileId ?? parsed.value.selectedProfileId;
          if (selectedProfileId === null)
            return unavailableHandoff("selected-profile-required", false);
          let connection = find(parsed.value, selectedProfileId);
          if (connection === null) {
            return unavailableHandoff("profile-missing", false);
          }
          if (connection.profile.adapterKind === "openai-codex") {
            return unavailableHandoff(
              OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
              false,
              connection,
            );
          }
          const expired = expiredAuth(connection, ports.clock);
          if (expired !== null) {
            if (ports.authorizedLogin === undefined) {
              return unavailableHandoff("credential-expired", false, connection, expired);
            }
            const refreshing = connection;
            const refreshed = await ports.authorizedLogin.refresh(connection, signal, (reference) =>
              lifetime.prepare({
                ...refreshing,
                profile: { ...refreshing.profile, credential: reference },
              }),
            );
            if (refreshed.kind !== "refreshed") {
              return unavailableHandoff(refreshed.code, refreshed.retryable, connection, expired);
            }
            const replacement: ProviderConnection = {
              profile: { ...connection.profile, credential: refreshed.reference },
              account: refreshed.account,
              updatedAt: ports.clock.now(),
            };
            const next = changed(parsed.value, {
              connections: replace(parsed.value, replacement),
            });
            const written = await ports.store.write(next, snapshot.fileRevision, signal);
            if (written.kind !== "written") {
              await lifetime.retire(replacement);
              return {
                ...unavailableHandoff(
                  written.kind === "stale" ? "state-stale" : "state-write-failed",
                  true,
                  connection,
                  expired,
                ),
                credentialChange: lifetime.change(),
              };
            }
            connection = replacement;
          }
          const opened = await openProviderSession({
            profile: connection.profile,
            ports: {
              resolver: ports.credentials.resolver,
              clock: ports.clock,
              stores: ports.credentials.stores,
              ...ports.session,
            },
            ...(signal === undefined ? {} : { signal }),
          });
          if (opened.kind === "invalid-profile") {
            return unavailableHandoff("invalid-profile", false, connection);
          }
          if (opened.kind === "auth-not-ready" || opened.session.catalog === null) {
            return unavailableHandoff(
              opened.session.auth.code ?? "provider-not-ready",
              opened.session.auth.retryable,
              connection,
              opened.session.auth,
              opened.session.catalog,
            );
          }
          return {
            kind: "ready",
            connection,
            auth: opened.session.auth,
            catalog: opened.session.catalog,
            release: lifetime.retain(connection),
            credentialChange: lifetime.change(),
          };
        },
        () => unavailableHandoff("state-stale", true),
      ),
  };
}

async function add(
  action: Extract<ProviderConnectionAction, { readonly kind: "add" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  if (!endpointIsAllowed(action.profile)) {
    return failure(action.kind, "invalid-endpoint", false);
  }
  if (!parseProviderProfile(action.profile).ok) {
    return failure(action.kind, "invalid-profile", false);
  }
  if (find(snapshot.state, action.profile.profileId) !== null) {
    return failure(action.kind, "duplicate-profile", false);
  }
  if (snapshot.state.connections.length >= MAX_PROVIDER_CONNECTIONS) {
    return failure(action.kind, "profile-limit", false);
  }
  const next = changed(snapshot.state, {
    connections: [
      ...snapshot.state.connections,
      { profile: action.profile, account: null, updatedAt: ports.clock.now() },
    ],
    selectedProfileId: snapshot.state.selectedProfileId ?? action.profile.profileId,
  });
  return persistAndDiscover(action.kind, next, action.profile.profileId, snapshot, ports, signal);
}

async function configure(
  action: Extract<ProviderConnectionAction, { readonly kind: "configure" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  if (!endpointIsAllowed(action.profile)) {
    return failure(action.kind, "invalid-endpoint", false);
  }
  if (!parseProviderProfile(action.profile).ok) {
    return failure(action.kind, "invalid-profile", false);
  }
  const current = find(snapshot.state, action.profile.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (current.profile.credential !== null && action.profile.adapterKind === "openai-codex") {
    return failure(action.kind, "credential-already-configured", false);
  }
  const preservedCapabilities =
    action.preserveCapabilities &&
    current.profile.adapterKind === action.profile.adapterKind &&
    current.profile.providerId === action.profile.providerId
      ? current.profile.modelCapabilities.filter((capability) =>
          action.profile.enabledModels.some((model) => model === capability.modelId),
        )
      : [];
  const modelCapabilities = new Map(
    [...preservedCapabilities, ...action.profile.modelCapabilities].map((capability) => [
      String(capability.modelId),
      capability,
    ]),
  );
  const profile: ProviderProfile = {
    ...action.profile,
    ...(action.preserveCredential ? { credential: current.profile.credential } : {}),
    ...(action.preserveTransportCompatibility &&
    action.profile.transportCompatibility === null &&
    current.profile.transportCompatibility !== null &&
    current.profile.adapterKind === action.profile.adapterKind &&
    current.profile.providerId === action.profile.providerId &&
    current.profile.endpoint === action.profile.endpoint
      ? { transportCompatibility: current.profile.transportCompatibility }
      : {}),
    ...(action.preserveTransportCompatibility &&
    (action.profile.modelTransportCompatibility?.length ?? 0) === 0 &&
    (current.profile.modelTransportCompatibility?.length ?? 0) > 0 &&
    current.profile.adapterKind === action.profile.adapterKind &&
    current.profile.providerId === action.profile.providerId &&
    current.profile.endpoint === action.profile.endpoint
      ? { modelTransportCompatibility: current.profile.modelTransportCompatibility }
      : {}),
    modelCapabilities: [...modelCapabilities.values()],
  };
  const replacement: ProviderConnection = {
    profile,
    account: sameReference(current.profile.credential, profile.credential) ? current.account : null,
    updatedAt: ports.clock.now(),
  };
  const next = changed(snapshot.state, {
    connections: snapshot.state.connections.map((item) =>
      item.profile.profileId === action.profile.profileId ? replacement : item,
    ),
  });
  return persistAndDiscover(action.kind, next, action.profile.profileId, snapshot, ports, signal);
}

async function select(
  action: Extract<ProviderConnectionAction, { readonly kind: "use" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  if (find(snapshot.state, action.profileId) === null) {
    return failure(action.kind, "profile-missing", false);
  }
  return persistAndDiscover(
    action.kind,
    changed(snapshot.state, { selectedProfileId: action.profileId }),
    action.profileId,
    snapshot,
    ports,
    signal,
  );
}

async function testConnection(
  action: Extract<ProviderConnectionAction, { readonly kind: "test" }>,
  state: ProviderConnectionState,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const id = action.profileId ?? state.selectedProfileId;
  if (id === null) {
    return failure(action.kind, "selected-profile-required", false);
  }
  const connection = find(state, id);
  if (connection === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (connection.profile.adapterKind === "openai-codex") {
    return failure(action.kind, OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE, false);
  }
  const expired = expiredAuth(connection, ports.clock);
  if (expired !== null) {
    return failure(action.kind, "credential-expired", false, expired);
  }
  const opened = await openProviderSession({
    profile: connection.profile,
    ports: {
      resolver: ports.credentials.resolver,
      clock: ports.clock,
      stores: ports.credentials.stores,
      ...ports.session,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (opened.kind === "invalid-profile") {
    return failure(action.kind, "invalid-profile", false);
  }
  if (opened.kind === "auth-not-ready") {
    return failure(
      action.kind,
      "provider-not-ready",
      opened.session.auth.retryable,
      opened.session.auth,
      opened.session.catalog,
      discoveryView(opened.session.discovery),
    );
  }
  return success(
    action.kind,
    state,
    opened.session.auth,
    opened.session.catalog,
    discoveryView(opened.session.discovery),
  );
}

async function loginApiKey(
  action: Extract<ProviderConnectionAction, { readonly kind: "login-api-key" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (current.profile.credential !== null) {
    return failure(action.kind, "credential-already-configured", false);
  }
  if (current.profile.adapterKind === "openai-codex") {
    return failure(action.kind, OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE, false);
  }
  const reference: CredentialReference = {
    storeKind: "operating-system-keychain",
    locator: `falryn.provider.${current.profile.profileId}.${crypto.randomUUID()}`,
    consumer: `provider:${current.profile.profileId}`,
    accountLabel: action.accountLabel ?? current.profile.profileId,
  };
  if (
    !(await ports.lifetime.prepare({
      ...current,
      profile: { ...current.profile, credential: reference },
    }))
  )
    return failure(action.kind, "credential-write-failed", true);
  const placed = await ports.credentials.placeApiKey({ reference, secret: action.secret });
  if (placed.kind !== "written") {
    return failure(action.kind, "credential-write-failed", placed.kind === "failed");
  }
  const now = ports.clock.now();
  const replacement: ProviderConnection = {
    profile: { ...current.profile, credential: reference },
    account: {
      accountId: null,
      displayName: action.accountLabel,
      authMethod: "api-key",
      authorizedAt: now,
      expiresAt: null,
    },
    updatedAt: now,
  };
  const next = changed(snapshot.state, { connections: replace(snapshot.state, replacement) });
  const written = await ports.store.write(next, snapshot.fileRevision, signal);
  if (written.kind === "written") {
    return discoverConnection(action.kind, next, action.profileId, ports, signal);
  }
  const rollback = await ports.lifetime.retire(replacement);
  if (
    rollback.local !== "removed" &&
    rollback.local !== "not-present" &&
    rollback.outcome !== "old-reference-retained-shared"
  ) {
    return failure(action.kind, "credential-rollback-failed", true);
  }
  return writeFailure(action.kind, written);
}

async function loginAuthorized(
  action: Extract<ProviderConnectionAction, { readonly kind: "login-authorized" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (current.profile.credential !== null) {
    return failure(action.kind, "credential-already-configured", false);
  }
  if (ports.authorizedLogin === undefined) {
    return failure(action.kind, "authorized-login-unavailable", false);
  }
  const authorized = await ports.authorizedLogin.authorize(
    current.profile,
    action.method,
    signal,
    (reference) =>
      ports.lifetime.prepare({
        ...current,
        profile: { ...current.profile, credential: reference },
      }),
  );
  switch (authorized.kind) {
    case "cancelled":
      return failure(action.kind, "cancelled", false, null, null, undefined, authorized.receipt);
    case "denied":
      return failure(
        action.kind,
        "authorization-denied",
        false,
        null,
        null,
        undefined,
        authorized.receipt,
      );
    case "timed-out":
      return failure(
        action.kind,
        "authorization-timed-out",
        true,
        null,
        null,
        undefined,
        authorized.receipt,
      );
    case "failed":
      return failure(
        action.kind,
        authorizedLoginFailureCode(authorized.code),
        authorized.retryable,
        null,
        null,
        undefined,
        authorized.receipt,
      );
    case "authorized": {
      const now = ports.clock.now();
      if (
        authorized.account.authMethod !== action.method ||
        authorized.reference.consumer !== profileCredentialConsumer(current.profile) ||
        (authorized.account.expiresAt !== null && authorized.account.expiresAt <= now)
      ) {
        const rollback = await ports.lifetime.retire({
          ...current,
          profile: { ...current.profile, credential: authorized.reference },
        });
        return rollback.local === "removed" ||
          rollback.local === "not-present" ||
          rollback.outcome === "old-reference-retained-shared"
          ? failure(
              action.kind,
              "authorization-failed",
              false,
              null,
              null,
              undefined,
              authorized.receipt,
            )
          : failure(
              action.kind,
              "credential-rollback-failed",
              true,
              null,
              null,
              undefined,
              authorized.receipt,
            );
      }
      const replacement: ProviderConnection = {
        profile: { ...current.profile, credential: authorized.reference },
        account: authorized.account,
        updatedAt: now,
      };
      const next = changed(snapshot.state, {
        connections: replace(snapshot.state, replacement),
      });
      const written = await ports.store.write(next, snapshot.fileRevision, signal);
      if (written.kind === "written") {
        return discoverConnection(
          action.kind,
          next,
          action.profileId,
          ports,
          signal,
          authorized.receipt,
        );
      }
      const rollback = await ports.lifetime.retire(replacement);
      if (
        rollback.local !== "removed" &&
        rollback.local !== "not-present" &&
        rollback.outcome !== "old-reference-retained-shared"
      ) {
        return failure(
          action.kind,
          "credential-rollback-failed",
          true,
          null,
          null,
          undefined,
          authorized.receipt,
        );
      }
      return writeFailure(action.kind, written, authorized.receipt);
    }
  }
}

async function logout(
  action: Extract<ProviderConnectionAction, { readonly kind: "logout" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  const replacement: ProviderConnection = {
    profile: { ...current.profile, credential: null },
    account: null,
    updatedAt: ports.clock.now(),
  };
  const next = changed(snapshot.state, { connections: replace(snapshot.state, replacement) });
  const written = await ports.store.write(next, snapshot.fileRevision, signal);
  if (written.kind === "written") {
    return {
      ...success(action.kind, next, null, null, undefined, null, ports.authorizedLogin),
      revocation: ports.lifetime.reportFor(current.profile.credential) ?? {
        local: "not-present",
        remote: "not-attempted",
      },
    };
  }
  return writeFailure(action.kind, written);
}

async function remove(
  action: Extract<ProviderConnectionAction, { readonly kind: "remove" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (snapshot.state.selectedProfileId === action.profileId) {
    return failure(action.kind, "selected-profile-remove-refused", false);
  }
  const next = changed(snapshot.state, {
    connections: snapshot.state.connections.filter(
      (item) => item.profile.profileId !== action.profileId,
    ),
  });
  const written = await ports.store.write(next, snapshot.fileRevision, signal);
  if (written.kind === "written") {
    return {
      ...success(action.kind, next, null, null, undefined, null, ports.authorizedLogin),
      revocation: ports.lifetime.reportFor(current.profile.credential) ?? {
        local: "not-present",
        remote: "not-attempted",
      },
    };
  }
  return writeFailure(action.kind, written);
}

async function persistAndDiscover(
  action: ProviderConnectionAction["kind"],
  state: ProviderConnectionState,
  profileId: string,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const written = await ports.store.write(state, snapshot.fileRevision, signal);
  return written.kind === "written"
    ? discoverConnection(action, state, profileId, ports, signal)
    : writeFailure(action, written);
}

async function discoverConnection(
  action: ProviderConnectionAction["kind"],
  state: ProviderConnectionState,
  profileId: string,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
  authorization: ProviderAuthorizationReceipt | null = null,
): Promise<ProviderConnectionActionResult> {
  const connection = find(state, profileId);
  if (connection === null) {
    return success(action, state, null, null, undefined, authorization, ports.authorizedLogin);
  }
  if (connection.profile.adapterKind === "openai-codex") {
    return success(
      action,
      state,
      null,
      null,
      {
        kind: "failed",
        code: OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
        retryable: false,
      },
      authorization,
      ports.authorizedLogin,
    );
  }
  const opened = await openProviderSession({
    profile: connection.profile,
    ports: {
      resolver: ports.credentials.resolver,
      clock: ports.clock,
      stores: ports.credentials.stores,
      ...ports.session,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (opened.kind === "invalid-profile") {
    return success(
      action,
      state,
      null,
      null,
      { kind: "failed", code: "invalid-profile", retryable: false },
      authorization,
      ports.authorizedLogin,
    );
  }
  return success(
    action,
    state,
    opened.session.auth,
    opened.session.catalog,
    discoveryView(opened.session.discovery),
    authorization,
    ports.authorizedLogin,
  );
}

function writeFailure(
  action: ProviderConnectionAction["kind"],
  written: Exclude<ProviderConnectionStoreWriteResult, { readonly kind: "written" }>,
  authorization: ProviderAuthorizationReceipt | null = null,
): ProviderConnectionActionResult {
  switch (written.kind) {
    case "stale":
      return failure(action, "state-stale", true, null, null, undefined, authorization);
    case "cancelled":
      return failure(action, "cancelled", false, null, null, undefined, authorization);
    case "failed":
      return failure(action, "state-write-failed", true, null, null, undefined, authorization);
  }
}

function changed(
  state: ProviderConnectionState,
  patch: Partial<Pick<ProviderConnectionState, "connections" | "selectedProfileId">>,
): ProviderConnectionState {
  return {
    schemaVersion: PROVIDER_CONNECTION_SCHEMA_VERSION,
    revision: state.revision + 1,
    selectedProfileId: patch.selectedProfileId ?? state.selectedProfileId,
    connections: patch.connections ?? state.connections,
  };
}

function success(
  action: ProviderConnectionAction["kind"],
  state: ProviderConnectionState,
  auth: ProviderAuthSnapshot | null = null,
  catalog: ModelCatalog | null = null,
  discovery: ProviderConnectionDiscoveryView = { kind: "not-requested" },
  authorization: ProviderAuthorizationReceipt | null = null,
  authorizedLogin: ProviderConnectionServicePorts["authorizedLogin"] = undefined,
): Extract<ProviderConnectionActionResult, { readonly kind: "completed" }> {
  return {
    kind: "completed",
    action,
    stateRevision: state.revision,
    selectedProfileId: state.selectedProfileId,
    connections: state.connections.map((item) =>
      view(item, state.selectedProfileId, authorizedLogin),
    ),
    auth,
    catalog,
    discovery,
    revocation: null,
    authorization,
  };
}

function failure(
  action: ProviderConnectionAction["kind"],
  code: ProviderConnectionIssueCode,
  retryable: boolean,
  auth: ProviderAuthSnapshot | null = null,
  catalog: ModelCatalog | null = null,
  discovery: ProviderConnectionDiscoveryView = { kind: "not-requested" },
  authorization: ProviderAuthorizationReceipt | null = null,
): ProviderConnectionActionResult {
  return {
    kind: "failed",
    action,
    issue: { code, retryable },
    auth,
    catalog,
    discovery,
    authorization,
  };
}

function authorizedLoginFailureCode(code: string): ProviderConnectionIssueCode {
  if (code === "authorized-login-adapter-unavailable") {
    return "authorized-login-unavailable";
  }
  if (code === OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE) {
    return OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE;
  }
  return "authorization-failed";
}

function discoveryView(outcome: DiscoveryOutcome): ProviderConnectionDiscoveryView {
  if (outcome.kind === "failed") {
    return {
      kind: "failed",
      code: outcome.failure.code,
      retryable: outcome.failure.retryable,
    };
  }
  return {
    kind: "catalog",
    generation: outcome.catalog.generation,
    provenance: outcome.catalog.provenance,
    modelCount: outcome.catalog.models.length,
  };
}

function unavailableHandoff(
  code: string,
  retryable: boolean,
  connection: ProviderConnection | null = null,
  auth: ProviderAuthSnapshot | null = null,
  catalog: ModelCatalog | null = null,
): ProviderConnectionHandoffResult {
  return { kind: "unavailable", issue: { code, retryable }, connection, auth, catalog };
}

function view(
  connection: ProviderConnection,
  selected: string | null,
  authorizedLogin: ProviderConnectionServicePorts["authorizedLogin"],
): ProviderConnectionView {
  const { profile } = connection;
  const authorizedMethods = authorizedLogin?.methods(profile) ?? [];
  return {
    profileId: profile.profileId,
    providerId: String(profile.providerId),
    displayName: profile.displayName,
    adapterKind: profile.adapterKind,
    endpoint: profile.endpoint,
    credentialConfigured: profile.credential !== null,
    credentialStore: profile.credential?.storeKind ?? null,
    accountLabel: connection.account?.displayName ?? profile.credential?.accountLabel ?? null,
    authMethods:
      profile.adapterKind === "openai-codex"
        ? authorizedMethods
        : ["api-key", ...authorizedMethods],
    selected: profile.profileId === selected,
    models: profile.enabledModels.map(String),
    catalogs: profile.catalogs ?? [],
    discovery: profile.discovery,
    updatedAt: connection.updatedAt,
  };
}

function find(state: ProviderConnectionState, profileId: string): ProviderConnection | null {
  return state.connections.find((item) => item.profile.profileId === profileId) ?? null;
}

function replace(
  state: ProviderConnectionState,
  connection: ProviderConnection,
): readonly ProviderConnection[] {
  return state.connections.map((item) =>
    item.profile.profileId === connection.profile.profileId ? connection : item,
  );
}

function endpointIsAllowed(profile: ProviderProfile): boolean {
  return providerEndpointIsAllowed(profile.adapterKind, profile.endpoint);
}

function expiredAuth(
  connection: ProviderConnection,
  clock: ClockPort,
): ProviderAuthSnapshot | null {
  const expiresAt = connection.account?.expiresAt;
  if (expiresAt === null || expiresAt === undefined || expiresAt > clock.now()) {
    return null;
  }
  return {
    profileId: connection.profile.profileId,
    state: "invalid",
    consumer: profileCredentialConsumer(connection.profile),
    observedAt: clock.now(),
    health: null,
    code: "credential-expired",
    retryable: false,
  };
}
