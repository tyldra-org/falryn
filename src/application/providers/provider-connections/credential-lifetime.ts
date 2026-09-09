/** One owner for credential publication, retained generations, and durable cleanup. */
import type { CredentialReference } from "../../../domain/configuration/index.ts";
import {
  type CredentialPartOutcome,
  credentialRemovalIdentity,
} from "../../../domain/security/index.ts";
import {
  MAX_PROVIDER_CREDENTIAL_RETIREMENTS,
  type ProviderCredentialRetirement,
} from "../../../providers/configuration/connection.ts";
import type { ProviderConnection, ProviderConnectionState } from "../../../providers/index.ts";
import type { ProviderConnectionServicePorts, ProviderConnectionStorePort } from "./contracts.ts";

export type CredentialRetirementReport = {
  readonly outcome:
    | "old-reference-retained-shared"
    | "old-reference-retired"
    | "retirement-unavailable"
    | "retirement-failed"
    | "retirement-uncertain";
  readonly local: CredentialPartOutcome["result"];
  readonly remote: ProviderCredentialRetirement["remote"];
};

type Ownership = {
  busy: boolean;
  cleanupRequested: boolean;
  readonly retained: Map<string, number>;
};
const owners = new WeakMap<object, Ownership>();

export function sameCredentialReference(
  left: CredentialReference | null,
  right: CredentialReference | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      credentialRemovalIdentity(left) === credentialRemovalIdentity(right))
  );
}

