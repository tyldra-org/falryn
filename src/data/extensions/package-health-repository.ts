import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  PACKAGE_HEALTH_LIMITS,
  type PackageHealthRecord,
  type PackageHealthStore,
  packageHealthRecordSchema,
} from "../../domain/extensions/package-health.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";

export const PACKAGE_HEALTH_TABLE = "package_health_attempts";
export const MIGRATION_0023: Migration = {
  version: 23,
  name: "create-package-health-attempts",
  destructive: false,
  statements: [
    `CREATE TABLE package_health_attempts (operation TEXT PRIMARY KEY, package_id TEXT NOT NULL, contribution TEXT NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1)), record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) BETWEEN 1 AND 131072)) STRICT`,
    "CREATE UNIQUE INDEX package_health_pending ON package_health_attempts(contribution) WHERE pending = 1",
    "CREATE UNIQUE INDEX package_health_package_pending ON package_health_attempts(package_id) WHERE pending = 1",
    "CREATE INDEX package_health_generation ON package_health_attempts(contribution, generation)",
  ],
};
function decode(row: Record<string, unknown>): PackageHealthRecord {
  if (typeof row.record_json !== "string" || Buffer.byteLength(row.record_json) > 131_072)
    throw new Error("invalid-health-record");
  const record = packageHealthRecordSchema.parse(JSON.parse(row.record_json));
  if (
    record.operation !== row.operation ||
    record.packageId !== row.package_id ||
    record.revision !== row.revision ||
    record.result.binding.contribution !== row.contribution ||
    record.result.binding.generation !== row.generation ||
    Number(!record.result.terminated) !== row.pending
  )
    throw new Error("invalid-health-record");
  return record;
}
export function createPackageHealthRepository(store: SqliteStorePort): PackageHealthStore {
  const read = (sql: string, bindings: Record<string, string>) => {
    try {
      const found = store.read(sql, bindings);
      return found.ok ? ok(found.value.map(decode)) : err({ code: "health-store-unavailable" });
    } catch {
      return err({ code: "health-record-malformed" });
    }
  };
  return {
    get(operation) {
      const found = read("SELECT * FROM package_health_attempts WHERE operation=$operation", {
        operation,
      });
      return found.ok ? ok(found.value[0] ?? null) : found;
    },
    pending(contribution) {
      const found = read(
        "SELECT * FROM package_health_attempts WHERE contribution=$contribution AND pending=1 LIMIT 1",
        { contribution },
      );
      return found.ok ? ok(found.value[0] ?? null) : found;
    },
    failures(contribution, generation) {
      const found = read(
        "SELECT * FROM package_health_attempts WHERE contribution=$contribution AND generation=$generation ORDER BY rowid DESC LIMIT 3",
        { contribution, generation },
      );
      if (!found.ok) return found;
      let failures = 0;
      for (const record of found.value) {
        if (record.result.state !== "failed") break;
        failures++;
      }
      return ok(failures);
    },
    save(record, expected) {
      try {
        const parsed = packageHealthRecordSchema.parse(record);
        const json = JSON.stringify(parsed);
        if (parsed.revision !== expected + 1 || Buffer.byteLength(json) > 131_072)
          return err({ code: "invalid-health-record" });
        const saved = store.write((tx) => {
          const row = tx.all("SELECT * FROM package_health_attempts WHERE operation=$operation", {
            operation: parsed.operation,
          })[0];
          const prior = row === undefined ? null : decode(row);
          if (
            (prior?.revision ?? 0) !== expected ||
            (prior !== null &&
              (prior.fingerprint !== parsed.fingerprint ||
                prior.packageId !== parsed.packageId ||
                canonicalDigest(prior.result.binding) !== canonicalDigest(parsed.result.binding) ||
                (prior.result.terminated && !parsed.result.terminated)))
          )
            return "stale-health-record";
          if (prior === null) {
            if (
              parsed.result.state !== "starting" ||
              parsed.result.terminated ||
              parsed.result.pid !== null ||
              parsed.birth !== null ||
              parsed.directory !== null
            )
              return "invalid-health-record";
            if (
              tx.all(
                "SELECT operation FROM package_health_attempts WHERE package_id=$packageId AND pending=1 LIMIT 1",
                { packageId: parsed.packageId },
              ).length
            )
              return "health-package-process-limit";
            const pending = tx.all(
              "SELECT operation FROM package_health_attempts WHERE pending=1 LIMIT 4",
            );
            if (pending.length >= PACKAGE_HEALTH_LIMITS.processes) return "health-process-limit";
          }
          tx.run(
            "INSERT INTO package_health_attempts(operation,package_id,contribution,generation,revision,pending,record_json) VALUES($operation,$packageId,$contribution,$generation,$revision,$pending,$json) ON CONFLICT(operation) DO UPDATE SET revision=excluded.revision,pending=excluded.pending,record_json=excluded.record_json",
            {
              operation: parsed.operation,
              packageId: parsed.packageId,
              contribution: parsed.result.binding.contribution,
              generation: parsed.result.binding.generation,
              revision: parsed.revision,
              pending: Number(!parsed.result.terminated),
              json,
            },
          );
          return null;
        });
        if (!saved.ok)
          return err({
            code:
              saved.error.effect === "uncertain"
                ? "health-store-uncertain"
                : "health-store-unavailable",
          });
        return saved.value.value === null ? ok(null) : err({ code: saved.value.value });
      } catch {
        return err({ code: "health-store-conflict" });
      }
    },
  };
}
