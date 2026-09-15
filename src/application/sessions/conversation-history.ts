/** One bounded, authorized committed snapshot for live model input and activation. */
import { randomUUID } from "node:crypto";
import {
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
} from "../../domain/artifacts/index.ts";
import { historyProjectionSchema } from "../../domain/compression/history-projection.ts";
import {
  deadlineAt,
  instant,
  MAX_STREAM_READ_LIMIT,
  type StreamId,
  sequence,
  type TurnId,
} from "../../domain/foundation/index.ts";
import { effectOf, NO_RETRY, workUnitId } from "../../domain/orchestration/index.ts";
import { HISTORY_LIMITS, historyReferences } from "../../domain/sessions/history.ts";
import { createHistoryReader } from "../../domain/sessions/history-reader.ts";
import type {
  EventStorePort,
  RuntimeEvent,
  SessionCorrelation,
} from "../../domain/sessions/index.ts";
import type { ModelMessage } from "../../providers/index.ts";
import {
  type ConversationRecord,
  projectConversationHistory,
} from "../context/conversation-projection.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { historyDigest } from "./session-history.ts";

export type { ConversationRecord } from "../context/conversation-projection.ts";
export type ConversationHistoryPorts = {
  readonly parents?: readonly {
    readonly sessionId: SessionCorrelation["sessionId"];
    readonly streamId: StreamId;
    readonly throughSequence: number;
  }[];
  readonly events: EventStorePort;
  readonly artifacts?: ArtifactStorePort;
  readonly streamId: StreamId;
  readonly correlation: SessionCorrelation;
  readonly authorize: (event: RuntimeEvent, artifact: ArtifactRecord | null) => boolean;
};
export type ConversationHistorySnapshot = {
  readonly version: "conversation-history.v1";
  readonly sessionId: string;
  readonly streamId: string;
  readonly throughSequence: number;
  readonly checkpointId: string | null;
  readonly projectionDigest: string;
  readonly records: readonly ConversationRecord[];
  readonly messages: readonly ModelMessage[];
  readonly omissions: readonly { readonly id: string; readonly reason: string }[];
  readonly pendingOperations: readonly string[];
  readonly eventBytes: number;
  readonly bytesRead: number;
  readonly artifactReads: number;
  /** Recheck mutable authority immediately before provider admission, without new effects. */
  readonly current: () => boolean;
};
export type ConversationHistoryOutcome =
  | { readonly ok: true; readonly value: ConversationHistorySnapshot }
  | { readonly ok: false; readonly code: string };
const fail = (code: string): ConversationHistoryOutcome => ({ ok: false, code });
class ArtifactReadLimit extends Error {}
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeSnapshot(item);
    Object.freeze(value);
  }
  return value;
}

