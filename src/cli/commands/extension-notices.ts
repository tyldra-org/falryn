/** `falryn extension notices`: derived trust, compatibility and health notices (#166). */
import { userInfo } from "node:os";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { preparePackage } from "../../application/extensions/index.ts";
import {
  inspectPackageNotices,
  type NoticeRequest,
  type PackageNoticeOwners,
  type PackageNoticesResult,
} from "../../application/extensions/package-notices.ts";
import { packageTrustObservation } from "../../application/extensions/package-trust.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createPackageHealthRepository } from "../../data/extensions/package-health-repository.ts";
import { createNoticeAcknowledgementRepository } from "../../data/security/notice-repository.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import { isCleanClose } from "../../domain/storage/index.ts";
import { createHostPackageSource } from "../../integrations/extensions/host-package-inspection.ts";
import type { CommandResultOf } from "../output/result.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { createExtensionStateStore } from "./extension-state.ts";
import { type ExtensionTarget, readInstalledPackage } from "./installed-package.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export type ExtensionNoticesPayload = PackageNoticesResult;

/** With no database there is nothing recorded: every owner answers empty and refuses writes. */
const absentOwners: PackageNoticeOwners = {
  decisions: { get: () => ok(null), replace: () => err({ code: "unavailable" }) },
  provenance: { get: () => ok(null), replace: () => err({ code: "unavailable" }) },
  acknowledgements: { get: () => ok(null), replace: () => err({ code: "unavailable" }) },
  health: { latestPerContribution: () => ok([]) },
};

async function executeNotices(
  target: ExtensionTarget,
  services: ServiceProvider,
  request: NoticeRequest | undefined,
  signal: AbortSignal,
): Promise<PackageNoticesResult> {
  const resolved = services();
  const host = {
    falryn: FALRYN_VERSION,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
  };
  let prepared: Awaited<ReturnType<typeof preparePackage>>;
  if (typeof target === "string")
    prepared = await preparePackage(createHostPackageSource(target), host, { signal });
  else {
    const installed = await readInstalledPackage(services, target.installed, signal);
    prepared = installed.ok
      ? await preparePackage({ read: async () => installed.snapshot }, host, {
          candidates: installed.dependencies,
          signal,
        })
      : { ok: false, code: installed.code };
  }
  if (!prepared.ok) return { status: "failed", code: prepared.code };
  // The local actor comes from composition; package metadata cannot supply it.
  const actor = canonicalDigest({
    kind: "local-user",
    uid: userInfo().uid,
    username: userInfo().username,
  });
  const observation = () =>
    packageTrustObservation(prepared.package, actor, Number(resolved.clock.now()));
  if (signal.aborted) return { status: "failed", code: "cancelled" };
  let opened = await openSessionStore(services, signal);
  if (!opened.ok) return { status: "failed", code: "notice-store-unavailable" };
  if (opened.kind === "absent" && request?.confirmation === undefined)
    return inspectPackageNotices(absentOwners, prepared.package, observation(), request, signal);
  if (opened.kind === "absent") {
    const created = await createExtensionStateStore(resolved, signal);
    if (created === null) return { status: "failed", code: "notice-store-unavailable" };
    opened = { ok: true, kind: "open", store: created };
  }
  let result: PackageNoticesResult;
  try {
    result = inspectPackageNotices(
      {
        decisions: createTrustDecisionRepository(opened.store),
        provenance: createPackageProvenanceRepository(opened.store),
        acknowledgements: createNoticeAcknowledgementRepository(opened.store),
        health: createPackageHealthRepository(opened.store),
      },
      prepared.package,
      observation(),
      request,
      signal,
    );
  } catch {
    result = {
      status: "failed",
      code: request?.confirmation === undefined ? "notice-store-unavailable" : "uncertain",
    };
  }
  const closed = await opened.store.close();
  if (!isCleanClose(closed))
    return {
      status: "failed",
      code: result.status === "applied" ? "uncertain" : "notice-store-close-failed",
    };
  return result;
}

export async function runExtensionNotices(
  target: ExtensionTarget,
  signal: AbortSignal | undefined,
  services: ServiceProvider,
  request?: NoticeRequest,
): Promise<CommandResultOf<"extension.notices", ExtensionNoticesPayload>> {
  const abort = signal ?? new AbortController().signal;
  const task = processProductResources.openTask("extension-notices-v1");
  let payload: PackageNoticesResult;
  try {
    const executed = await task.execute({
      operation: "extension-notices",
      attempt: "1",
      generation: task.generation,
      inputBytes: Buffer.byteLength(JSON.stringify(request ?? {})),
      amounts: { operations: 1, concurrency: 1, memoryBytes: 1_048_576 },
      signal: abort,
      unit: {
        id: workUnitId("extension-notices"),
        effect: request?.confirmation === undefined ? "observation" : "mutation",
        priority: "interactive",
        conflictKeys: [
          conflictKey(
            "extension-notices",
            typeof target === "string" ? target : `installed:${target.installed}`,
          ),
        ],
        dependencies: [],
        deadline: null,
        expectedOutputBytes: 262_144,
        retry: NO_RETRY,
        scopeId: null,
      },
      async run(admittedSignal) {
        return {
          value: await executeNotices(target, services, request, admittedSignal),
          terminated: true,
        };
      },
    });
    payload =
      executed.kind === "completed"
        ? executed.value
        : { status: "failed", code: executed.receipt.state };
  } finally {
    task.close();
  }
  const effect =
    payload.status === "applied"
      ? "completed"
      : payload.status === "failed" && payload.code === "uncertain"
        ? "uncertain"
        : "none";
  const errors =
    payload.status === "failed"
      ? [
          adoptForeignError(
            {
              code: payload.code,
              category: "configuration",
              message:
                "Extension notices could not be produced or acknowledged. Inspect the result and retry with fresh evidence.",
            },
            { operation: "extension notices" },
          ),
        ]
      : [];
  return resultFor(
    "extension.notices",
    payload,
    errors.map((error) => ({ ...error, effect, recovery: recoveryForEffect(effect) })),
    payload.status === "failed" && payload.code === "uncertain"
      ? { kind: "uncertain", effect: "uncertain" }
      : abort.aborted
        ? { kind: "cancelled", effect: payload.status === "applied" ? "completed" : "none" }
        : undefined,
    { intent: request === undefined ? "none" : "mutate", observed: effect },
  );
}
