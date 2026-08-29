/** Public contracts for provider connection management. */

import type { ClockPort, CredentialReference } from "../../domain/index.ts";
import type {
  ModelCatalog,
  ProviderAccountMetadata,
  ProviderAuthMethod,
  ProviderAuthSnapshot,
  ProviderConnection,
  ProviderConnectionState,
  ProviderProfile,
  ProviderSessionPorts,
} from "../../providers/index.ts";
import type { ProductCredentialBundle } from "../product-credentials.ts";

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