export function createConversationHistoryReader(ports: ConversationHistoryPorts) {
  const authorize = (event: RuntimeEvent, artifact: ArtifactRecord | null) =>
    event.streamId === ports.streamId &&
    event.correlation.sessionId === ports.correlation.sessionId &&
    event.correlation.workspaceId === ports.correlation.workspaceId &&
    ports.authorize(event, artifact);
  async function read(
    input: { readonly currentTurnId: TurnId; readonly throughSequence?: number },
    signal: AbortSignal,
  ): Promise<ConversationHistoryOutcome> {
    const head = ports.events.head?.(ports.streamId);
    if (head && !head.ok) return fail(head.error.code);
    const boundary = input.throughSequence ?? (head?.ok ? Number(head.value ?? 0) : undefined);
    if (boundary !== undefined && (!Number.isSafeInteger(boundary) || boundary < 0))
      return fail("invalid-boundary");
    const events: RuntimeEvent[] = [];
    let eventBytes = 0;
    while (boundary === undefined || events.length < boundary) {
      if (signal.aborted) return fail("cancelled");
      const page = await ports.events.readFrom(
        { streamId: ports.streamId, afterSequence: events.at(-1)?.sequence ?? null },
        Math.min(
          HISTORY_LIMITS.page,
          boundary === undefined ? HISTORY_LIMITS.page : boundary - events.length,
        ),
        signal,
      );
      if (!page.ok) return fail(page.error.code);
      for (const event of page.value) {
        if (!authorize(event, null)) return fail("unauthorized");
        if (events.length >= MAX_STREAM_READ_LIMIT) return fail("event-limit");
        if (Number(event.sequence) !== events.length + 1) return fail("sequence-gap");
        eventBytes += Buffer.byteLength(JSON.stringify(event));
        if (eventBytes > HISTORY_LIMITS.contentBytes) return fail("event-byte-limit");
        events.push(structuredClone(event));
      }
      if (page.value.length < HISTORY_LIMITS.page) break;
    }
    if (boundary !== undefined && events.length !== boundary) return fail("stale-boundary");
    if (
      events.some(
        (event) =>
          "turnId" in event.correlation && event.correlation.turnId === input.currentTurnId,
      )
    )
      return fail("current-turn-already-recorded");
    const semantic = events.filter(
      (event): event is ConversationRecord["event"] =>
        event.kind === "history.recorded" &&
        event.payload.type !== "checkpoint" &&
        event.payload.type !== "restore-point",
    );
    // No old lifecycle-only session can masquerade as complete conversation coverage.
    if (
      events.some(
        (event) =>
          event.kind === "turn.started" &&
          !semantic.some(
            (item) =>
              item.correlation.turnId === event.correlation.turnId &&
              item.payload.type === "message" &&
              item.payload.role === "user",
          ),
      )
    )
      return fail("unrecorded-turn");
    let artifactReads = 0;
    const maximumArtifactReads = 128;
    const artifacts = ports.artifacts;
    const reader = createHistoryReader({
      events: ports.events,
      authorize,
      digest: historyDigest,
      maximumReadBytes: HISTORY_LIMITS.contentBytes,
      ...(artifacts
        ? {
            artifacts: {
              get: artifacts.get.bind(artifacts),
              async readRange(...args: Parameters<ArtifactStorePort["readRange"]>) {
                if (++artifactReads > maximumArtifactReads) throw new ArtifactReadLimit();
                return artifacts.readRange(...args);
              },
            },
          }
        : {}),
    });
    let bytesRead = 0;
    async function resolve(event: ConversationRecord["event"]) {
      const page = await reader.page(
        {
          streamId: ports.streamId,
          afterSequence:
            Number(event.sequence) === 1 ? null : sequence.from(Number(event.sequence) - 1),
          limit: 1,
          maxBytes: HISTORY_LIMITS.contentBytes - bytesRead,
        },
        signal,
      );
      if (!page.ok) return { ok: false as const, code: page.code };
      if (artifactReads > maximumArtifactReads)
        return { ok: false as const, code: "artifact-read-limit" };
      bytesRead += page.bytes;
      const item = page.items[0];
      if (
        !item ||
        item.event?.eventId !== event.eventId ||
        item.text === null ||
        (item.availability !== "exact" && item.availability !== "redacted")
      )
        return { ok: false as const, code: item?.availability ?? "missing" };
      if (
        item.references?.some(
          (reference) =>
            reference.availability !== "exact" && reference.availability !== "redacted",
        )
      )
        return { ok: false as const, code: "reference-unavailable" };
      return { ok: true as const, text: item.text };
    }
    const selected = events.findLast(
      (event): event is ConversationRecord["event"] =>
        event.kind === "history.recorded" &&
        event.payload.type === "checkpoint" &&
        event.payload.publication !== undefined &&
        event.payload.publication.stage !== "preview",
    );
    const projected = new Map<string, string>();
    let checkpointId: string | null = null;
    if (selected && selected.payload.type === "checkpoint") {
      const resolved = await resolve(selected);
      if (!resolved.ok) return fail(resolved.code);
      const parsed = historyProjectionSchema.safeParse(JSON.parse(resolved.text));
      if (!parsed.success) return fail("checkpoint-corrupt");
      if (
        historyDigest(JSON.stringify(parsed.data.authority)) !==
        selected.payload.publication?.authorityDigest
      )
        return fail("checkpoint-authority-mismatch");
      const original = semantic.filter((event) => Number(event.sequence) <= parsed.data.sourceHead);
      if (
        original.length !== parsed.data.records.length ||
        original.some((event, i) => event.eventId !== parsed.data.records[i]?.eventId)
      )
        return fail("checkpoint-coverage-gap");
      checkpointId = selected.payload.checkpointId;
      for (const record of parsed.data.records)
        projected.set(record.eventId, parsed.data.contents[record.content] ?? "");
    }
    const records: ConversationRecord[] = [];
    for (const event of semantic) {
      if (signal.aborted) return fail("cancelled");
      const prior = projected.get(event.eventId);
      const resolved =
        prior === undefined ? await resolve(event) : { ok: true as const, text: prior };
      if (!resolved.ok) return fail(resolved.code);
      records.push({ event, text: resolved.text });
    }
    const projection = projectConversationHistory(records, events);
    if (!projection.ok) return fail(projection.code);
    const current = () =>
      events.every((event) => authorize(event, null)) &&
      [...semantic, ...(selected ? [selected] : [])].every((event) =>
        historyReferences(event.payload).every((reference) => {
          const found = artifacts?.get(artifactId.from(reference.artifactId));
          return (
            found?.ok === true &&
            found.value !== null &&
            found.value.availability === "available" &&
            found.value.sensitivity !== "restricted" &&
            authorize(event, found.value) &&
            String(found.value.digest) === reference.digest &&
            found.value.byteLength === reference.byteLength
          );
        }),
      );
    if (!current()) return fail("authority-changed");
    const pending = new Set<string>();
    for (const event of events) {
      if (event.kind === "turn.started") pending.add(`turn:${event.correlation.turnId}`);
      if (event.kind === "turn.completed") {
        pending.delete(`turn:${event.correlation.turnId}`);
        if (effectOf(event.payload.outcome) === "uncertain")
          pending.add(`uncertain:${event.correlation.turnId}`);
      }
      if (event.kind === "capability.invocation.started") pending.add(`tool:${event.invocationId}`);
      if (event.kind === "capability.invocation.completed") {
        pending.delete(`tool:${event.invocationId}`);
        if (effectOf(event.payload.outcome) === "uncertain")
          pending.add(`uncertain:${event.invocationId}`);
      }
      if (
        event.kind === "model.attempt.completed" &&
        effectOf(event.payload.outcome) === "uncertain"
      )
        pending.add(`uncertain:${event.modelAttemptId}`);
    }
    return {
      ok: true,
      value: freezeSnapshot({
        version: "conversation-history.v1",
        sessionId: ports.correlation.sessionId,
        streamId: ports.streamId,
        throughSequence: events.length,
        checkpointId,
        projectionDigest: historyDigest(JSON.stringify(projection.messages)),
        messages: projection.messages,
        omissions: projection.omissions,
        records,
        pendingOperations: [...pending],
        eventBytes,
        bytesRead,
        artifactReads,
        current,
      }),
    };
  }
  return {
    async read(
      input: Parameters<typeof read>[0],
      resources: ProductTaskResources,
      signal = new AbortController().signal,
    ): Promise<ConversationHistoryOutcome> {
      if (ports.parents?.length) {
        if (ports.parents.length > 8) return fail("lineage-limit");
        const snapshots: ConversationHistorySnapshot[] = [];
        const { parents, ...localPorts } = ports;
        for (const parent of [...parents, null]) {
          const selected =
            parent === null
              ? localPorts
              : {
                  ...localPorts,
                  streamId: parent.streamId,
                  correlation: { ...ports.correlation, sessionId: parent.sessionId },
                };
          const part = await createConversationHistoryReader(selected).read(
            {
              currentTurnId: input.currentTurnId,
              ...(parent === null ? input : { throughSequence: parent.throughSequence }),
            },
            resources,
            signal,
          );
          if (!part.ok) return part;
          snapshots.push(part.value);
          if (
            snapshots.reduce((n, s) => n + s.throughSequence, 0) > MAX_STREAM_READ_LIMIT ||
            snapshots.reduce((n, s) => n + s.eventBytes, 0) > HISTORY_LIMITS.contentBytes ||
            snapshots.reduce((n, s) => n + s.bytesRead, 0) > HISTORY_LIMITS.contentBytes ||
            snapshots.reduce((n, s) => n + s.artifactReads, 0) > 128
          )
            return fail("lineage-limit");
        }
        const own = snapshots.at(-1);
        if (!own) return fail("missing-lineage");
        const messages = snapshots.flatMap((s) => s.messages);
        return {
          ok: true,
          value: freezeSnapshot({
            ...own,
            messages,
            records: snapshots.flatMap((s) => s.records),
            omissions: snapshots.flatMap((s) => s.omissions),
            pendingOperations: snapshots.flatMap((s) => s.pendingOperations),
            projectionDigest: historyDigest(JSON.stringify(messages)),
            checkpointId: snapshots.findLast((s) => s.checkpointId !== null)?.checkpointId ?? null,
            eventBytes: snapshots.reduce((n, s) => n + s.eventBytes, 0),
            bytesRead: snapshots.reduce((n, s) => n + s.bytesRead, 0),
            artifactReads: snapshots.reduce((n, s) => n + s.artifactReads, 0),
            current: () => snapshots.every((s) => s.current()),
          }),
        };
      }
      const operation = `conversation:${randomUUID()}`;
      const result = await resources.execute<ConversationHistoryOutcome>({
        target: {
          kind: "session-history",
          workspaceId: String(ports.correlation.workspaceId),
          configurationGeneration: String(ports.correlation.configurationGeneration),
        },
        operation,
        attempt: operation,
        generation: resources.generation,
        signal,
        inputBytes: 512,
        amounts: {
          operations: 1,
          bufferedBytes: 4 * HISTORY_LIMITS.contentBytes,
          bufferedItems: 2 * MAX_STREAM_READ_LIMIT,
        },
        unit: {
          id: workUnitId(operation),
          effect: "observation",
          priority: "interactive",
          conflictKeys: [],
          dependencies: [],
          retry: NO_RETRY,
          scopeId: null,
          deadline: deadlineAt(instant(Math.min(Date.now() + 30000, resources.expiresAt))),
          expectedOutputBytes: HISTORY_LIMITS.contentBytes,
        },
        async run(admittedSignal) {
          let value: ConversationHistoryOutcome;
          try {
            value = await read(input, admittedSignal);
          } catch (error) {
            value = fail(
              admittedSignal.aborted
                ? "cancelled"
                : error instanceof ArtifactReadLimit
                  ? "artifact-read-limit"
                  : "read-failed",
            );
          }
          return { value, terminated: true, observedEffect: "none" };
        },
      });
      return result.kind === "completed" ? result.value : fail(result.receipt.state);
    },
  };
}
