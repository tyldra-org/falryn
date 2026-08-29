/**
 * Provider connection actions over configuration, credentials, and discovery.
 * Secret bytes exist only during a protected login call and never appear in a
 * result, persisted state, diagnostic, or provider handoff.
 */

import type { ClockPort, CredentialReference } from "../domain/index.ts";
import {
  type DiscoveryOutcome,
  MAX_PROVIDER_CONNECTIONS,
  type ModelCatalog,
  openProviderSession,
  PROVIDER_CONNECTION_SCHEMA_VERSION,
  type ProviderAccountMetadata,
  type ProviderAuthMethod,
  type ProviderAuthSnapshot,
  type ProviderConnection,
  type ProviderConnectionState,
  type ProviderProfile,
  type ProviderRevocationReport,
  type ProviderSessionPorts,
  parseProviderConnectionState,
  parseProviderProfile,
  profileCredentialConsumer,
  providerEndpointIsAllowed,
  revokeProviderSessionCredential,
} from "../providers/index.ts";
import type { ProductCredentialBundle } from "./product-credentials.ts";

export type ProviderConnectionStoreSnapshot = {
  readonly state: ProviderConnectionState;
  readonly fileRevision: string | null;
};

export type ProviderConnectionStoreWriteResult =
  | { readonly kind: "written"; readonly fileRevision: string }
  | { readonly kind: "stale" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly code: string };

export type ProviderConnectionStorePort = {
  read(signal?: AbortSignal): Promise<ProviderConnectionStoreSnapshot>;
  write(
    state: ProviderConnectionState,
    expectedFileRevision: string | null,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionStoreWriteResult>;
};

export type AuthorizedProviderLoginResult =
  | {
      readonly kind: "authorized";
      readonly reference: CredentialReference;
      readonly account: ProviderAccountMetadata;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "denied"; readonly code: string }
  | { readonly kind: "timed-out"; readonly code: string }
  | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean };

/** Official provider flow. The adapter persists its own secret bytes. */
export type AuthorizedProviderLoginPort = {
  authorize(
    profile: ProviderProfile,
    method: Exclude<ProviderAuthMethod, "api-key">,
    signal?: AbortSignal,
  ): Promise<AuthorizedProviderLoginResult>;
};

export type ProviderConnectionAction =
  | { readonly kind: "list" }
  | { readonly kind: "add"; readonly profile: ProviderProfile }
  | {
      readonly kind: "configure";
      readonly profile: ProviderProfile;
      /** Product surfaces update safe metadata without silently logging out. */
      readonly preserveCredential: boolean;
      /** Preserve declarations for enabled models when the surface cannot edit them. */
      readonly preserveCapabilities: boolean;
    }
  | { readonly kind: "use"; readonly profileId: string }
  | { readonly kind: "test"; readonly profileId: string | null }
  | {
      readonly kind: "login-api-key";
      readonly profileId: string;
      readonly secret: string;
      readonly accountLabel: string | null;
    }
  | {
      readonly kind: "login-authorized";
      readonly profileId: string;
      readonly method: Exclude<ProviderAuthMethod, "api-key">;
    }
  | { readonly kind: "logout"; readonly profileId: string }
  | { readonly kind: "remove"; readonly profileId: string };

export type ProviderConnectionIssueCode =
  | "cancelled"
  | "duplicate-profile"
  | "invalid-endpoint"
  | "invalid-profile"
  | "profile-limit"
  | "profile-missing"
  | "selected-profile-required"
  | "selected-profile-remove-refused"
  | "credential-already-configured"
  | "credential-write-failed"
  | "credential-rollback-failed"
  | "credential-state-diverged"
  | "credential-expired"
  | "authorized-login-unavailable"
  | "authorization-denied"
  | "authorization-timed-out"
  | "authorization-failed"
  | "provider-not-ready"
  | "state-invalid"
  | "state-stale"
  | "state-write-failed";

export type ProviderConnectionView = {
  readonly profileId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly adapterKind: ProviderProfile["adapterKind"];
  readonly endpoint: string | null;
  readonly credentialConfigured: boolean;
  readonly credentialStore: CredentialReference["storeKind"] | null;
  readonly accountLabel: string | null;
  readonly selected: boolean;
  readonly models: readonly string[];
  readonly catalogs: readonly string[];
  readonly discovery: ProviderProfile["discovery"];
  readonly updatedAt: number;
};

export type ProviderConnectionDiscoveryView =
  | { readonly kind: "not-requested" }
  | {
      readonly kind: "catalog";
      readonly generation: number;
      readonly provenance: ModelCatalog["provenance"];
      readonly modelCount: number;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly retryable: boolean;
    };

