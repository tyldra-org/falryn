import { join } from "node:path";
import { evaluateInstalledPackage } from "../../application/extensions/package-evaluation.ts";
import { projectInstalledTrust } from "../../application/extensions/package-standing.ts";
import { createPackageHealthRepository } from "../../data/extensions/package-health-repository.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import { createEvaluationRepository } from "../../data/security/evaluation-repository.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import type { PackageReceipt, PackageRequest } from "../../domain/extensions/lifecycle.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { FALRYN_VERSION } from "../version.ts";
import { composePackageStanding, localUserActor } from "./package-standing.ts";
import type { Services } from "./services.ts";

/**
 * `package evaluate` over the product database (#168). The only write is the evaluation history
 * record; trust, standing, lifecycle and health owners are read through their own repositories.
 */
export async function runPackageEvaluation(
  services: Services,
  stateRoot: string,
  store: Parameters<typeof createPackageLifecycleRepository>[0] | null,
  request: PackageRequest,
  base: PackageReceipt,
  signal: AbortSignal,
): Promise<PackageReceipt> {
  if (request.confirmation !== undefined || request.reason !== undefined)
    return { ...base, code: "unexpected-evaluation-input" };
  // Nothing is installed before the product database exists, and evaluation never creates it.
  if (store === null) return { ...base, code: "not-installed" };
  const actor = localUserActor();
  const now = () => Number(services.clock.now());
  const trustOwners = {
    decisions: createTrustDecisionRepository(store),
    provenance: createPackageProvenanceRepository(store),
    verifier: ed25519PackageVerifier,
  };
  const standing = composePackageStanding(services, stateRoot, store);
  const packages = createPackageLifecycleRepository(store);
  const result = await evaluateInstalledPackage(
    {
      packages,
      bytes: createHostPackageCache(join(stateRoot, "packages")),
      host: { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
      trust: (version) => projectInstalledTrust(trustOwners, version, actor, now()),
      standing: (packageId) => {
        const read = standing.standing(packageId, { versions: false });
        return read.ok ? { ok: true, value: read.value } : { ok: false };
      },
      health: createPackageHealthRepository(store),
      evaluations: createEvaluationRepository(store),
      now,
    },
    request.packageId,
    signal,
  );
  if (result.status === "failed")
    return {
      ...base,
      code: result.code,
      recovery: result.code === "uncertain" ? "inspect" : base.recovery,
      ...(result.code === "uncertain" ? { status: "uncertain" as const } : {}),
    };
  const current = packages.current(request.packageId);
  const revision = current.ok ? current.value.revision : request.expectedRevision;
  const digest = current.ok ? (current.value.current?.identityDigest ?? null) : null;
  return {
    ...base,
    status: "completed",
    code: `evaluated-${result.report.decision}`,
    priorRevision: revision,
    revision,
    priorDigest: digest,
    currentDigest: digest,
    recovery: "none",
    dataEffect: result.recorded ? "completed" : "none",
    data: JSON.parse(
      JSON.stringify({
        evaluation: {
          report: result.report,
          reportDigest: result.reportDigest,
          recorded: result.recorded,
          history: result.history,
        },
      }),
    ),
  };
}
