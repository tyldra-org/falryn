/**
 * Compose one session's turn-end reflection worker (#882) over the durable product store.
 * The binding and authority come from trusted composition only: the session's own stream,
 * deterministic candidates and no artifacts or prepared projections. Opening a session
 * runs bounded startup reconciliation; closing it stops the worker and its resources.
 */

import {
  createReflectionWorker,
  type ReflectionWorker,
} from "../../application/memory/reflection-worker.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import type { ClockPort } from "../../domain/foundation/index.ts";
import type { ReflectionAuthority, ReflectionBinding } from "../../domain/memory/reflection.ts";
import type { EventStorePort } from "../../domain/sessions/event-store.ts";
import type { ProductArtifactSession } from "./product-artifact-session.ts";

export const REFLECTION_POLICY_GENERATION = "turn-end-deterministic-policy-v1";

/** The one product binding for a session's reflection; every reader and writer uses it. */
export function sessionReflectionBinding(input: {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly configurationGeneration: number;
}): ReflectionBinding {
  return {
    ...input,
    repository: null,
    branch: null,
    worktree: null,
    sourceGeneration: "committed-history-v1",
    policyGeneration: REFLECTION_POLICY_GENERATION,
    authorizationGeneration: "local-user-v1",
  };
}

export function composeSessionReflection(options: {
  readonly store: Pick<ProductArtifactSession, "openReflection"> & {
    readonly eventStore: Pick<EventStorePort, "readFrom">;
  };
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly configurationGeneration: () => number;
  readonly clock: ClockPort;
}): ReflectionWorker {
  const binding = (): ReflectionBinding =>
    sessionReflectionBinding({
      sessionId: options.sessionId,
      workspaceId: options.workspaceId,
      streamId: options.streamId,
      configurationGeneration: options.configurationGeneration(),
    });
  const authority: ReflectionAuthority = {
    current: binding,
    sourceAllowed: () => true,
    artifactAllowed: () => false,
    preparedAllowed: () => false,
    candidateAllowed: (candidate) =>
      candidate.method === "deterministic" && candidate.sensitivity !== "restricted",
  };
  const resources = processProductResources.openTask("reflection-worker");
  const worker = createReflectionWorker({
    actions: options.store.openReflection(authority, resources),
    events: options.store.eventStore,
    binding,
    clock: options.clock,
    process: { pid: process.pid, birth: null },
  });
  worker.reconcile();
  return {
    ...worker,
    async close() {
      await worker.close();
      resources.close();
    },
  };
}
