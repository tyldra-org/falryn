/**
 * The ownership-class registry.
 *
 * A class exists on a machine because an owner registered it, not because it
 * appears in the documented vocabulary. That is the same pattern shutdown
 * participants follow, for the same reason: a registry declared in one place
 * and populated by owners cannot drift from what actually exists, whereas a
 * hand-maintained inventory drifts the first time an owner is added.
 *
 * The consequence that matters is at removal time. A class no owner registered
 * is refused rather than guessed at, because guessing means deleting bytes
 * whose lifecycle nobody claimed.
 *
 * Each registration below sits with the owner that claims it. The two here are
 * the ones this area genuinely owns; the configuration class is registered by
 * `src/config/` and the log class by the diagnostics collector.
 */

import {
  err,
  isOwnershipClass,
  OWNERSHIP_CLASSES,
  type OwnershipClass,
  type OwnershipRegistration,
  ok,
  type RegistrationError,
  type Result,
} from "../domain/index.ts";

export type OwnershipRegistry = {
  register(registration: OwnershipRegistration): Result<null, RegistrationError>;
  registrations(): readonly OwnershipRegistration[];
  find(ownershipClass: OwnershipClass): OwnershipRegistration | null;
  /** Vocabulary members no owner registered. Named, never assumed absent. */
  unregistered(): readonly OwnershipClass[];
};

export function createOwnershipRegistry(): OwnershipRegistry {
  const registered = new Map<OwnershipClass, OwnershipRegistration>();

  return {
    register(registration: OwnershipRegistration): Result<null, RegistrationError> {
      const { ownershipClass } = registration;
      if (!isOwnershipClass(ownershipClass)) {
        return err({
          kind: "ownership-registration",
          code: "unknown-ownership-class",
          ownershipClass,
        });
      }
      if (registered.has(ownershipClass)) {
        // Two owners for one class means two answers to "may this be deleted".
        return err({
          kind: "ownership-registration",
          code: "class-already-registered",
          ownershipClass,
        });
      }
      if (registration.external && registration.roots.length > 0) {
        return err({
          kind: "ownership-registration",
          code: "external-class-declares-roots",
          ownershipClass,
        });
      }
      if (!registration.external && registration.roots.length === 0) {
        // A class with no root and no external store owns nothing, so nothing
        // could ever act on it.
        return err({
          kind: "ownership-registration",
          code: "owned-class-declares-no-root",
          ownershipClass,
        });
      }
      registered.set(ownershipClass, registration);
      return ok(null);
    },

    registrations: (): readonly OwnershipRegistration[] => [...registered.values()],

    find: (ownershipClass: OwnershipClass): OwnershipRegistration | null =>
      registered.get(ownershipClass) ?? null,

    unregistered: (): readonly OwnershipClass[] =>
      OWNERSHIP_CLASSES.filter((ownershipClass) => !registered.has(ownershipClass)),
  };
}

/**
 * Artifacts, owned by the artifact store.
 *
 * Registered so reset and uninstall can name the class instead of reporting it
 * unregistered. `lifecycle-aware` rather than `safe-cleanup`: an artifact's
 * bytes are only removable once nothing references them, which is a question
 * about records rather than about files, and a plan that deleted this class the
 * way it deletes a cache would drop the bytes a retained session points at.
 */
export const ARTIFACTS_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "artifacts",
  owner: "artifact-store",
  durability: "app-owned",
  removalPosture: "lifecycle-aware",
  roots: ["artifacts"],
  external: false,
};

/**
 * Exports, owned by the export writer.
 *
 * `never-implicit` is the whole point of the posture: a package is content the
 * user asked to create, often to hand to somebody else, and an application that
 * tidied one away on its own would be deleting the only copy of something
 * nobody chose to lose. Reset and uninstall name it and act on it only when it
 * is explicitly selected.
 */
export const EXPORTS_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "exports",
  owner: "export-writer",
  durability: "user-created",
  removalPosture: "never-implicit",
  roots: ["exports"],
  external: false,
};

/**
 * Temporary ingest, owned here.
 *
 * This area reconciles it at startup, so this area registers it. Artifact
 * ingest is the owner that writes into it, and the name it writes under is what
 * now lets reconciliation say who an entry belongs to.
 */
export const TEMPORARY_INGEST_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "temporaryIngest",
  owner: "local-data",
  durability: "recoverable",
  removalPosture: "startup-reconciliation",
  roots: ["temporaryIngest"],
  external: false,
};

/**
 * Credential references, which own no bytes inside these roots.
 *
 * Registered so removal can *name* credentials and state that it does not touch
 * them. Deleting a local reference, deleting the secret, and revoking it
 * remotely are three different actions, and none of them is a side effect of
 * resetting local data. The store adapters themselves belong to the credential
 * owner.
 */
export const CREDENTIAL_REFERENCE_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "credentials",
  owner: "credentials",
  durability: "external-secure",
  removalPosture: "separate-action",
  roots: [],
  external: true,
};
