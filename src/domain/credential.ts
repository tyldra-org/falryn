/**
 * The credential contract: how a reference becomes a secret, and how narrowly.
 *
 * #7 declared what a {@link CredentialReference} *is* — a pointer carried in
 * configuration, never the secret. This module owns what may be done with one:
 * which stores can be asked, what every possible answer looks like, and the
 * shape of the one path a secret is allowed to travel.
 *
 * Three rules the types enforce rather than document:
 *
 * - **Resolution hands the secret to a callback and returns only that
 *   callback's result.** There is no `getSecret(): string`, so a secret cannot
 *   end up in a variable a caller forgot about, in a returned object graph, or
 *   in a value that later gets logged. The narrow shape is the control.
 * - **Every unresolved answer is a declared status.** Missing, empty, locked,
 *   denied, unavailable, unsupported, timed out, cancelled, and malformed are
 *   nine different facts, and a store that could not be reached must not look
 *   like a credential that is not configured.
 * - **A failure carries structure only** — a status, a code, the store kind,
 *   and the consumer. It never carries the secret, the locator, the store's own
 *   output, or the timing of a comparison against a secret.
 *
 * Nothing here reaches a keychain, a process, or an environment variable. The
 * adapters that do are leaves in `src/integrations/`, and they are deliberately
 * not model-reachable: a credential store is not a tool and is registered in no
 * capability catalog.
 */

import type { DurationMs, Instant } from "./clock.ts";
import type { CredentialReference, CredentialStoreKind } from "./configuration.ts";
import type { LocalDataPlatform } from "./local-data.ts";

/** Longest locator a store will accept. Bounds what reaches a store's argv. */
export const MAX_CREDENTIAL_LOCATOR_LENGTH = 256;

/** Longest consumer or account label a reference may name. */
export const MAX_CREDENTIAL_LABEL_LENGTH = 64;

/**
 * Largest secret a store will return.
 *
 * A store that answers with more than this is reporting something other than a
 * credential — a certificate bundle, a file, a truncated dump — and reading it
 * into memory to find out is the wrong way to discover that.
 */
export const MAX_CREDENTIAL_SECRET_BYTES = 64 * 1_024;

/** How long a store lookup may take before it is abandoned. */
export const DEFAULT_CREDENTIAL_TIMEOUT_MS = 5_000 as DurationMs;

/**
 * Why a resolution produced no secret.
 *
 * Each is a different instruction to whoever reads it: `missing` means nothing
 * was ever stored, `denied` means the host refused, `locked` means the store
 * exists and will not open without interaction, and `unsupported` means this
 * build cannot use this store on this platform at all. Collapsing any two of
 * them turns "sign in again" and "unlock your keychain" into the same message.
 */
export const CREDENTIAL_UNRESOLVED_STATUSES = [
  /** No entry exists under this locator. */
  "missing",
  /** An entry exists and holds nothing. Not the same as one that is absent. */
  "empty",
  /** The store exists but will not open without interaction this run cannot do. */
  "locked",
  /** The host refused the read: authentication failed, or the user cancelled. */
  "denied",
  /** The store could not be reached or answered in a way this build cannot use. */
  "unavailable",
  /** This build has no qualified adapter for this store on this platform. */
  "unsupported",
  /** The lookup exceeded its deadline and was abandoned. */
  "timed-out",
  /** The caller's signal aborted before the secret was handed over. */
  "cancelled",
  /** The reference itself is not usable — an illegal locator, a bad shape. */
  "malformed",
] as const;

export type CredentialUnresolvedStatus = (typeof CREDENTIAL_UNRESOLVED_STATUSES)[number];

