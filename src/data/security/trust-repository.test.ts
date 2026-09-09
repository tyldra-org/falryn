import { afterEach, expect, test } from "bun:test";
import { inspectPackageTrust } from "../../application/extensions/package-trust.ts";
import { trustFixture } from "../../application/extensions/trust-fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { trustDecisionKey } from "../../domain/security/ecosystem-trust.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createTrustDecisionRepository } from "./trust-repository.ts";

afterEach(removeTemporaryRoots);
test("full contribution inventory fits the record bound; cancellation and failed transactions cannot become approval", async () => {
  const root = await temporaryRoot("falryn-trust-fault-");
  const { observation } = await trustFixture();
  const first = await openProductStoreOrThrow(root);
  const contributions = Array.from({ length: 1_024 }, (_, index) => canonicalDigest(index));
  const repository = createTrustDecisionRepository(first);
  const request = { action: "approve" as const, expiresAt: 10_000 };
  const preview = inspectPackageTrust(repository, observation, contributions, request);
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  const confirmed = { ...request, confirmation: preview.confirmation };
  expect(
    inspectPackageTrust(repository, observation, contributions, confirmed, AbortSignal.abort()),
  ).toMatchObject({ code: "cancelled" });
  await first.close();
  for (const failure of ["disk-full", "io-failure"] as const) {
    const faulty = await openProductStoreOrThrow(root, {
      faults: { failOperations: { transaction: failure } },
    });
    try {
      expect(
        inspectPackageTrust(
          createTrustDecisionRepository(faulty),
          observation,
          contributions,
          confirmed,
        ),
      ).toMatchObject({ code: failure === "io-failure" ? "uncertain" : "unavailable" });
    } finally {
      await faulty.close();
    }
  }
  const recovered = await openProductStoreOrThrow(root);
  try {
    const fresh = createTrustDecisionRepository(recovered);
    expect(inspectPackageTrust(fresh, observation, contributions)).toMatchObject({
      trust: { decisionStatus: "absent" },
    });
    expect(inspectPackageTrust(fresh, observation, contributions, confirmed).status).toBe(
      "applied",
    );
  } finally {
    await recovered.close();
  }
});
test("durable decisions survive restart; CAS prevents a stale writer overwriting revocation", async () => {
  const root = await temporaryRoot("falryn-trust-");
  const { observation } = await trustFixture();
  const first = await openProductStoreOrThrow(root);
  const repository = createTrustDecisionRepository(first);
  const request = { action: "approve" as const, expiresAt: 10_000 };
  const preview = inspectPackageTrust(repository, observation, [], request);
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  expect(
    inspectPackageTrust(repository, observation, [], {
      ...request,
      confirmation: preview.confirmation,
    }).status,
  ).toBe("applied");
  await first.close();
  const second = await openProductStoreOrThrow(root);
  try {
    const store = createTrustDecisionRepository(second);
    const key = trustDecisionKey(observation.subject, observation.scope, observation.actor);
    const read = store.get(key);
    if (!read.ok || read.value === null) throw new Error("read");
    expect(read.value.action).toBe("approve");
    const revoked = { ...read.value, action: "revoke" as const, expiresAt: null, revision: 2 };
    expect(store.replace(key, 1, revoked).ok).toBe(true);
    expect(store.replace(key, 1, { ...read.value, revision: 2 })).toMatchObject({
      error: { code: "conflict" },
    });
    expect(store.get(key)).toMatchObject({ value: { action: "revoke" } });
    second.write((sql) => sql.run("UPDATE trust_decisions SET decision_json = '{}'"));
    expect(store.get(key)).toMatchObject({ error: { code: "malformed" } });
    expect(store.replace(key, 2, { ...revoked, revision: 3 })).toMatchObject({
      error: { code: "malformed" },
    });
  } finally {
    await second.close();
  }
});
