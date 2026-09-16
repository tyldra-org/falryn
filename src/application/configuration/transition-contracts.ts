import type {
  ProfileOwnerReceipt,
  ProfileTransitionReceipt,
} from "../../domain/configuration/profile-transition.ts";

export type {
  ProfileOwnerReceipt,
  ProfileOwnerState,
  ProfileTransitionReceipt,
} from "../../domain/configuration/profile-transition.ts";

import type {
  ConfigurationChange,
  ConfigurationGenerationRecord,
  ConfigurationInspection,
} from "../../domain/configuration/index.ts";
import type { ConfigurationApplicationClass } from "../../domain/sessions/index.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";

export type ProfileTransitionScope = {
  readonly sessionId: string;
  readonly workspaceId: string;
};

export type ProfileTransitionRequest = ProfileTransitionScope & {
  readonly profile: string;
  readonly expectedGeneration: number;
  readonly expectedSources: string;
  readonly actor: "user" | "model";
};

export type ProfileOwnerPlan = {
  readonly owner: string;
  readonly required: boolean;
  readonly applicationClass: ConfigurationApplicationClass;
  /** Public diagnostic code; never raw connection URLs or credential references. */
  readonly availability: "available" | "unavailable" | "new-session-required";
  readonly preparation: "none" | "local" | "connection";
  readonly cost: "none" | "metered" | "unknown";
};

export type ProfileTransitionPreview = ProfileTransitionScope & {
  readonly kind: "preview";
  readonly candidateId: string;
  readonly profile: string;
  readonly expectedGeneration: number;
  readonly expectedSources: string;
  readonly policyRevision: string;
  readonly changes: readonly ConfigurationChange[];
  readonly inspection: ConfigurationInspection;
  readonly effectiveInputChanged: boolean;
  readonly owners: readonly ProfileOwnerPlan[];
};

export type ProfileTransitionRefusal = { readonly kind: "refused"; readonly code: string };
export type ProfileTransitionOutcome =
  | { readonly kind: "receipt"; readonly receipt: ProfileTransitionReceipt }
  | ProfileTransitionRefusal;

/** Host-only candidate. Configuration values never cross the public preview boundary. */
export type ResolvedProfileTransition = {
  readonly record: ConfigurationGenerationRecord;
  readonly changes: readonly ConfigurationChange[];
  readonly inspection: ConfigurationInspection;
  readonly sourceRevision: string;
  readonly effectiveInputChanged: boolean;
  /** Repeat source, trust and credential checks without starting work. */
  validate(signal: AbortSignal): Promise<boolean>;
  /** CAS publication; check current() at the final publication boundary. Null means no publication. */
  publish(signal: AbortSignal, current: () => boolean): Promise<number | null>;
};

export type PreparedProfileOwner = {
  /** Release only resources acquired by this preparation attempt. Must be idempotent. */
  release(): Promise<void>;
  /** Transfer ownership at the declared boundary. Check current() before any late effect. */
  acknowledge(
    generation: number,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<Omit<ProfileOwnerReceipt, "owner">>;
};

export type ProfileTransitionOwner = {
  readonly id: string;
  /** Pure inspection. Cannot resolve credentials, spawn processes or call providers. */
  describe(candidate: ResolvedProfileTransition): ProfileOwnerPlan;
  /** Observe existing ownership after cancellation/restart; never relaunch preparation. */
  inspect?(generation: number, signal: AbortSignal): Promise<Omit<ProfileOwnerReceipt, "owner">>;
  prepare(
    candidate: ResolvedProfileTransition,
    resources: ProductTaskResources,
    signal: AbortSignal,
  ): Promise<PreparedProfileOwner | ProfileTransitionRefusal>;
};

export type ProfileTransitionPorts = {
  readonly scope: ProfileTransitionScope;
  readonly owners: readonly ProfileTransitionOwner[];
  /** Reuse the session's resource owner; never open a fresh budget to switch profiles. */
  readonly resources: ProductTaskResources;
  readonly deadlineMs: number;
  readonly maxOwners: number;
  current(): { readonly generation: number; readonly sources: string; readonly policy: string };
  authorize(actor: "user" | "model", candidate?: ResolvedProfileTransition): boolean;
  resolve(
    profile: string,
    signal: AbortSignal,
  ): Promise<ResolvedProfileTransition | ProfileTransitionRefusal>;
  /** Persist facts only. Recovery does not replay preparations or acknowledgements. */
  record(receipt: ProfileTransitionReceipt): Promise<boolean>;
  recover(): Promise<ProfileTransitionReceipt | null>;
  newIdentity(): string;
};

export type ProfileTransitions = {
  preview(
    request: ProfileTransitionRequest,
    signal?: AbortSignal,
  ): Promise<ProfileTransitionPreview | ProfileTransitionRefusal>;
  apply(
    request: ProfileTransitionScope & {
      readonly candidateId: string;
      readonly actor: "user" | "model";
      readonly expectedGeneration: number;
      readonly savedFileRevision?: string;
    },
    signal?: AbortSignal,
  ): Promise<ProfileTransitionOutcome>;
  inspect(): Promise<ProfileTransitionReceipt | null>;
  reconcile(actor: "user" | "model", signal?: AbortSignal): Promise<ProfileTransitionOutcome>;
  /** File notifications may arrive late. Invalidate only a still-held, changed candidate. */
  sourcesChanged(signal?: AbortSignal): Promise<void>;
  /** Invalidate reviewed candidates only; observation never prepares resources. */
  invalidate(): void;
};
