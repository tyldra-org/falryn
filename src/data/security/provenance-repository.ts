import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  type FullUserGrantStore,
  fullUserGrantKey,
  fullUserGrantRecordSchema,
} from "../../domain/security/full-user-grant.ts";
import {
  type PackageProvenanceStore,
  packageProvenanceSchema,
} from "../../domain/security/package-provenance.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";

function json(row: Record<string, unknown>, maximum: number): unknown {
  if (typeof row.record_json !== "string" || Buffer.byteLength(row.record_json) > maximum)
    return null;
  try {
    return JSON.parse(row.record_json);
  } catch {
    return null;
  }
}
function provenance(row: Record<string, unknown>) {
  const parsed = packageProvenanceSchema.safeParse(json(row, 16384));
  return parsed.success &&
    parsed.data.key === row.evidence_key &&
    parsed.data.revision === row.revision
    ? parsed.data
    : null;
}
function grant(row: Record<string, unknown>) {
  const parsed = fullUserGrantRecordSchema.safeParse(json(row, 524288));
  return parsed.success &&
    parsed.data.id === row.grant_id &&
    parsed.data.revision === row.revision &&
    parsed.data.actor === row.actor &&
    parsed.data.provenanceKey === row.evidence_key &&
    fullUserGrantKey(parsed.data.identity) === row.identity_key
    ? parsed.data
    : null;
}
export function createPackageProvenanceRepository(store: SqliteStorePort): PackageProvenanceStore {
  return {
    get(key) {
      const rows = store.read("SELECT * FROM package_provenance WHERE evidence_key=$key", { key });
      if (!rows.ok) return err({ code: "unavailable" });
      const row = rows.value[0];
      if (row === undefined) return ok(null);
      const value = provenance(row);
      return value === null ? err({ code: "malformed" }) : ok(value);
    },
    replace(record, expectedRevision, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      if (
        !packageProvenanceSchema.safeParse(record).success ||
        record.revision !== expectedRevision + 1 ||
        Buffer.byteLength(JSON.stringify(record)) > 16384
      )
        return err({ code: "malformed" });
      const result = store.write((sql) => {
        const row = sql.all("SELECT * FROM package_provenance WHERE evidence_key=$key", {
          key: record.key,
        })[0];
        const previous = row === undefined ? null : provenance(row);
        if (row !== undefined && previous === null) return "malformed" as const;
        if ((previous?.revision ?? 0) !== expectedRevision) return "conflict" as const;
        // A lower sequence, missing advisory, or conflicting same-sequence body cannot erase a known revocation.
        if (
          previous !== null &&
          (record.advisorySequence < previous.advisorySequence ||
            (record.advisorySequence === previous.advisorySequence &&
              record.advisoryDigest !== previous.advisoryDigest))
        )
          return "conflict" as const;
        sql.run(
          "INSERT INTO package_provenance(evidence_key,revision,record_json) VALUES($key,$revision,$json) ON CONFLICT(evidence_key) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json",
          { key: record.key, revision: record.revision, json: JSON.stringify(record) },
        );
        sql.run(
          "INSERT INTO package_trust_receipts(subject_id,revision,record_digest,action,observed_at,record_json) VALUES($key,$revision,$digest,'evidence-refresh',$time,$json)",
          {
            key: record.key,
            revision: record.revision,
            digest: canonicalDigest(record),
            time: record.evidence.observedAt,
            json: JSON.stringify(record),
          },
        );
        return null;
      }, signal);
      if (!result.ok)
        return err({ code: result.error.effect === "uncertain" ? "uncertain" : "unavailable" });
      return result.value.value === null ? ok(null) : err({ code: result.value.value });
    },
  };
}
export function createFullUserGrantRepository(store: SqliteStorePort): FullUserGrantStore {
  return {
    get(id) {
      const rows = store.read("SELECT * FROM full_user_grants WHERE grant_id=$id", { id });
      if (!rows.ok) return err({ code: "unavailable" });
      const row = rows.value[0];
      if (row === undefined) return ok(null);
      const record = grant(row);
      return record === null ? err({ code: "malformed" }) : ok(record);
    },
    replace(record, expectedRevision, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      const parsed = fullUserGrantRecordSchema.safeParse(record);
      if (
        !parsed.success ||
        record.revision !== expectedRevision + 1 ||
        Buffer.byteLength(JSON.stringify(record)) > 524288
      )
        return err({ code: "malformed" });
      const key = fullUserGrantKey(parsed.data.identity);
      const result = store.write((sql) => {
        const row = sql.all(
          "SELECT * FROM full_user_grants WHERE grant_id=$id OR (identity_key=$key AND actor=$actor)",
          { id: record.id, key, actor: record.actor },
        )[0];
        const previous = row === undefined ? null : grant(row);
        if (row !== undefined && previous === null) return "malformed" as const;
        if (
          (previous?.revision ?? 0) !== expectedRevision ||
          (previous !== null &&
            (previous.id !== record.id ||
              previous.actor !== record.actor ||
              fullUserGrantKey(previous.identity) !== key ||
              previous.provenanceKey !== record.provenanceKey))
        )
          return "conflict" as const;
        if (
          record.state === "automatic-allowed" &&
          previous?.state !== "explicit-allowed" &&
          previous?.state !== "automatic-allowed"
        )
          return "conflict" as const;
        const facts = sql.all("SELECT * FROM package_provenance WHERE evidence_key=$key", {
          key: record.provenanceKey,
        })[0];
        const evidence = facts === undefined ? null : provenance(facts);
        if (
          record.state.endsWith("allowed") &&
          (evidence === null ||
            evidence.evidence.reference !== record.evidenceBinding ||
            evidence.evidence.advisory === "revoked" ||
            evidence.evidence.advisory === "quarantined" ||
            evidence.evidence.integrity === "mismatch" ||
            evidence.evidence.signature === "invalid" ||
            evidence.evidence.signature === "conflicting" ||
            evidence.actor !== record.actor ||
            canonicalDigest(evidence.identity) !== canonicalDigest(record.identity.package) ||
            evidence.scope.kind !== record.identity.scope.kind ||
            evidence.scope.authority !== record.identity.scope.authority ||
            record.identity.provenance.publisher !== evidence.publisher ||
            record.identity.provenance.signingKey !== evidence.signingKey ||
            record.identity.provenance.signature !== evidence.signatureDigest ||
            record.identity.provenance.certificate !== null ||
            record.identity.provenance.attestationStatement !== evidence.attestationStatement ||
            record.identity.provenance.attestationSigner !== evidence.attestationSigner ||
            record.identity.provenance.transparencyLog !== evidence.transparencyLog ||
            (previous !== null && record.decidedAt < previous.decidedAt) ||
            evidence.evidence.observedAt > record.decidedAt ||
            (evidence.evidence.expiresAt !== null &&
              evidence.evidence.expiresAt <= record.decidedAt))
        )
          return "conflict" as const;
        sql.run(
          "INSERT INTO full_user_grants(grant_id,identity_key,actor,evidence_key,revision,record_json) VALUES($id,$key,$actor,$evidence,$revision,$json) ON CONFLICT(grant_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json",
          {
            id: record.id,
            key,
            actor: record.actor,
            evidence: record.provenanceKey,
            revision: record.revision,
            json: JSON.stringify(parsed.data),
          },
        );
        sql.run(
          "INSERT INTO package_trust_receipts(subject_id,revision,record_digest,action,observed_at,record_json) VALUES($id,$revision,$digest,$action,$time,$json)",
          {
            id: record.id,
            revision: record.revision,
            digest: canonicalDigest(parsed.data),
            action: record.state,
            time: record.decidedAt,
            json: JSON.stringify(parsed.data),
          },
        );
        return null;
      }, signal);
      if (!result.ok)
        return err({ code: result.error.effect === "uncertain" ? "uncertain" : "unavailable" });
      return result.value.value === null ? ok(null) : err({ code: result.value.value });
    },
  };
}
