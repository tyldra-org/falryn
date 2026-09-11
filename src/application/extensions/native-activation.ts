import { z } from "zod";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { PackageReceipt, PackageRequest } from "../../domain/extensions/lifecycle.ts";
import {
  type NativeActivation,
  type NativeActivationStore,
  nativeActivationKey,
} from "../../domain/extensions/native-activation.ts";

export type NativeActivationCandidate = {
  record: Omit<NativeActivation, "revision">;
  inputs: string;
  scopeRevision: number;
};
/** Explicit preview and compare-and-write. A scope preference never calls this implicitly. */
export function createNativeActivation(options: {
  store: NativeActivationStore;
  capture(request: PackageRequest, signal: AbortSignal): Promise<NativeActivationCandidate>;
}) {
  return async (request: PackageRequest, signal: AbortSignal): Promise<PackageReceipt> => {
    const receipt: PackageReceipt = {
      action: "enable",
      operationId: request.operationId,
      packageId: request.packageId,
      status: "failed",
      code: "native-activation-required",
      priorRevision: request.expectedRevision,
      revision: request.expectedRevision,
      priorDigest: null,
      currentDigest: null,
      activation: "unavailable",
      confirmation: null,
      retainedVersions: 0,
      pendingCleanup: 0,
      recovery: "fresh-preview",
    };
    try {
      if (
        !request.nativeActivation ||
        request.sourcePath ||
        request.health ||
        request.nativeRecovery ||
        request.data ||
        request.dataCleanup ||
        request.versionDigest ||
        request.retention !== "retain"
      )
        throw new ExtensionInputError("invalid-native-activation-request");
      const { confirmation: _confirmation, ...intent } = request;
      const fingerprint = canonicalDigest(intent);
      const prior = options.store.operation(request.operationId);
      if (!prior.ok) throw new ExtensionInputError(prior.error.code);
      if (prior.value) {
        if (prior.value.fingerprint !== fingerprint)
          throw new ExtensionInputError("activation-operation-reused");
        return {
          ...receipt,
          status: "completed",
          code: "native-activation-recorded",
          // Replay reports the recorded mutation, never current execution authority.
          activation: "unavailable",
          dataEffect: "none",
          currentDigest: prior.value.record.package,
          recovery: "none",
          data: z.json().parse(prior.value),
        };
      }
      const candidate = await options.capture(request, signal);
      const key = nativeActivationKey(candidate.record);
      const current = options.store.get(key);
      if (!current.ok) throw new ExtensionInputError(current.error.code);
      if ((current.value?.revision ?? 0) !== request.nativeActivation.expectedRevision)
        throw new ExtensionInputError("stale-activation-revision");
      const confirmation = canonicalDigest({ fingerprint, candidate, current: current.value });
      if (!request.confirmation)
        return {
          ...receipt,
          status: "preview",
          code: "native-activation-confirmation-required",
          confirmation,
          currentDigest: candidate.record.package,
          data: z.json().parse({
            scope: candidate.record.authority.scope,
            contributions: candidate.record.contributions,
            priorActivationRevision: current.value?.revision ?? 0,
          }),
        };
      if (request.confirmation !== confirmation)
        throw new ExtensionInputError("stale-activation-confirmation");
      const next = await options.capture(request, signal);
      if (canonicalDigest(next) !== canonicalDigest(candidate))
        throw new ExtensionInputError("stale-activation-inputs");
      const saved = options.store.save(
        {
          operation: request.operationId,
          key,
          fingerprint,
          confirmation,
          priorRevision: current.value?.revision ?? 0,
          record: { ...candidate.record, revision: (current.value?.revision ?? 0) + 1 },
        },
        candidate.scopeRevision,
        signal,
      );
      if (!saved.ok) throw new ExtensionInputError(saved.error.code);
      return {
        ...receipt,
        status: "completed",
        code: "native-activation-recorded",
        activation: "enabled",
        currentDigest: candidate.record.package,
        recovery: "none",
        dataEffect: "completed",
        data: z.json().parse(saved.value),
      };
    } catch (error) {
      const code =
        error instanceof ExtensionInputError ? error.code : "native-activation-unavailable";
      return {
        ...receipt,
        code,
        status: code === "activation-store-uncertain" ? "uncertain" : "failed",
      };
    }
  };
}