export function createProviderCredentialLifetime(ports: ProviderConnectionServicePorts) {
  const key = ports.store.ownership ?? ports.store;
  let owner = owners.get(key);
  if (owner === undefined) {
    owner = { busy: false, cleanupRequested: false, retained: new Map() };
    owners.set(key, owner);
  }
  const ownership = owner;
  const revisions = new Map<string | null, string | null>();
  let reports: CredentialRetirementReport[] = [];
  const reportsByIdentity = new Map<string, CredentialRetirementReport>();
  let publication: "replacement-published" | "replacement-rejected" | null = null;

  function owned(state: ProviderConnectionState, reference: CredentialReference): boolean {
    return (
      (ownership.retained.get(credentialRemovalIdentity(reference)) ?? 0) > 0 ||
      state.connections.some((item) => sameCredentialReference(item.profile.credential, reference))
    );
  }

  async function save(state: ProviderConnectionState, expected: string | null) {
    const written = await ports.store.write(state, expected);
    if (written.kind === "written") {
      for (const [original, current] of revisions)
        if (current === expected) revisions.set(original, written.fileRevision);
      revisions.set(expected, written.fileRevision);
    }
    return written;
  }

  async function remember(
    connection: ProviderConnection,
    remoteRequested = false,
  ): Promise<boolean> {
    const reference = connection.profile.credential;
    if (reference === null) return true;
    const snapshot = await ports.store.read();
    const pending = snapshot.state.credentialRetirements ?? [];
    if (
      pending.some((item) => sameCredentialReference(item.connection.profile.credential, reference))
    )
      return true;
    if (pending.length >= MAX_PROVIDER_CREDENTIAL_RETIREMENTS) return false;
    return (
      (
        await save(
          {
            ...snapshot.state,
            credentialRetirements: [
              ...pending,
              {
                connection,
                remoteRequested,
                status: "pending",
                local: { result: "not-attempted", code: null },
                remote: "not-attempted",
              },
            ],
          },
          snapshot.fileRevision,
        )
      ).kind === "written"
    );
  }

  async function reconcileRecords(): Promise<readonly CredentialRetirementReport[]> {
    const initial = await ports.store.read();
    const observed: CredentialRetirementReport[] = [];
    for (const candidate of initial.state.credentialRetirements ?? []) {
      const reference = candidate.connection.profile.credential;
      if (reference === null) continue;
      const observe = (report: CredentialRetirementReport) => {
        reportsByIdentity.set(credentialRemovalIdentity(reference), report);
        observed.push(report);
      };
      const snapshot = await ports.store.read();
      const pending = snapshot.state.credentialRetirements ?? [];
      const current = pending.find((item) =>
        sameCredentialReference(item.connection.profile.credential, reference),
      );
      if (current === undefined) continue;
      if (owned(snapshot.state, reference)) {
        observe({
          outcome: "old-reference-retained-shared",
          local: "not-attempted",
          remote: "not-attempted",
        });
        continue;
      }
      let record = current;
      if (
        (record.local.result === "removed" || record.local.result === "not-present") &&
        (record.remote === "failed" || record.remote === "uncertain")
      ) {
        observe({
          outcome: record.remote === "uncertain" ? "retirement-uncertain" : "retirement-failed",
          local: record.local.result,
          remote: record.remote,
        });
        continue;
      }
      const replaceRecord = async (
        replacement: ProviderCredentialRetirement | null,
      ): Promise<boolean> => {
        const latest = await ports.store.read();
        if (owned(latest.state, reference)) return false;
        const rest = (latest.state.credentialRetirements ?? []).filter(
          (item) => !sameCredentialReference(item.connection.profile.credential, reference),
        );
        return (
          (
            await save(
              {
                ...latest.state,
                credentialRetirements: replacement === null ? rest : [...rest, replacement],
              },
              latest.fileRevision,
            )
          ).kind === "written"
        );
      };
      const uncertain = record.status === "retiring" || record.status === "retirement-uncertain";
      if (uncertain && record.remoteRequested && record.remote === "not-attempted")
        record = { ...record, remote: "uncertain" };
      const finishLocal = async (local: CredentialPartOutcome) => {
        record = { ...record, local };
        const unresolvedRemote = record.remote === "failed" || record.remote === "uncertain";
        const outcome =
          record.remote === "uncertain"
            ? "retirement-uncertain"
            : record.remote === "failed"
              ? "retirement-failed"
              : "old-reference-retired";
        const saved = await replaceRecord(
          unresolvedRemote
            ? {
                ...record,
                status:
                  record.remote === "uncertain" ? "retirement-uncertain" : "retirement-failed",
              }
            : null,
        );
        observe({
          outcome: saved ? outcome : "retirement-uncertain",
          local: local.result,
          remote: record.remote,
        });
      };
      const store = ports.credentials.stores.find((item) => item.storeKind === reference.storeKind);
      if (store === undefined || store.availability().kind !== "available") {
        record = {
          ...record,
          status: uncertain ? "retirement-uncertain" : "retirement-unavailable",
          local: { result: "not-attempted", code: "credential-store-unavailable" },
        };
        await replaceRecord(record);
        observe({
          outcome: "retirement-unavailable",
          local: record.local.result,
          remote: record.remote,
        });
        continue;
      }
      if (uncertain || record.status === "retirement-failed") {
        // Observe only presence. No secret escapes the resolver callback, including after restart.
        const presence = await ports.credentials.resolver.resolve(
          { reference, consumer: reference.consumer },
          () => true,
        );
        if (presence.kind === "unresolved" && presence.failure.status === "missing") {
          await finishLocal({ result: "not-present", code: null });
          continue;
        }
        if (presence.kind === "unresolved" || record.remote === "uncertain") {
          record = { ...record, status: "retirement-uncertain" };
          await replaceRecord(record);
          observe({
            outcome: "retirement-uncertain",
            local: record.local.result,
            remote: record.remote,
          });
          continue;
        }
      }
      if (!(await replaceRecord({ ...record, status: "retiring" }))) {
        observe({
          outcome: "retirement-unavailable",
          local: "not-attempted",
          remote: record.remote,
        });
        continue;
      }
      try {
        if (
          record.remoteRequested &&
          record.remote === "not-attempted" &&
          ports.authorizedLogin !== undefined
        ) {
          const remote = await ports.authorizedLogin.revoke(record.connection);
          record = { ...record, remote: remote.remote };
          // Persist remote observation before local deletion can make it impossible to recover.
          if (!(await replaceRecord({ ...record, status: "retiring" })))
            throw new Error("retirement-observation-write-failed");
        }
        const local = await store.removeSecret(reference);
        record = { ...record, local };
        if (local.result === "removed" || local.result === "not-present") {
          await finishLocal(local);
        } else {
          record = {
            ...record,
            status:
              local.result === "unsupported" || local.result === "not-attempted"
                ? "retirement-unavailable"
                : "retirement-failed",
          };
          await replaceRecord(record);
          observe({
            outcome: local.result === "failed" ? "retirement-failed" : "retirement-unavailable",
            local: local.result,
            remote: record.remote,
          });
        }
      } catch {
        record = {
          ...record,
          status: "retirement-uncertain",
          remote:
            record.remoteRequested && record.remote === "not-attempted"
              ? "uncertain"
              : record.remote,
        };
        await replaceRecord(record);
        observe({
          outcome: "retirement-uncertain",
          local: record.local.result,
          remote: record.remote,
        });
      }
    }
    reports = observed;
    return observed;
  }

  async function reconcile(): Promise<readonly CredentialRetirementReport[]> {
    try {
      return await reconcileRecords();
    } catch {
      // Publication is already durable. A cleanup boundary failure cannot undo or hide it.
      reports = [
        { outcome: "retirement-uncertain", local: "not-attempted", remote: "not-attempted" },
      ];
      return reports;
    }
  }

  const store: ProviderConnectionStorePort = {
    async read(signal) {
      const snapshot = await ports.store.read(signal);
      if ((snapshot.state.credentialRetirements?.length ?? 0) === 0) return snapshot;
      await reconcile();
      return ports.store.read(signal);
    },
    async write(next, expected, signal) {
      publication = "replacement-rejected";
      const snapshot = await ports.store.read(signal);
      if (snapshot.fileRevision !== (revisions.get(expected) ?? expected)) return { kind: "stale" };
      const pending = (snapshot.state.credentialRetirements ?? []).filter(
        (item) =>
          item.status !== "pending" ||
          snapshot.state.connections.some((old) =>
            sameCredentialReference(old.profile.credential, item.connection.profile.credential),
          ) ||
          !next.connections.some((published) =>
            sameCredentialReference(
              published.profile.credential,
              item.connection.profile.credential,
            ),
          ),
      );
      for (const previous of snapshot.state.connections) {
        const reference = previous.profile.credential;
        if (
          reference === null ||
          next.connections.some(
            (item) =>
              item.profile.profileId === previous.profile.profileId &&
              sameCredentialReference(item.profile.credential, reference),
          )
        )
          continue;
        if (
          !pending.some((item) =>
            sameCredentialReference(item.connection.profile.credential, reference),
          )
        )
          pending.push({
            connection: previous,
            remoteRequested: !next.connections.some(
              (item) =>
                item.profile.profileId === previous.profile.profileId &&
                item.profile.credential !== null,
            ),
            status: "pending",
            local: { result: "not-attempted", code: null },
            remote: "not-attempted",
          });
      }
      if (pending.length > MAX_PROVIDER_CREDENTIAL_RETIREMENTS)
        return { kind: "failed", code: "credential-retirement-limit" };
      const written = await ports.store.write(
        { ...next, credentialRetirements: pending },
        snapshot.fileRevision,
        signal,
      );
      if (written.kind === "written") {
        publication = "replacement-published";
        await reconcile();
      }
      return written;
    },
  };

  return {
    store,
    reports: () => reports,
    reportFor: (reference: CredentialReference | null) =>
      reference === null ? undefined : reportsByIdentity.get(credentialRemovalIdentity(reference)),
    change: () =>
      publication === null && reports.length === 0 ? null : { publication, retirements: reports },
    async run<T>(work: () => Promise<T>, unavailable: () => T): Promise<T> {
      // Contention is refused; this owner adds no queue or scheduler alongside runtime admission.
      if (ownership.busy) return unavailable();
      ownership.busy = true;
      revisions.clear();
      reports = [];
      reportsByIdentity.clear();
      publication = null;
      try {
        return await work();
      } finally {
        try {
          while (ownership.cleanupRequested) {
            ownership.cleanupRequested = false;
            await reconcile();
          }
        } finally {
          ownership.busy = false;
        }
      }
    },
    async prepare(connection: ProviderConnection): Promise<boolean> {
      const reference = connection.profile.credential;
      if (reference === null || owned((await ports.store.read()).state, reference)) return false;
      return remember(connection);
    },
    async retire(connection: ProviderConnection): Promise<CredentialRetirementReport> {
      if (!(await remember(connection)))
        return {
          outcome: "retirement-unavailable",
          local: "not-attempted",
          remote: "not-attempted",
        };
      await reconcile();
      return (
        (connection.profile.credential === null
          ? undefined
          : reportsByIdentity.get(credentialRemovalIdentity(connection.profile.credential))) ?? {
          outcome: "old-reference-retained-shared",
          local: "not-attempted",
          remote: "not-attempted",
        }
      );
    },
    reconcile,
    retain(connection: ProviderConnection): () => Promise<void> {
      const reference = connection.profile.credential;
      const identity = reference === null ? null : credentialRemovalIdentity(reference);
      if (identity !== null)
        ownership.retained.set(identity, (ownership.retained.get(identity) ?? 0) + 1);
      let released = false;
      return async () => {
        if (released || identity === null) return;
        released = true;
        const count = (ownership.retained.get(identity) ?? 1) - 1;
        if (count === 0) ownership.retained.delete(identity);
        else ownership.retained.set(identity, count);
        if (!ownership.busy) {
          ownership.busy = true;
          try {
            do {
              ownership.cleanupRequested = false;
              await reconcile();
            } while (ownership.cleanupRequested);
          } finally {
            ownership.busy = false;
          }
        } else ownership.cleanupRequested = true;
      };
    },
  };
}

export type ProviderCredentialLifetime = ReturnType<typeof createProviderCredentialLifetime>;