export function isCredentialUnresolvedStatus(value: unknown): value is CredentialUnresolvedStatus {
  return (
    typeof value === "string" &&
    (CREDENTIAL_UNRESOLVED_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * What the last observation said about a reference.
 *
 * Health is metadata *about* a credential, so it is safe to display and safe to
 * persist beside a reference. It records that a lookup happened and what it
 * concluded — never the locator, never any part of the secret, and never how
 * long a comparison against a secret took.
 */
export const CREDENTIAL_HEALTH_STATES = [
  /** Nothing has looked yet. The honest state before a first resolution. */
  "unknown",
  "present",
  "absent",
  /** The store refused or could not be reached; presence is still unknown. */
  "unreachable",
] as const;

export type CredentialHealthState = (typeof CREDENTIAL_HEALTH_STATES)[number];

export type CredentialHealth = {
  readonly state: CredentialHealthState;
  readonly storeKind: CredentialStoreKind;
  /** When the state was observed, or `null` while it is still `unknown`. */
  readonly observedAt: Instant | null;
};

export function unknownHealth(storeKind: CredentialStoreKind): CredentialHealth {
  return { state: "unknown", storeKind, observedAt: null };
}

/**
 * The health an unresolved status implies.
 *
 * `missing` and `empty` prove absence. Everything else proves only that the
 * question could not be answered, which is not the same as answering "no" —
 * reporting a locked keychain as `absent` would invite a caller to offer to
 * store the credential again over one that is already there.
 */
export function healthForStatus(
  status: CredentialUnresolvedStatus,
  storeKind: CredentialStoreKind,
  observedAt: Instant | null,
): CredentialHealth {
  switch (status) {
    case "missing":
    case "empty":
      return { state: "absent", storeKind, observedAt };
    case "locked":
    case "denied":
    case "unavailable":
    case "unsupported":
    case "timed-out":
      return { state: "unreachable", storeKind, observedAt };
    case "cancelled":
    case "malformed":
      // Nothing was observed: the run stopped, or the reference never named
      // anything a store could look for.
      return { state: "unknown", storeKind, observedAt: null };
  }
}

/**
 * A resolution that produced no secret.
 *
 * `code` is Falryn's own structural reason, such as `keychain-exit-44` or
 * `consumer-mismatch`. It is a code, never a message from the store: a store's
 * text is exactly the text most likely to quote what it was asked for.
 */
export type CredentialFailure = {
  readonly status: CredentialUnresolvedStatus;
  readonly code: string;
  /** Whether the same request could succeed later without anything changing. */
  readonly retryable: boolean;
  readonly storeKind: CredentialStoreKind;
  readonly consumer: string;
  readonly health: CredentialHealth;
};

/**
 * The one path a secret may travel.
 *
 * The callback receives the secret and returns whatever the consumer actually
 * needed — a signed header, an opened client, a boolean. Returning the secret
 * itself from this callback defeats the whole contract, and no type can stop
 * that; what the contract does guarantee is that nothing on Falryn's side of
 * the boundary retains, copies, logs, or reports it.
 */
export type SecretUse<Value> = (secret: string) => Value | Promise<Value>;

export type CredentialResolution<Value> =
  | { readonly kind: "resolved"; readonly value: Value; readonly health: CredentialHealth }
  | { readonly kind: "unresolved"; readonly failure: CredentialFailure };

export type CredentialRequestOptions = {
  /** Bounded per request; a store applies its own default when this is absent. */
  readonly timeoutMs?: DurationMs | undefined;
  readonly signal?: AbortSignal | undefined;
};

/**
 * Whether an adapter can operate on this host.
 *
 * An adapter that cannot says so with a reason rather than failing at the first
 * read. A store that quietly reports `missing` on a platform it was never
 * qualified for would tell a user their credential is gone.
 */
export type CredentialStoreAvailability =
  | { readonly kind: "available" }
  | {
      readonly kind: "unsupported";
      readonly platform: LocalDataPlatform;
      /** A fixed, developer-authored sentence. Carries no host or user data. */
      readonly reason: string;
    };

/** What happened to one half of a two-part removal. */
export const CREDENTIAL_PART_RESULTS = [
  "removed",
  /** There was nothing to remove. A successful outcome, not a failure. */
  "not-present",
  "failed",
  /** Not reached, because the half before it failed. */
  "not-attempted",
  /** This store cannot perform this removal at all. */
  "unsupported",
] as const;

export type CredentialPartResult = (typeof CREDENTIAL_PART_RESULTS)[number];

export type CredentialPartOutcome = {
  readonly result: CredentialPartResult;
  /** Why, when the result is not a plain success. Structural, never store text. */
  readonly code: string | null;
};

/**
 * One store adapter.
 *
 * `read` is the only way out of a store. There is no list, no enumerate, and no
 * export: a store that can be enumerated is a store whose contents end up in a
 * diagnostic bundle.
 */
export type CredentialStorePort = {
  readonly storeKind: CredentialStoreKind;
  availability(): CredentialStoreAvailability;
  read<Value>(
    reference: CredentialReference,
    use: SecretUse<Value>,
    options?: CredentialRequestOptions,
  ): Promise<CredentialResolution<Value>>;
  /**
   * Deletes the stored secret. Local only — revoking it at a provider is #35.
   *
   * Separate from removing the reference, because the two fail independently
   * and a caller has to be told which of them happened.
   */
  removeSecret(
    reference: CredentialReference,
    options?: CredentialRequestOptions,
  ): Promise<CredentialPartOutcome>;
};

/**
 * Where a reference itself lives, so it can be deleted.
 *
 * A reference is an ordinary configuration value, and writing configuration
 * files is not implemented — #8 excluded it deliberately, because nothing in
 * v0.1 sets a value. The port exists so that removing a credential is one
 * operation with two reported halves rather than two operations a caller has to
 * remember to pair; its production supplier arrives with the configuration
 * writer.
 */
export type CredentialReferenceStorePort = {
  removeReference(
    reference: CredentialReference,
    options?: CredentialRequestOptions,
  ): Promise<CredentialPartOutcome>;
};

/**
 * How much of a removal happened.
 *
 * `partial` exists because the interesting case is the common one: a keychain
 * entry deleted while the reference naming it survives, or the reverse. Calling
 * either of those `completed` is how a user comes to believe a credential is
 * gone when half of it is still there.
 */
export type CredentialRemovalCompleteness = "completed" | "partial" | "failed";

export type CredentialRemovalOutcome = {
  readonly secret: CredentialPartOutcome;
  readonly reference: CredentialPartOutcome;
  readonly completeness: CredentialRemovalCompleteness;
};

/** Execution is authorized for one exact reference. */
export type CredentialRemovalConfirmation = {
  readonly identity: string;
};

export type CredentialRemovalRefusal =
  | {
      readonly code: "confirmation-mismatch";
      readonly expected: string;
      readonly confirmed: string;
    }
  | { readonly code: "cancelled" };

/**
 * The identity a removal confirmation must carry.
 *
 * Derived from the reference's own content rather than assigned, so a reference
 * edited between being shown and being confirmed produces a different identity
 * and the removal is refused. This is the same rule local-data removal applies
 * to a plan.
 */
export function credentialRemovalIdentity(reference: CredentialReference): string {
  // JSON rather than a joined string: a locator containing whatever separator
  // was chosen would otherwise let two references derive one identity, and a
  // confirmation is worth exactly as much as the identity it pins.
  return JSON.stringify([
    reference.storeKind,
    reference.locator,
    reference.consumer,
    reference.accountLabel,
  ]);
}

/** Who is asking, and for which reference. */
export type SecretRequest = {
  readonly reference: CredentialReference;
  /**
   * The consumer making the request.
   *
   * Checked against the reference's declared consumer before any store is
   * touched. A provider that asks for another provider's credential is refused
   * rather than served, which is what makes "limited to the integration that
   * needs it" a rule instead of a convention.
   */
  readonly consumer: string;
};

export type SecretResolverPort = {
  resolve<Value>(
    request: SecretRequest,
    use: SecretUse<Value>,
    options?: CredentialRequestOptions,
  ): Promise<CredentialResolution<Value>>;
};

/**
 * An in-memory credential store for tests.
 *
 * It answers from a supplied map and can be told to report any declared
 * unresolved status instead, so every branch of the state matrix is reachable
 * without a keychain, a platform, or a subprocess.
 */
export type InMemoryCredentialStoreOptions = {
  readonly storeKind: CredentialStoreKind;
  /** Locator to secret. A locator absent from the map resolves `missing`. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Forces one status for every read, whatever the map says. */
  readonly forcedStatus?: CredentialUnresolvedStatus;
  readonly availability?: CredentialStoreAvailability;
  /** Locators whose secret removal fails, for the partial-removal control. */
  readonly removalFailures?: readonly string[];
  readonly now?: Instant;
};

export function createInMemoryCredentialStore(
  options: InMemoryCredentialStoreOptions,
): CredentialStorePort {
  const { storeKind } = options;
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const removalFailures = new Set(options.removalFailures ?? []);
  const availability = options.availability ?? { kind: "available" as const };
  const observedAt = options.now ?? null;

  const unresolved = (status: CredentialUnresolvedStatus, code: string, retryable: boolean) => ({
    kind: "unresolved" as const,
    failure: {
      status,
      code,
      retryable,
      storeKind,
      consumer: "",
      health: healthForStatus(status, storeKind, observedAt),
    },
  });

  return {
    storeKind,
    availability: () => availability,

    async read<Value>(
      reference: CredentialReference,
      use: SecretUse<Value>,
      requestOptions?: CredentialRequestOptions,
    ): Promise<CredentialResolution<Value>> {
      if (requestOptions?.signal?.aborted === true) {
        return unresolved("cancelled", "aborted", true);
      }
      if (availability.kind === "unsupported") {
        return unresolved("unsupported", "store-unsupported", false);
      }
      if (options.forcedStatus !== undefined) {
        return unresolved(options.forcedStatus, `forced-${options.forcedStatus}`, false);
      }
      const secret = secrets.get(reference.locator);
      if (secret === undefined) {
        return unresolved("missing", "not-in-store", false);
      }
      if (secret.length === 0) {
        return unresolved("empty", "empty-entry", false);
      }
      return {
        kind: "resolved",
        value: await use(secret),
        health: { state: "present", storeKind, observedAt },
      };
    },

    async removeSecret(reference: CredentialReference): Promise<CredentialPartOutcome> {
      if (availability.kind === "unsupported") {
        return { result: "unsupported", code: "store-unsupported" };
      }
      if (removalFailures.has(reference.locator)) {
        return { result: "failed", code: "removal-refused" };
      }
      return secrets.delete(reference.locator)
        ? { result: "removed", code: null }
        : { result: "not-present", code: null };
    },
  };
}
