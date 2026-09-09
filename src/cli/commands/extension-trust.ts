import { userInfo } from "node:os";
import { inspectProvenanceTrust } from "../../application/extensions/package-provenance.ts";
import {
  type PackageTrustResult,
  packageTrustObservation,
  type TrustRequest,
} from "../../application/extensions/package-trust.ts";
import type { PreparedPackage } from "../../application/extensions/prepare-package.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { TrustDecisionStore } from "../../domain/security/ecosystem-trust.ts";
import { isCleanClose, isRootUsable } from "../../domain/storage/index.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { openSessionStore } from "./storage.ts";

const emptyStore: TrustDecisionStore = {
  get: () => ok(null),
  replace: () => err({ code: "unavailable" }),
};

/** Composition owns local actor and storage; package metadata cannot supply either. */
export async function runPackageTrust(
  prepared: PreparedPackage,
  services: ServiceProvider,
  request?: TrustRequest,
  signal = new AbortController().signal,
): Promise<PackageTrustResult> {
  const task = processProductResources.openTask("package-trust-v1");
  try {
    const executed = await task.execute({
      operation: "package-trust",
      attempt: "1",
      generation: task.generation,
      inputBytes: Buffer.byteLength(JSON.stringify(request ?? {})),
      amounts: { operations: 1, concurrency: 1, memoryBytes: 1_048_576 },
      signal,
      unit: {
        id: workUnitId("package-trust"),
        effect: request?.confirmation === undefined ? "observation" : "mutation",
        priority: "interactive",
        conflictKeys: [conflictKey("package-trust", prepared.identityDigest)],
        dependencies: [],
        deadline: null,
        expectedOutputBytes: 262_144,
        retry: NO_RETRY,
        scopeId: null,
      },
      async run(admittedSignal) {
        return {
          value: await executePackageTrust(prepared, services, request, admittedSignal),
          terminated: true,
        };
      },
    });
    return executed.kind === "completed"
      ? executed.value
      : { status: "failed", code: executed.receipt.state };
  } finally {
    task.close();
  }
}

async function executePackageTrust(
  prepared: PreparedPackage,
  services: ServiceProvider,
  request?: TrustRequest,
  signal?: AbortSignal,
): Promise<PackageTrustResult> {
  const resolved = services();
  const actor = canonicalDigest({
    kind: "local-user",
    uid: userInfo().uid,
    username: userInfo().username,
  });
  const observation = packageTrustObservation(prepared, actor, Number(resolved.clock.now()));
  const affected = prepared.contributions.map((entry) => entry.identityDigest);
  if (signal?.aborted) return { status: "failed", code: "cancelled" };
  let opened = await openSessionStore(services, signal);
  if (!opened.ok) return { status: "failed", code: "trust-store-unavailable" };
  if (opened.kind === "absent" && request?.confirmation === undefined)
    return inspectProvenanceTrust(
      {
        decisions: emptyStore,
        provenance: { get: () => ok(null), replace: () => err({ code: "unavailable" }) },
        verifier: ed25519PackageVerifier,
      },
      observation,
      affected,
      request,
      signal,
    );
  if (opened.kind === "absent") {
    const roots = await resolved.localData.prepareRoots(["state"], signal);
    if (!roots.every(isRootUsable)) return { status: "failed", code: "trust-store-unavailable" };
    const stateRoot = rootChild(resolved.localData.layout, "state");
    const path = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
    if (path === null || stateRoot === null)
      return { status: "failed", code: "trust-store-unavailable" };
    const created = await openSqliteStore(
      {
        open: openBunSqlite,
        clock: resolved.clock,
        databasePath: path,
        backupDirectory: stateRoot,
        migrations: PRODUCTION_MIGRATIONS,
        create: true,
      },
      signal,
    );
    if (!created.ok) return { status: "failed", code: "trust-store-unavailable" };
    opened = { ok: true, kind: "open", store: created.value };
  }
  let result: PackageTrustResult;
  try {
    result = inspectProvenanceTrust(
      {
        decisions: createTrustDecisionRepository(opened.store),
        provenance: createPackageProvenanceRepository(opened.store),
        verifier: ed25519PackageVerifier,
      },
      { ...observation, now: Number(resolved.clock.now()) },
      affected,
      request,
      signal,
    );
  } catch {
    result = {
      status: "failed",
      code: request?.confirmation === undefined ? "trust-store-unavailable" : "uncertain",
    };
  }
  const closed = await opened.store.close();
  if (!isCleanClose(closed))
    return {
      status: "failed",
      code: result.status === "applied" ? "uncertain" : "trust-store-close-failed",
    };
  return result;
}
