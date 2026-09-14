/** Bounded source reconstruction shared by preview, apply, and inspection. */
import type { ArtifactRecord, ArtifactStorePort } from "../../domain/artifacts/index.ts";
import { artifactId } from "../../domain/artifacts/index.ts";
import { MAX_HISTORY_ITEMS } from "../../domain/compression/history-checkpoint.ts";
import { MAX_STREAM_READ_LIMIT, type StreamId, sequence } from "../../domain/foundation/index.ts";
import { HISTORY_LIMITS, historyReferences } from "../../domain/sessions/history.ts";
import { createHistoryReader } from "../../domain/sessions/history-reader.ts";
import type { EventStorePort, RuntimeEvent } from "../../domain/sessions/index.ts";
import { historyDigest } from "../sessions/session-history.ts";

export type CheckpointSourcePorts = {
  readonly events: EventStorePort;
  readonly artifacts: ArtifactStorePort;
  readonly streamId: StreamId;
  readonly authorize: (event: RuntimeEvent, artifact: ArtifactRecord | null) => boolean;
};
export type SourceRecord = {
  readonly event: Extract<RuntimeEvent, { kind: "history.recorded" }>;
  readonly text: string;
};
export type CheckpointSource = {
  readonly events: readonly RuntimeEvent[];
  readonly records: readonly SourceRecord[];
  readonly head: number;
  readonly digest: string;
  readonly bytes: number;
};
export async function checkpointEvents(
  ports: CheckpointSourcePorts,
  signal: AbortSignal,
  through?: number,
): Promise<
  | { readonly ok: true; readonly value: readonly RuntimeEvent[] }
  | { readonly ok: false; readonly reason: string }
> {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const events: RuntimeEvent[] = [];
  let eventBytes = 0;
  for (;;) {
    const loaded = await ports.events.readFrom(
      { streamId: ports.streamId, afterSequence: events.at(-1)?.sequence ?? null },
      HISTORY_LIMITS.page,
      signal,
    );
    if (!loaded.ok) return fail(loaded.error.code);
    for (const event of loaded.value) {
      if (through !== undefined && Number(event.sequence) > through) break;
      if (events.length >= MAX_STREAM_READ_LIMIT) return fail("source-event-limit");
      if (Number(event.sequence) !== events.length + 1) return fail("source-sequence-gap");
      eventBytes += Buffer.byteLength(JSON.stringify(event));
      if (eventBytes > HISTORY_LIMITS.contentBytes) return fail("source-event-byte-limit");
      events.push(event);
    }
    if (
      loaded.value.length < HISTORY_LIMITS.page ||
      (through !== undefined && Number(events.at(-1)?.sequence) >= through)
    )
      break;
  }
  const head = events.at(-1)?.sequence;
  if (!head) return fail("empty-history");
  if (through !== undefined && Number(head) !== through) return fail("source-missing");
  if (events.some((event) => !ports.authorize(event, null))) return fail("unauthorized");
  return { ok: true, value: events };
}

export async function checkpointSource(
  ports: CheckpointSourcePorts,
  signal: AbortSignal,
  through?: number,
): Promise<
  | { readonly ok: true; readonly value: CheckpointSource }
  | { readonly ok: false; readonly reason: string }
> {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const loaded = await checkpointEvents(ports, signal, through);
  if (!loaded.ok) return loaded;
  const events = loaded.value;
  const head = events.at(-1)?.sequence;
  const active = new Set<string>();
  for (const event of events) {
    if (event.kind === "turn.started") active.add(`turn:${event.correlation.turnId}`);
    if (event.kind === "turn.completed") active.delete(`turn:${event.correlation.turnId}`);
    if (event.kind === "model.attempt.started") active.add(`model:${event.modelAttemptId}`);
    if (event.kind === "model.attempt.completed") active.delete(`model:${event.modelAttemptId}`);
    if (event.kind === "capability.invocation.started") active.add(`tool:${event.invocationId}`);
    if (event.kind === "capability.invocation.completed")
      active.delete(`tool:${event.invocationId}`);
  }
  if (active.size) return fail("busy");
  const reader = createHistoryReader({
    ...ports,
    digest: historyDigest,
    maximumReadBytes: HISTORY_LIMITS.contentBytes,
  });
  const records: SourceRecord[] = [];
  let bytes = 0;
  for (const event of events) {
    if (
      event.kind !== "history.recorded" ||
      event.payload.type === "checkpoint" ||
      event.payload.type === "restore-point"
    )
      continue;
    if (records.length >= MAX_HISTORY_ITEMS) return fail("source-item-limit");
    const page = await reader.page(
      {
        streamId: ports.streamId,
        afterSequence:
          Number(event.sequence) === 1 ? null : sequence.from(Number(event.sequence) - 1),
        limit: 1,
        maxBytes: HISTORY_LIMITS.contentBytes - bytes,
      },
      signal,
    );
    if (!page.ok) return fail(page.code);
    const item = page.items[0];
    if (
      !item ||
      item.event?.eventId !== event.eventId ||
      (item.availability !== "exact" && item.availability !== "redacted") ||
      item.text === null
    )
      return fail(item?.availability ?? "missing");
    bytes += page.bytes;
    records.push({ event, text: item.text });
  }
  if (!records.length) return fail("empty-history");
  return {
    ok: true,
    value: {
      events,
      records,
      head: Number(head),
      bytes,
      digest: historyDigest(
        JSON.stringify(
          events.filter(
            (event) => event.kind !== "history.recorded" || event.payload.type !== "checkpoint",
          ),
        ),
      ),
    },
  };
}

/** Synchronous last check before the event store's transaction; no derived authority. */
export function checkpointSourcesCurrent(
  ports: CheckpointSourcePorts,
  source: CheckpointSource,
): boolean {
  return (
    source.events.every((event) => ports.authorize(event, null)) &&
    source.records.every(({ event }) =>
      historyReferences(event.payload).every((reference) => {
        const record = ports.artifacts.get(artifactId.from(reference.artifactId));
        return (
          record.ok &&
          record.value !== null &&
          ports.authorize(event, record.value) &&
          record.value.sensitivity !== "restricted" &&
          record.value.availability === "available" &&
          String(record.value.digest) === reference.digest &&
          record.value.byteLength === reference.byteLength
        );
      }),
    )
  );
}
