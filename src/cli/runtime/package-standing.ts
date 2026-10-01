import { userInfo } from "node:os";
import { join } from "node:path";
import {
  createPackageStanding,
  type PackageStandingOwner,
} from "../../application/extensions/package-standing.ts";
import { preparePackage } from "../../application/extensions/prepare-package.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type { PackageReceipt, PackageRequest } from "../../domain/extensions/lifecycle.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { FALRYN_VERSION } from "../version.ts";
import type { Services } from "./services.ts";

const HOLD_CODES = {
  quarantine: "quarantined",
  release: "released",
  revoke: "revoked",
} as const;
export type PackageStandingAction = "standing" | keyof typeof HOLD_CODES;

/** The local user who decides holds; the same identity the trust and catalog owners use. */
export function localUserActor(): string {
  const user = userInfo();
  return canonicalDigest({ kind: "local-user", uid: user.uid, username: user.username });
}

/** The package standing owner over the product database. It reads installed records only. */
export function composePackageStanding(
  services: Services,
  stateRoot: string,
  store: SqliteStorePort,
): PackageStandingOwner {
  const bytes = createHostPackageCache(join(stateRoot, "packages"));
  const host = {
    falryn: FALRYN_VERSION,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
  };
  return createPackageStanding({
    owners: {
      packages: createPackageLifecycleRepository(store),
      decisions: createTrustDecisionRepository(store),
      provenance: createPackageProvenanceRepository(store),
      verifier: ed25519PackageVerifier,
    },
    actor: localUserActor(),
    now: () => Number(services.clock.now()),
    async contributions(version, signal) {
      // Cached bytes may be the reason for the hold; the caller treats a failure here as "unknown".
      const snapshot = await bytes.read(version, signal);
      const prepared = await preparePackage({ read: async () => snapshot }, host, {
        candidates: version.dependencies,
        signal,
      });
      if (!prepared.ok) throw new Error(prepared.code);
      return prepared.package.contributions.map((entry) => entry.identityDigest);
    },
  });
}

/** Run `standing`, `quarantine`, `release` or `revoke` for one installed package. */
export async function runPackageStanding(
  owner: PackageStandingOwner,
  action: PackageStandingAction,
  request: PackageRequest,
  base: PackageReceipt,
  signal: AbortSignal,
): Promise<PackageReceipt> {
  if (action === "standing") {
    if (request.confirmation !== undefined || request.reason !== undefined)
      return { ...base, code: "unexpected-standing-input" };
    const result = owner.standing(request.packageId);
    if (!result.ok) return { ...base, code: result.error.code };
    return {
      ...base,
      status: "completed",
      code: "standing",
      recovery: "none",
      priorRevision: result.value.revision,
      revision: result.value.revision,
      priorDigest: result.value.identityDigest,
      currentDigest: result.value.identityDigest,
      data: JSON.parse(JSON.stringify({ standing: result.value })),
    };
  }
  const result = await owner.enforce(
    {
      action,
      packageId: request.packageId,
      expectedRevision: request.expectedRevision,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
    },
    signal,
  );
  if (result.status === "failed")
    return {
      ...base,
      code: result.code,
      recovery: result.code === "uncertain" ? "inspect" : "fresh-preview",
      ...(result.code === "uncertain" ? { status: "uncertain" as const } : {}),
    };
  const { standing } = result;
  return {
    ...base,
    status: result.status === "preview" ? "preview" : "completed",
    code: result.status === "preview" ? "confirmation-required" : HOLD_CODES[action],
    confirmation: result.confirmation,
    priorRevision: standing.revision,
    revision: standing.revision,
    priorDigest: standing.identityDigest,
    currentDigest: standing.identityDigest,
    recovery: "none",
    data: JSON.parse(
      JSON.stringify({
        before: result.before,
        standing,
        runningWork: result.runningWork,
        affectedContributions: result.affectedContributions,
      }),
    ),
  };
}
