/**
 * Product Loom wiring into context packs and tool-result recovery (#719).
 *
 * Exposes a thin seam that (1) turns Loom projections into evidence for the
 * context planner and (2) attaches recovery handles on tool-result payloads
 * when a manifest id is known. Does not invent exact-source for redacted
 * projections.
 */

import type { EvidenceCandidate, LoomProjectionResult, Result } from "../domain/index.ts";
import type { LoomPort, LoomPortError, LoomRetrieveRequest } from "./loom.ts";
import { loomProjectionToEvidence } from "./loom.ts";

export const PRODUCT_LOOM_OWNER = "#719";

export type ProductLoomRecoveryHandle = {
  readonly owner: typeof PRODUCT_LOOM_OWNER;
  readonly manifestId: string;
  readonly artifactId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly via: "loom-manifest";
  readonly claimsExactSource: boolean;
  readonly projections: readonly ["range", "head-tail", "search-hits", "exact"];
};

export type ProductLoomContextPorts = {
  readonly loom: LoomPort;
};

export type ProductLoomContext = {
  readonly owner: typeof PRODUCT_LOOM_OWNER;
  retrieveEvidence(input: {
    readonly retrieve: LoomRetrieveRequest;
    readonly workspaceId?: string;
    readonly signal?: AbortSignal;
  }): Promise<Result<EvidenceCandidate, LoomPortError>>;
  recoveryHandle(manifestId: string, projection: LoomProjectionResult): ProductLoomRecoveryHandle;
  attachRecovery<T extends Record<string, unknown>>(
    payload: T,
    manifestId: string,
    projection: LoomProjectionResult,
  ): T & { readonly loomRecovery: ProductLoomRecoveryHandle };
};

/**
 * Compose product Loom helpers for live context packs and tool recovery.
 */
export function composeProductLoomContext(ports: ProductLoomContextPorts): ProductLoomContext {
  return {
    owner: PRODUCT_LOOM_OWNER,
    async retrieveEvidence(input) {
      const retrieved = await ports.loom.retrieve(input.retrieve, input.signal);
      if (!retrieved.ok) {
        return retrieved;
      }
      return loomProjectionToEvidence({
        projection: retrieved.value,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      });
    },
    recoveryHandle(manifestId, projection) {
      return {
        owner: PRODUCT_LOOM_OWNER,
        manifestId,
        artifactId: projection.handle.artifactId,
        digest: projection.handle.digest,
        byteLength: projection.handle.byteLength,
        via: "loom-manifest",
        claimsExactSource: projection.claimsExact,
        projections: ["range", "head-tail", "search-hits", "exact"],
      };
    },
    attachRecovery(payload, manifestId, projection) {
      return {
        ...payload,
        loomRecovery: this.recoveryHandle(manifestId, projection),
      };
    },
  };
}
