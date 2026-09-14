/** A copied projection never grants access after its original evidence loses authority. */
import type { ArtifactRecord } from "../artifacts/index.ts";
import { type ArtifactStorePort, artifactId } from "../artifacts/index.ts";
import { historyProjectionSchema } from "../compression/history-projection.ts";
import { MAX_STREAM_READ_LIMIT } from "../foundation/index.ts";
import type { RuntimeEvent } from "./event.ts";
import type { EventStorePort } from "./event-store.ts";
import { HISTORY_LIMITS, historyReferences } from "./history.ts";
import type { HistoryAvailability, HistoryReadItem } from "./history-read-result.ts";

export async function authorizeCheckpointProjection(
  event: RuntimeEvent,
  text: string,
  options: {
    readonly events: EventStorePort;
    readonly digest: (value: string | Uint8Array) => string;
    readonly artifacts?: Pick<ArtifactStorePort, "get">;
    readonly authorize: (event: RuntimeEvent, artifact: ArtifactRecord | null) => boolean;
    readonly resolve: (
      event: RuntimeEvent,
      remaining: number,
      signal: AbortSignal,
    ) => Promise<HistoryReadItem>;
  },
  signal: AbortSignal,
): Promise<HistoryAvailability | null> {
  if (
    event.kind !== "history.recorded" ||
    event.payload.type !== "checkpoint" ||
    !event.payload.publication
  )
    return null;
  let projection: ReturnType<typeof historyProjectionSchema.parse>;
  try {
    projection = historyProjectionSchema.parse(JSON.parse(text));
  } catch {
    return "corrupt";
  }
  const publication = event.payload.publication;
  if (
    projection.sessionId !== event.correlation.sessionId ||
    projection.streamId !== event.streamId ||
    projection.sourceHead !== publication.sourceHead ||
    projection.sourceDigest !== publication.sourceDigest ||
    projection.records.length !== publication.sourceRecords
  )
    return "corrupt";
  let remaining = HISTORY_LIMITS.contentBytes;
  if (publication.sourceHead > MAX_STREAM_READ_LIMIT) return "corrupt";
  const source: RuntimeEvent[] = [];
  let bytes = 0;
  while (source.length < publication.sourceHead) {
    const loaded = await options.events.readFrom(
      { streamId: event.streamId, afterSequence: source.at(-1)?.sequence ?? null },
      Math.min(HISTORY_LIMITS.page, publication.sourceHead - source.length),
      signal,
    );
    if (!loaded.ok || loaded.value.length === 0) return signal.aborted ? "cancelled" : "missing";
    for (const original of loaded.value) {
      if (Number(original.sequence) !== source.length + 1) return "corrupt";
      if (!options.authorize(original, null)) return "unauthorized";
      bytes += new TextEncoder().encode(JSON.stringify(original)).byteLength;
      if (bytes > HISTORY_LIMITS.contentBytes) return "corrupt";
      source.push(original);
    }
  }
  if (
    options.digest(
      JSON.stringify(
        source.filter(
          (original) =>
            original.kind !== "history.recorded" || original.payload.type !== "checkpoint",
        ),
      ),
    ) !== publication.sourceDigest ||
    JSON.stringify(projection.lifecycle) !==
      JSON.stringify(source.filter((original) => original.kind !== "history.recorded"))
  )
    return "corrupt";
  const originals: RuntimeEvent[] = [];
  for (const record of projection.records) {
    if (record.sequence > publication.sourceHead || record.payload.type === "restore-point")
      return "corrupt";
    const original = source[record.sequence - 1];
    if (!original || original.eventId !== record.eventId || original.kind !== "history.recorded")
      return "missing";
    if (!options.authorize(original, null)) return "unauthorized";
    if (JSON.stringify(original.payload) !== JSON.stringify(record.payload)) return "corrupt";
    originals.push(original);
    const resolved = await options.resolve(original, remaining, signal);
    if (resolved.availability !== "exact" && resolved.availability !== "redacted")
      return resolved.availability;
    if (resolved.text !== projection.contents[record.content]) return "corrupt";
    remaining -= new TextEncoder().encode(resolved.text ?? "").byteLength;
    for (const reference of original.payload.references ?? []) {
      const result = await options.resolve(
        { ...original, payload: { ...original.payload, evidence: reference, references: [] } },
        remaining,
        signal,
      );
      if (result.availability !== "exact" && result.availability !== "redacted")
        return result.availability;
      remaining -= new TextEncoder().encode(result.text ?? "").byteLength;
    }
  }
  // One source may be revoked while a later source is being read.
  for (const original of originals) {
    if (!options.authorize(original, null)) return "unauthorized";
    if (original.kind !== "history.recorded") return "corrupt";
    for (const reference of historyReferences(original.payload)) {
      const current = options.artifacts?.get(artifactId.from(reference.artifactId));
      if (!current?.ok || !current.value) return "missing";
      if (!options.authorize(original, current.value) || current.value.sensitivity === "restricted")
        return "unauthorized";
      if (current.value.availability !== "available") return "expired";
      if (
        String(current.value.digest) !== reference.digest ||
        current.value.byteLength !== reference.byteLength
      )
        return "corrupt";
    }
  }
  return signal.aborted ? "cancelled" : null;
}
