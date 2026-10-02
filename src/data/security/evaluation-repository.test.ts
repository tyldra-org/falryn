import { afterEach, expect, test } from "bun:test";
import {
  curatedVerification,
  curatorReport,
} from "../../application/extensions/evaluation-fixtures.ts";
import {
  curatorEvaluationRecord,
  verifyPackageProvenance,
} from "../../application/extensions/package-provenance.ts";
import { trustFixture } from "../../application/extensions/trust-fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type { PackageIdentityV1 } from "../../domain/extensions/identity.ts";
import {
  EVALUATION_LIMITS,
  type EvaluationRecord,
  evaluationReportDigest,
} from "../../domain/security/package-evaluation.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createEvaluationRepository, PACKAGE_EVALUATIONS_TABLE } from "./evaluation-repository.ts";
import { createPackageProvenanceRepository } from "./provenance-repository.ts";

afterEach(removeTemporaryRoots);

function record(subject: PackageIdentityV1, build: string, at = 1): EvaluationRecord {
  const base = curatorReport(subject, {}, at);
  const report = { ...base, evaluator: { ...base.evaluator, falryn: build } };
  return {
    version: 1,
    packageId: subject.packageId,
    identityDigest: canonicalDigest(subject),
    reportDigest: evaluationReportDigest(report),
    report,
    curation: null,
    recordedAt: at,
  };
}

test("history keeps one record per unchanged report, newest first, across restarts", async () => {
  const root = await temporaryRoot("falryn-evaluations-");
  const { observation } = await trustFixture();
  const subject = observation.subject.identity;
  const replaced = { ...subject, packageDigest: canonicalDigest("replacement bytes") };
  const first = await openProductStoreOrThrow(root);
  try {
    const repository = createEvaluationRepository(first);
    expect(repository.append(record(subject, "0.0.1", 1))).toMatchObject({
      value: { added: true },
    });
    // The same facts observed later are the same evidence.
    expect(repository.append(record(subject, "0.0.1", 9))).toMatchObject({
      value: { added: false },
    });
    expect(repository.append(record(replaced, "0.0.1", 2))).toMatchObject({
      value: { added: true },
    });
    const controller = new AbortController();
    controller.abort();
    expect(repository.append(record(subject, "0.0.2"), controller.signal)).toMatchObject({
      error: { code: "cancelled" },
    });
  } finally {
    await first.close();
  }
  const reopened = await openProductStoreOrThrow(root);
  try {
    const history = createEvaluationRepository(reopened).history(subject.packageId, 8);
    if (!history.ok) throw new Error(history.error.code);
    expect(history.value.map((entry) => [entry.identityDigest, entry.recordedAt])).toEqual([
      [canonicalDigest(replaced), 2],
      [canonicalDigest(subject), 1],
    ]);
  } finally {
    await reopened.close();
  }
});

test("retention drops the oldest records first, per identity and in total", async () => {
  const root = await temporaryRoot("falryn-evaluations-bounds-");
  const { observation } = await trustFixture();
  const subject = observation.subject.identity;
  const store = await openProductStoreOrThrow(root);
  try {
    const repository = createEvaluationRepository(store);
    const extra = 3;
    for (let index = 0; index < EVALUATION_LIMITS.historyPerIdentity + extra; index++)
      expect(repository.append(record(subject, `0.0.${index}`, index)).ok).toBe(true);
    const kept = store.read(
      `SELECT recorded_at FROM ${PACKAGE_EVALUATIONS_TABLE} ORDER BY sequence`,
    );
    if (!kept.ok) throw new Error("read");
    expect(kept.value.map((row) => row.recorded_at)).toEqual(
      Array.from({ length: EVALUATION_LIMITS.historyPerIdentity }, (_, index) => index + extra),
    );
    for (let index = 0; index < EVALUATION_LIMITS.historyTotal; index++) {
      const other = { ...subject, packageDigest: canonicalDigest(`bytes ${index}`) };
      expect(repository.append(record(other, "0.0.1", 1_000 + index)).ok).toBe(true);
    }
    const total = store.read(
      `SELECT min(recorded_at) AS oldest, count(*) AS count FROM ${PACKAGE_EVALUATIONS_TABLE}`,
    );
    expect(total).toMatchObject({
      value: [{ oldest: 1_000, count: EVALUATION_LIMITS.historyTotal }],
    });
  } finally {
    await store.close();
  }
});

test("an unreadable record fails the whole history rather than shortening it", async () => {
  const root = await temporaryRoot("falryn-evaluations-malformed-");
  const { observation } = await trustFixture();
  const store = await openProductStoreOrThrow(root);
  try {
    const repository = createEvaluationRepository(store);
    expect(repository.append(record(observation.subject.identity, "0.0.1")).ok).toBe(true);
    store.write((sql) =>
      sql.run(`UPDATE ${PACKAGE_EVALUATIONS_TABLE} SET record_json='{"version":1}'`),
    );
    expect(repository.history(observation.subject.identity.packageId, 8)).toMatchObject({
      error: { code: "malformed" },
    });
  } finally {
    await store.close();
  }
});

test("a curation refresh retains its report with the evidence, and a failed write keeps neither", async () => {
  const root = await temporaryRoot("falryn-evaluations-provenance-");
  const { observation } = await trustFixture();
  const input = curatedVerification(observation);
  const facts = verifyPackageProvenance(observation, input, ed25519PackageVerifier, 1);
  const evaluation = curatorEvaluationRecord(facts, input);
  if (evaluation === null) throw new Error("evaluation");
  const store = await openProductStoreOrThrow(root);
  try {
    const provenance = createPackageProvenanceRepository(store);
    const evaluations = createEvaluationRepository(store);
    // A stale expected revision is a conflict: no evidence, no report.
    expect(provenance.replace({ ...facts, revision: 2 }, 1, undefined, evaluation).ok).toBe(false);
    expect(evaluations.history(evaluation.packageId, 8)).toMatchObject({ value: [] });
    // A report that cannot be stored rolls the evidence back with it.
    const broken = { ...evaluation, reportDigest: canonicalDigest("other") };
    expect(provenance.replace(facts, 0, undefined, broken).ok).toBe(false);
    expect(provenance.get(facts.key)).toMatchObject({ value: null });
    expect(provenance.replace(facts, 0, undefined, evaluation).ok).toBe(true);
    expect(provenance.get(facts.key)).toMatchObject({
      value: { curationStatus: "verified", evidence: { curation: "verified" } },
    });
    expect(evaluations.history(evaluation.packageId, 8)).toMatchObject({
      value: [{ curation: { status: "verified" }, report: { evaluator: { kind: "curator" } } }],
    });
  } finally {
    await store.close();
  }
});
