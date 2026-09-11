import { z } from "zod";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { PackageReceipt, PackageRequest } from "../../domain/extensions/lifecycle.ts";
import {
  PACKAGE_TOOL_PROTOCOL,
  type PackageHealthStore,
} from "../../domain/extensions/package-health.ts";
import type { PackageHealthHost } from "./package-health.ts";
import { projectPackageProcessResult } from "./package-process-projection.ts";

/** Recovery only settles a recorded process. It never repeats an invocation. */
export function createPackageToolRecovery(store: PackageHealthStore, execution: PackageHealthHost) {
  return async (request: PackageRequest, signal: AbortSignal): Promise<PackageReceipt> => {
    const receipt: PackageReceipt = {
      action: "recover",
      operationId: request.operationId,
      packageId: request.packageId,
      priorRevision: request.expectedRevision,
      revision: request.expectedRevision,
      priorDigest: null,
      currentDigest: null,
      activation: "unavailable",
      confirmation: null,
      retainedVersions: 0,
      pendingCleanup: 0,
      status: "failed",
      code: "native-recovery-unavailable",
      recovery: "inspect",
    };
    try {
      if (
        !request.nativeRecovery ||
        request.nativeActivation ||
        request.sourcePath ||
        request.health ||
        request.data ||
        request.dataCleanup ||
        request.versionDigest ||
        request.retention !== "retain"
      )
        throw new ExtensionInputError("invalid-native-recovery-request");
      const saved = store.get(request.nativeRecovery.operation);
      if (!saved.ok) throw new ExtensionInputError(saved.error.code);
      const prior = saved.value;
      if (
        !prior ||
        prior.packageId !== request.packageId ||
        prior.result.binding.protocol !== PACKAGE_TOOL_PROTOCOL
      )
        throw new ExtensionInputError("native-attempt-not-found");
      const confirmation = canonicalDigest({ recovery: prior });
      if (!request.confirmation && !(prior.result.terminated && prior.result.cleanup === "removed"))
        return {
          ...receipt,
          status: "preview",
          code: "native-recovery-confirmation-required",
          confirmation,
        };
      if (
        !(prior.result.terminated && prior.result.cleanup === "removed") &&
        request.confirmation &&
        request.confirmation !== confirmation
      )
        throw new ExtensionInputError("stale-native-recovery-confirmation");
      const complete = prior.result.terminated && prior.result.cleanup === "removed";
      const record = complete ? prior : await execution.recover(prior, signal);
      if (!complete) {
        const committed = store.save(record, prior.revision);
        if (!committed.ok)
          return {
            ...receipt,
            status: "uncertain",
            code: committed.error.code,
            recovery: "recover",
          };
      }
      const clean = record.result.terminated && record.result.cleanup === "removed";
      return {
        ...receipt,
        status: clean ? "completed" : "uncertain",
        code: clean ? "native-process-recovered" : record.result.code,
        dataEffect: complete ? "none" : "completed",
        recovery: clean ? "none" : "recover",
        data: z.json().parse({
          operation: record.operation,
          result: projectPackageProcessResult(record.result),
        }),
      };
    } catch (error) {
      return {
        ...receipt,
        code: error instanceof ExtensionInputError ? error.code : "native-recovery-unavailable",
      };
    }
  };
}
