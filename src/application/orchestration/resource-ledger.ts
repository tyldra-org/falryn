/** Atomic, single-process capacity accounting. No await occurs inside a transaction. */
import { createHmac, randomUUID } from "node:crypto";
import {
  canonicalResourceValue,
  type ResourceAdmissionReceipt,
  type ResourceDebit,
  type ResourceReservationIdentityV1,
  resourceReservationIdentitySchema,
  type SharedCapacityScopeIdentityV1,
  sharedCapacityScopeIdentitySchema,
} from "../../domain/orchestration/resource-admission.ts";

type Bucket = {
  parentScopes?: Set<string>;
  scope: SharedCapacityScopeIdentityV1;
  used: number;
  limit: number;
  poisoned: boolean;
};
type RecordEntry = {
  fingerprint: string;
  identity: ResourceReservationIdentityV1;
  debits: readonly ResourceDebit[];
  receipt: ResourceAdmissionReceipt;
  settled: boolean;
  charges: Map<string, number>;
};
export type ReservationDecision = {
  readonly kind: "admitted" | "replay" | "queued" | "refused";
  readonly receipt: ResourceAdmissionReceipt;
};
export type ResourceLedger = ReturnType<typeof createResourceLedger>;

export function createResourceLedger(maxRecords = 8192) {
  const salt = randomUUID();
  const buckets = new Map<string, Bucket>();
  const aliases = new Map<string, string>();
  const records = new Map<string, RecordEntry>();
  const listeners = new Set<() => void>();
  const digest = (value: string) => createHmac("sha256", salt).update(value).digest("hex");
  const key = (scope: SharedCapacityScopeIdentityV1) => canonicalResourceValue(scope);
  const root = (scopeKey: string): string => {
    let current = scopeKey;
    while (aliases.has(current)) current = aliases.get(current) ?? current;
    return current;
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const receipt = (
    id: string,
    state: ResourceAdmissionReceipt["state"],
    debit?: ResourceDebit,
  ): ResourceAdmissionReceipt => ({
    version: 1,
    state,
    reservation: digest(id),
    scope: debit === undefined ? null : digest(root(key(debit.scope))),
    dimension: debit?.scope.dimension ?? null,
    acquired: state === "admitted",
    released: false,
    uncertain: state === "uncertain-after-interruption",
    queuePosition: null,
    deadline: null,
  });
  const grouped = (debits: readonly ResourceDebit[]) => {
    const groups = new Map<string, { amount: number; limit: number; debit: ResourceDebit }>();
    for (const debit of debits) {
      const id = root(key(debit.scope));
      const previous = groups.get(id);
      // Aliased names for one operation describe the same usage, not two operations.
      groups.set(id, {
        amount: Math.max(previous?.amount ?? 0, debit.amount),
        limit: Math.min(previous?.limit ?? Number.MAX_SAFE_INTEGER, debit.limit),
        debit,
      });
    }
    return groups;
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reserve(
      id: string,
      identity: ResourceReservationIdentityV1,
      debits: readonly ResourceDebit[],
    ): ReservationDecision {
      const parsed = resourceReservationIdentitySchema.safeParse(identity);
      const invalid =
        !parsed.success ||
        debits.length === 0 ||
        debits.length > 128 ||
        debits.some(
          (debit) =>
            !sharedCapacityScopeIdentitySchema.safeParse(debit.scope).success ||
            !Number.isSafeInteger(debit.amount) ||
            debit.amount < 0 ||
            !Number.isSafeInteger(debit.limit) ||
            debit.limit < 0,
        );
      if (invalid || id.length === 0 || id.length > 256)
        return { kind: "refused", receipt: receipt(id, "quota-unknown") };
      const scopes = debits.map((debit) => key(debit.scope)).sort();
      if (
        new Set(scopes).size !== scopes.length ||
        canonicalResourceValue(scopes) !== canonicalResourceValue(identity.scopes.map(key).sort())
      ) {
        return { kind: "refused", receipt: receipt(id, "stale-generation") };
      }
      const fingerprint = canonicalResourceValue({
        identity: {
          ...identity,
          scopes: [...identity.scopes].sort((a, b) => key(a).localeCompare(key(b))),
        },
        debits: [...debits].sort((a, b) => key(a.scope).localeCompare(key(b.scope))),
      });
      const previous = records.get(id);
      if (previous !== undefined)
        return previous.fingerprint === fingerprint
          ? { kind: "replay", receipt: previous.receipt }
          : { kind: "refused", receipt: receipt(id, "stale-generation") };
      if (records.size >= maxRecords || buckets.size + debits.length > maxRecords * 16)
        return { kind: "refused", receipt: receipt(id, "limit-exceeded") };
      const groups = grouped(debits);
      let waiting: ResourceDebit | undefined;
      for (const [scopeKey, group] of groups) {
        const bucket = buckets.get(scopeKey);
        const limit = Math.min(bucket?.limit ?? group.limit, group.limit);
        // A newer declaration may narrow a shared bucket even while it is busy.
        if (bucket !== undefined) bucket.limit = limit;
        if (bucket?.poisoned || group.amount > limit - (bucket?.used ?? 0)) {
          if (
            !bucket?.poisoned &&
            group.amount <= limit &&
            group.debit.scope.bucketKind === "occupancy"
          )
            waiting ??= group.debit;
          else return { kind: "refused", receipt: receipt(id, "limit-exceeded", group.debit) };
        }
      }
      if (waiting !== undefined) return { kind: "queued", receipt: receipt(id, "queued", waiting) };
      for (const [scopeKey, group] of groups) {
        const bucket = buckets.get(scopeKey);
        buckets.set(scopeKey, {
          ...(group.debit.scope.ownerKind === "task" || group.debit.scope.ownerKind === "agent"
            ? { parentScopes: new Set([...(bucket?.parentScopes ?? []), identity.parentScope]) }
            : {}),
          scope: group.debit.scope,
          used: (bucket?.used ?? 0) + group.amount,
          limit: Math.min(bucket?.limit ?? group.limit, group.limit),
          poisoned: false,
        });
      }
      const admitted = receipt(id, "admitted");
      records.set(id, {
        fingerprint,
        identity: structuredClone(identity),
        debits: structuredClone(debits),
        receipt: admitted,
        settled: false,
        charges: new Map([...groups].map(([scopeKey, group]) => [scopeKey, group.amount])),
      });
      return { kind: "admitted", receipt: admitted };
    },
    /** Omitted actuals conservatively consume the maximum; occupancy needs proven termination. */
    settle(
      id: string,
      actual: readonly ResourceDebit[] | null,
      terminated: boolean,
    ): ResourceAdmissionReceipt | null {
      const record = records.get(id);
      if (record === undefined || record.settled) return record?.receipt ?? null;
      const actualByKey = new Map(actual?.map((debit) => [key(debit.scope), debit.amount]));
      if (
        actual !== null &&
        (actual.length !== record.debits.length ||
          new Set(actualByKey.keys()).size !== record.debits.length ||
          actual.some(
            (debit) =>
              !Number.isSafeInteger(debit.amount) ||
              debit.amount < 0 ||
              !record.debits.some((reserved) => key(reserved.scope) === key(debit.scope)),
          ))
      )
        return null;
      const settledDebits = record.debits.map((debit) => ({
        ...debit,
        amount:
          debit.scope.bucketKind === "occupancy"
            ? terminated
              ? 0
              : debit.amount
            : (actualByKey.get(key(debit.scope)) ?? debit.amount),
      }));
      const settledGroups = grouped(settledDebits);
      let overrun = false;
      const charged = new Map<string, number>();
      for (const [scopeKey, amount] of record.charges) {
        const canonical = root(scopeKey);
        charged.set(canonical, (charged.get(canonical) ?? 0) + amount);
      }
      for (const [scopeKey, reserved] of charged) {
        const bucket = buckets.get(scopeKey);
        const used = settledGroups.get(scopeKey)?.amount ?? reserved;
        if (bucket === undefined) throw new Error("missing admitted capacity");
        const exceeded = settledDebits.some(
          (debit, index) =>
            root(key(debit.scope)) === scopeKey &&
            debit.amount > (record.debits[index]?.amount ?? 0),
        );
        if (exceeded) {
          bucket.poisoned = true;
          overrun = true;
        }
        const next = bucket.used - reserved + used;
        if (!Number.isSafeInteger(next)) {
          bucket.poisoned = true;
          overrun = true;
        } else bucket.used = next;
      }
      record.charges = new Map(
        [...settledGroups].map(([scopeKey, group]) => [scopeKey, group.amount]),
      );
      record.settled = terminated;
      record.receipt = {
        ...record.receipt,
        state: overrun
          ? "limit-exceeded"
          : terminated
            ? "admitted"
            : "uncertain-after-interruption",
        released: terminated,
        uncertain: !terminated,
      };
      notify();
      return record.receipt;
    },
    /** Conservative union only. Learning a new name never creates capacity. */
    joinAliases(
      left: SharedCapacityScopeIdentityV1,
      right: SharedCapacityScopeIdentityV1,
    ): boolean {
      if (
        !sharedCapacityScopeIdentitySchema.safeParse(left).success ||
        !sharedCapacityScopeIdentitySchema.safeParse(right).success ||
        left.dimension !== right.dimension ||
        left.bucketKind !== right.bucketKind
      )
        return false;
      const a = root(key(left));
      const b = root(key(right));
      if (a === b) return true;
      if (aliases.size >= maxRecords) return false;
      const first = buckets.get(a);
      const second = buckets.get(b);
      const used = (first?.used ?? 0) + (second?.used ?? 0);
      if (!Number.isSafeInteger(used)) return false;
      aliases.set(b, a);
      buckets.set(a, {
        parentScopes: new Set([...(first?.parentScopes ?? []), ...(second?.parentScopes ?? [])]),
        scope: left,
        used,
        limit: Math.min(
          first?.limit ?? Number.MAX_SAFE_INTEGER,
          second?.limit ?? Number.MAX_SAFE_INTEGER,
        ),
        poisoned: first?.poisoned === true || second?.poisoned === true,
      });
      buckets.delete(b);
      notify();
      return true;
    },
    remaining(scope: SharedCapacityScopeIdentityV1, limit: number): number {
      const bucket = buckets.get(root(key(scope)));
      return bucket?.poisoned
        ? 0
        : Math.max(0, Math.min(limit, bucket?.limit ?? limit) - (bucket?.used ?? 0));
    },
    /** Tightening applies to already queued work as well as future reservations. */
    narrow(scope: SharedCapacityScopeIdentityV1, limit: number, parentScope: string) {
      if (
        !sharedCapacityScopeIdentitySchema.safeParse(scope).success ||
        !Number.isSafeInteger(limit) ||
        limit < 0
      )
        throw new Error("invalid resource limit");
      const scopeKey = root(key(scope));
      const bucket = buckets.get(scopeKey);
      buckets.set(scopeKey, {
        parentScopes: new Set([...(bucket?.parentScopes ?? []), parentScope]),
        scope,
        used: bucket?.used ?? 0,
        limit: Math.min(bucket?.limit ?? limit, limit),
        poisoned: bucket?.poisoned ?? false,
      });
      notify();
    },
    closeTask(parentScope: string) {
      for (const [id, record] of records)
        if (record.identity.parentScope === parentScope && record.settled) records.delete(id);
      const referenced = new Set(
        [...records.values()].flatMap((record) =>
          record.debits.map((debit) => root(key(debit.scope))),
        ),
      );
      for (const [scopeKey, bucket] of buckets) {
        bucket.parentScopes?.delete(parentScope);
        if (
          !referenced.has(scopeKey) &&
          (((bucket.scope.ownerKind === "task" ||
            (bucket.scope.ownerKind === "agent" && bucket.scope.family === "child")) &&
            bucket.parentScopes?.size === 0) ||
            (bucket.used === 0 && bucket.scope.family.startsWith("conflict:")))
        )
          buckets.delete(scopeKey);
      }
    },
    report() {
      return {
        reservations: records.size,
        buckets: buckets.size,
        uncertain: [...records.values()].filter((record) => record.receipt.uncertain).length,
      };
    },
  };
}
