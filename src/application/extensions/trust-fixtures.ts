import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { TrustDecision, TrustDecisionStore } from "../../domain/security/ecosystem-trust.ts";
import { inspectionHost, packageSource } from "./package-fixtures.ts";
import { packageTrustObservation } from "./package-trust.ts";
import { preparePackage } from "./prepare-package.ts";

export async function trustFixture() {
  const prepared = await preparePackage(packageSource(), inspectionHost);
  if (!prepared.ok) throw new Error(prepared.code);
  const observation = packageTrustObservation(prepared.package, canonicalDigest("actor"), 1_000);
  return { prepared: prepared.package, observation };
}
export function memoryTrustStore(): TrustDecisionStore {
  const records = new Map<string, TrustDecision>();
  return {
    get: (key) => ok(records.get(key) ?? null),
    replace(key, revision, decision, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      if ((records.get(key)?.revision ?? 0) !== revision) return err({ code: "conflict" });
      records.set(key, structuredClone(decision));
      return ok(null);
    },
  };
}
