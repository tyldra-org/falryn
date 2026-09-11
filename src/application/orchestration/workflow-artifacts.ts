import { createHash } from "node:crypto";
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/artifact.ts";
import { contentDigest } from "../../domain/artifacts/index.ts";
import { canonicalJson } from "../../domain/extensions/canonical.ts";
import { invocationId } from "../../domain/foundation/index.ts";
import type { ProcessTaskArtifact } from "../../domain/orchestration/process-task.ts";
import { WORKFLOW_LIMITS } from "../../domain/orchestration/workflow-definition.ts";
import type { WorkflowRecord } from "../../domain/orchestration/workflow-state.ts";

/** Exact results remain in the ordinary sensitive artifact store, never in a checkpoint event. */
export function createWorkflowArtifacts(artifacts: ArtifactStorePort) {
  return {
    async retain(
      record: WorkflowRecord,
      key: string,
      value: unknown,
    ): Promise<ProcessTaskArtifact> {
      const bytes = new TextEncoder().encode(canonicalJson(value));
      if (bytes.byteLength > WORKFLOW_LIMITS.valueBytes)
        throw new Error("workflow-result-byte-limit");
      const digest = contentDigest.from(
        `sha-256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
      const id = artifactId.from(
        `workflow-${createHash("sha256")
          .update(canonicalJson([record.handle, key, digest]))
          .digest("hex")}`,
      );
      const saved = await artifacts.ingest(
        {
          artifactId: id,
          mediaType: "application/json",
          encoding: "identity",
          sensitivity: "sensitive",
          origin: "capture",
          invocationId: invocationId.from(record.owner.invocationId),
          expectedDigest: digest,
          declaredByteLength: bytes.byteLength,
          content: (async function* () {
            yield bytes;
          })(),
        },
        AbortSignal.timeout(5000),
      );
      if (
        !saved.ok ||
        saved.value.record.availability !== "available" ||
        saved.value.record.digest !== digest ||
        saved.value.record.byteLength !== bytes.byteLength
      )
        throw new Error("workflow-result-unavailable");
      return { artifactId: id, digest, byteLength: bytes.byteLength };
    },
    async read(reference: ProcessTaskArtifact, signal: AbortSignal): Promise<unknown> {
      if (reference.byteLength > WORKFLOW_LIMITS.valueBytes)
        throw new Error("workflow-result-byte-limit");
      const id = artifactId.from(reference.artifactId);
      const found = artifacts.get(id);
      if (
        !found.ok ||
        !found.value ||
        found.value.availability !== "available" ||
        found.value.digest !== reference.digest ||
        found.value.byteLength !== reference.byteLength
      )
        throw new Error("workflow-result-unavailable");
      const verified = await artifacts.verifyIntegrity(id, signal);
      if (!verified.ok || !verified.value) throw new Error("workflow-result-corrupt");
      const read = await artifacts.readRange(id, 0, reference.byteLength, signal);
      if (!read.ok || read.value.bytes.byteLength !== reference.byteLength)
        throw new Error("workflow-result-incomplete");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.value.bytes));
    },
  };
}
export type WorkflowArtifacts = ReturnType<typeof createWorkflowArtifacts>;
