/** Exact selected artifact evidence; references never grant an execution capability. */
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/artifact.ts";
import { type AgentContextItem, MAX_AGENT_CONTEXT_BYTES } from "./agent-definition.ts";

export async function validateAgentArtifacts(
  store: ArtifactStorePort,
  context: readonly AgentContextItem[],
  signal: AbortSignal,
): Promise<boolean> {
  for (const item of context) {
    if (!item.artifact) continue;
    const id = artifactId.parse(item.artifact.artifactId);
    if (!id.ok) return false;
    const record = store.get(id.value);
    if (
      !record.ok ||
      !record.value ||
      record.value.availability !== "available" ||
      record.value.encoding !== "identity" ||
      record.value.sensitivity === "restricted" ||
      record.value.digest !== item.artifact.digest ||
      record.value.byteLength !== item.artifact.byteLength ||
      record.value.byteLength > MAX_AGENT_CONTEXT_BYTES
    )
      return false;
    const verified = await store.verifyIntegrity(id.value, signal);
    if (!verified.ok || !verified.value) return false;
    const read = await store.readRange(id.value, 0, item.artifact.byteLength, signal);
    if (
      !read.ok ||
      !read.value.endOfArtifact ||
      !Buffer.from(read.value.bytes).equals(Buffer.from(item.text))
    )
      return false;
  }
  return !signal.aborted;
}
