import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPackageHealthRepository } from "../../data/extensions/package-health-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { packageRequestSchema } from "../../domain/extensions/lifecycle.ts";
import {
  initialHealthResult,
  PACKAGE_TOOL_PROTOCOL,
  type PackageHealthRecord,
} from "../../domain/extensions/package-health.ts";
import { createPackageToolRecovery } from "./package-tool-recovery.ts";

afterEach(removeTemporaryRoots);
test("confirmed native recovery settles durable ownership once and never repeats the tool", async () => {
  const store = await openProductStoreOrThrow(await temporaryRoot("falryn-native-recovery-"));
  try {
    const records = createPackageHealthRepository(store);
    const digest = canonicalDigest("fixture");
    const record: PackageHealthRecord = {
      operation: randomUUID(),
      packageId: "fixture",
      fingerprint: digest,
      revision: 1,
      birth: null,
      directory: null,
      result: initialHealthResult({
        protocol: PACKAGE_TOOL_PROTOCOL,
        attempt: randomUUID(),
        package: digest,
        contribution: digest,
        generation: digest,
      }),
    };
    expect(records.save(record, 0).ok).toBe(true);
    let cleanups = 0;
    const recover = createPackageToolRecovery(records, {
      run: async () => {
        throw new Error("recovery cannot execute a package");
      },
      recover: async (prior) => {
        cleanups++;
        return {
          ...prior,
          revision: prior.revision + 1,
          result: { ...prior.result, state: "recovered", terminated: true, cleanup: "removed" },
        };
      },
    });
    const request = packageRequestSchema.parse({
      operationId: randomUUID(),
      packageId: "fixture",
      expectedRevision: 0,
      nativeRecovery: { operation: record.operation },
    });
    const preview = await recover(request, new AbortController().signal);
    expect(preview.status).toBe("preview");
    expect(cleanups).toBe(0);
    const confirmed = { ...request, confirmation: preview.confirmation ?? "" };
    expect(await recover(confirmed, new AbortController().signal)).toMatchObject({
      status: "completed",
      code: "native-process-recovered",
    });
    expect(cleanups).toBe(1);
    expect(await recover(confirmed, new AbortController().signal)).toMatchObject({
      status: "completed",
      dataEffect: "none",
    });
    expect(cleanups).toBe(1);
    expect(
      await recover({ ...request, packageId: "different" }, new AbortController().signal),
    ).toMatchObject({ status: "failed", code: "native-attempt-not-found" });
    expect(records.pending(digest)).toEqual({ ok: true, value: null });
  } finally {
    await store.close();
  }
});

test("unverified process ownership remains uncertain and fenced after recovery", async () => {
  const store = await openProductStoreOrThrow(await temporaryRoot("falryn-native-uncertain-"));
  try {
    const records = createPackageHealthRepository(store);
    const digest = canonicalDigest("fixture");
    const record: PackageHealthRecord = {
      operation: randomUUID(),
      packageId: "fixture",
      fingerprint: digest,
      revision: 1,
      birth: null,
      directory: null,
      result: initialHealthResult({
        protocol: PACKAGE_TOOL_PROTOCOL,
        attempt: randomUUID(),
        package: digest,
        contribution: digest,
        generation: digest,
      }),
    };
    expect(records.save(record, 0).ok).toBe(true);
    const recover = createPackageToolRecovery(records, {
      run: async () => {
        throw new Error("unexpected launch");
      },
      recover: async (prior) => ({
        ...prior,
        revision: prior.revision + 1,
        result: { ...prior.result, state: "uncertain", code: "health-ownership-unknown" },
      }),
    });
    const request = packageRequestSchema.parse({
      operationId: randomUUID(),
      packageId: "fixture",
      expectedRevision: 0,
      nativeRecovery: { operation: record.operation },
    });
    const preview = await recover(request, new AbortController().signal);
    expect(
      await recover(
        { ...request, confirmation: preview.confirmation ?? "" },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "uncertain", recovery: "recover" });
    expect(records.pending(digest)).toMatchObject({
      ok: true,
      value: { operation: record.operation },
    });
  } finally {
    await store.close();
  }
});
