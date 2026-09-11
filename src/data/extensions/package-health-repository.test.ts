import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  initialHealthResult,
  PACKAGE_HEALTH_PROTOCOL,
  type PackageHealthRecord,
} from "../../domain/extensions/package-health.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createPackageHealthRepository } from "./package-health-repository.ts";

afterEach(removeTemporaryRoots);
test("durable occupancy fences a package and the shared host cap across repository owners and reopen", async () => {
  const root = await temporaryRoot("falryn-health-store-");
  const store = await openProductStoreOrThrow(root);
  const first = createPackageHealthRepository(store);
  const second = createPackageHealthRepository(store);
  const records: PackageHealthRecord[] = [];
  function pending(packageId: string): PackageHealthRecord {
    const operation = randomUUID();
    return {
      operation,
      packageId,
      fingerprint: canonicalDigest(operation),
      revision: 1,
      birth: null,
      directory: null,
      result: initialHealthResult({
        protocol: PACKAGE_HEALTH_PROTOCOL,
        attempt: randomUUID(),
        package: canonicalDigest(packageId),
        contribution: canonicalDigest(operation),
        generation: canonicalDigest("generation"),
      }),
    };
  }
  try {
    for (let i = 0; i < 4; i++) {
      const record = pending(`package-${i}`);
      expect(first.save(record, 0).ok).toBe(true);
      records.push(record);
    }
    expect(second.save(pending("package-0"), 0)).toMatchObject({
      ok: false,
      error: { code: "health-package-process-limit" },
    });
    expect(second.save(pending("package-4"), 0)).toMatchObject({
      ok: false,
      error: { code: "health-process-limit" },
    });
    const record = records[0];
    if (!record) throw new Error("missing record");
    expect(
      second.save(
        { ...record, revision: 2, result: { ...record.result, state: "failed", terminated: true } },
        1,
      ).ok,
    ).toBe(true);
    expect(first.save(pending("package-4"), 0).ok).toBe(true);
  } finally {
    await store.close();
  }
  const reopened = await openProductStoreOrThrow(root);
  try {
    const record = records[1];
    if (!record) throw new Error("missing record");
    const durable = createPackageHealthRepository(reopened);
    expect(durable.get(record.operation)).toEqual({ ok: true, value: record });
    expect(durable.save(pending("package-5"), 0)).toMatchObject({
      ok: false,
      error: { code: "health-process-limit" },
    });
  } finally {
    await reopened.close();
  }
});