export type ProviderConnectionActionResult =
  | {
      readonly kind: "completed";
      readonly action: ProviderConnectionAction["kind"];
      readonly stateRevision: number;
      readonly selectedProfileId: string | null;
      readonly connections: readonly ProviderConnectionView[];
      readonly auth: ProviderAuthSnapshot | null;
      readonly catalog: ModelCatalog | null;
      readonly discovery: ProviderConnectionDiscoveryView;
      readonly revocation: {
        readonly local: string;
        readonly remote: string;
      } | null;
    }
  | {
      readonly kind: "failed";
      readonly action: ProviderConnectionAction["kind"];
      readonly issue: { readonly code: ProviderConnectionIssueCode; readonly retryable: boolean };
      readonly auth: ProviderAuthSnapshot | null;
      readonly catalog: ModelCatalog | null;
      readonly discovery: ProviderConnectionDiscoveryView;
    };

export type ProviderConnectionServicePorts = {
  readonly store: ProviderConnectionStorePort;
  readonly credentials: ProductCredentialBundle;
  readonly clock: ClockPort;
  readonly session?: Omit<ProviderSessionPorts, "resolver" | "clock" | "stores">;
  readonly authorizedLogin?: AuthorizedProviderLoginPort;
};

export type ProviderConnectionService = {
  execute(
    action: ProviderConnectionAction,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionActionResult>;
  selected(signal?: AbortSignal): Promise<ProviderConnectionActionResult>;
  openSelected(signal?: AbortSignal): Promise<ProviderConnectionHandoffResult>;
};

/** Internal handoff for the live attempt owner. Contains references, not secrets. */
export type ProviderConnectionHandoffResult =
  | {
      readonly kind: "ready";
      readonly connection: ProviderConnection;
      readonly auth: ProviderAuthSnapshot;
      readonly catalog: ModelCatalog;
    }
  | {
      readonly kind: "unavailable";
      readonly issue: { readonly code: string; readonly retryable: boolean };
      readonly connection: ProviderConnection | null;
      readonly auth: ProviderAuthSnapshot | null;
      readonly catalog: ModelCatalog | null;
    };

export function createProviderConnectionService(
  ports: ProviderConnectionServicePorts,
): ProviderConnectionService {
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
        return success(action.kind, parsed.value);
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
    execute,
    selected: (signal) => execute({ kind: "test", profileId: null }, signal),
    async openSelected(signal) {
      const snapshot = await ports.store.read(signal);
      const parsed = parseProviderConnectionState(snapshot.state);
      if (!parsed.ok || parsed.value.selectedProfileId === null) {
        return unavailableHandoff("selected-profile-required", false);
      }
      const connection = find(parsed.value, parsed.value.selectedProfileId);
      if (connection === null) {
        return unavailableHandoff("profile-missing", false);
      }
      const expired = expiredAuth(connection, ports.clock);
      if (expired !== null) {
        return unavailableHandoff("credential-expired", false, connection, expired);
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
      };
    },
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
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (current.profile.credential !== null) {
    return failure(action.kind, "credential-already-configured", false);
  }
  const reference: CredentialReference = {
    storeKind: "operating-system-keychain",
    locator: `falryn.provider.${current.profile.profileId}`,
    consumer: `provider:${current.profile.profileId}`,
    accountLabel: action.accountLabel ?? current.profile.profileId,
  };
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
  const rollback = await revokeProviderSessionCredential({
    profile: replacement.profile,
    stores: ports.credentials.stores,
    ...(signal === undefined ? {} : { signal }),
  });
  if (rollback.local !== "removed" && rollback.local !== "not-present") {
    return failure(action.kind, "credential-rollback-failed", true);
  }
  return writeFailure(action.kind, written);
}

async function loginAuthorized(
  action: Extract<ProviderConnectionAction, { readonly kind: "login-authorized" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
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
  const authorized = await ports.authorizedLogin.authorize(current.profile, action.method, signal);
  switch (authorized.kind) {
    case "cancelled":
      return failure(action.kind, "cancelled", false);
    case "denied":
      return failure(action.kind, "authorization-denied", false);
    case "timed-out":
      return failure(action.kind, "authorization-timed-out", true);
    case "failed":
      return failure(action.kind, "authorization-failed", authorized.retryable);
    case "authorized": {
      const now = ports.clock.now();
      if (
        authorized.account.authMethod !== action.method ||
        authorized.reference.consumer !== profileCredentialConsumer(current.profile) ||
        (authorized.account.expiresAt !== null && authorized.account.expiresAt <= now)
      ) {
        const rollback = await revokeProviderSessionCredential({
          profile: { ...current.profile, credential: authorized.reference },
          stores: ports.credentials.stores,
          ...(signal === undefined ? {} : { signal }),
        });
        return rollback.local === "removed" || rollback.local === "not-present"
          ? failure(action.kind, "authorization-failed", false)
          : failure(action.kind, "credential-rollback-failed", true);
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
        return discoverConnection(action.kind, next, action.profileId, ports, signal);
      }
      const rollback = await revokeProviderSessionCredential({
        profile: replacement.profile,
        stores: ports.credentials.stores,
        ...(signal === undefined ? {} : { signal }),
      });
      if (rollback.local !== "removed" && rollback.local !== "not-present") {
        return failure(action.kind, "credential-rollback-failed", true);
      }
      return writeFailure(action.kind, written);
    }
  }
}

async function logout(
  action: Extract<ProviderConnectionAction, { readonly kind: "logout" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  const revocation = await revokeUnlessShared(snapshot.state, current, ports, signal);
  if (revocation.local === "failed") {
    return failure(action.kind, "credential-write-failed", true);
  }
  const replacement: ProviderConnection = {
    profile: { ...current.profile, credential: null },
    account: null,
    updatedAt: ports.clock.now(),
  };
  const next = changed(snapshot.state, { connections: replace(snapshot.state, replacement) });
  const written = await ports.store.write(next, snapshot.fileRevision, signal);
  if (written.kind === "written") {
    return { ...success(action.kind, next), revocation };
  }
  return revocation.local === "removed"
    ? failure(action.kind, "credential-state-diverged", true)
    : writeFailure(action.kind, written);
}

async function remove(
  action: Extract<ProviderConnectionAction, { readonly kind: "remove" }>,
  snapshot: ProviderConnectionStoreSnapshot,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderConnectionActionResult> {
  const current = find(snapshot.state, action.profileId);
  if (current === null) {
    return failure(action.kind, "profile-missing", false);
  }
  if (snapshot.state.selectedProfileId === action.profileId) {
    return failure(action.kind, "selected-profile-remove-refused", false);
  }
  const revocation = await revokeUnlessShared(snapshot.state, current, ports, signal);
  if (revocation.local === "failed") {
    return failure(action.kind, "credential-write-failed", true);
  }
  const next = changed(snapshot.state, {
    connections: snapshot.state.connections.filter(
      (item) => item.profile.profileId !== action.profileId,
    ),
  });
  const written = await ports.store.write(next, snapshot.fileRevision, signal);
  if (written.kind === "written") {
    return { ...success(action.kind, next), revocation };
  }
  return revocation.local === "removed"
    ? failure(action.kind, "credential-state-diverged", true)
    : writeFailure(action.kind, written);
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
): Promise<ProviderConnectionActionResult> {
  const connection = find(state, profileId);
  if (connection === null) {
    return success(action, state);
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
    return success(action, state, null, null, {
      kind: "failed",
      code: "invalid-profile",
      retryable: false,
    });
  }
  return success(
    action,
    state,
    opened.session.auth,
    opened.session.catalog,
    discoveryView(opened.session.discovery),
  );
}

function writeFailure(
  action: ProviderConnectionAction["kind"],
  written: Exclude<ProviderConnectionStoreWriteResult, { readonly kind: "written" }>,
): ProviderConnectionActionResult {
  switch (written.kind) {
    case "stale":
      return failure(action, "state-stale", true);
    case "cancelled":
      return failure(action, "cancelled", false);
    case "failed":
      return failure(action, "state-write-failed", true);
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
): Extract<ProviderConnectionActionResult, { readonly kind: "completed" }> {
  return {
    kind: "completed",
    action,
    stateRevision: state.revision,
    selectedProfileId: state.selectedProfileId,
    connections: state.connections.map((item) => view(item, state.selectedProfileId)),
    auth,
    catalog,
    discovery,
    revocation: null,
  };
}

function failure(
  action: ProviderConnectionAction["kind"],
  code: ProviderConnectionIssueCode,
  retryable: boolean,
  auth: ProviderAuthSnapshot | null = null,
  catalog: ModelCatalog | null = null,
  discovery: ProviderConnectionDiscoveryView = { kind: "not-requested" },
): ProviderConnectionActionResult {
  return { kind: "failed", action, issue: { code, retryable }, auth, catalog, discovery };
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

function view(connection: ProviderConnection, selected: string | null): ProviderConnectionView {
  const { profile } = connection;
  return {
    profileId: profile.profileId,
    providerId: String(profile.providerId),
    displayName: profile.displayName,
    adapterKind: profile.adapterKind,
    endpoint: profile.endpoint,
    credentialConfigured: profile.credential !== null,
    credentialStore: profile.credential?.storeKind ?? null,
    accountLabel: connection.account?.displayName ?? profile.credential?.accountLabel ?? null,
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

function sameReference(
  left: CredentialReference | null,
  right: CredentialReference | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.storeKind === right.storeKind &&
      left.locator === right.locator &&
      left.consumer === right.consumer &&
      left.accountLabel === right.accountLabel)
  );
}

async function revokeUnlessShared(
  state: ProviderConnectionState,
  connection: ProviderConnection,
  ports: ProviderConnectionServicePorts,
  signal?: AbortSignal,
): Promise<ProviderRevocationReport> {
  const reference = connection.profile.credential;
  const shared =
    reference !== null &&
    state.connections.some(
      (candidate) =>
        candidate.profile.profileId !== connection.profile.profileId &&
        sameReference(candidate.profile.credential, reference),
    );
  if (shared) {
    return {
      profileId: connection.profile.profileId,
      local: "not-attempted",
      remote: "not-attempted",
    };
  }
  return revokeProviderSessionCredential({
    profile: connection.profile,
    stores: ports.credentials.stores,
    ...(signal === undefined ? {} : { signal }),
  });
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
