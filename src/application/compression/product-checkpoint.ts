/** Admitted manual checkpoint producer. It never calls a provider or dispatches a tool. */
import { randomUUID } from "node:crypto";
import { artifactId, contentDigest } from "../../domain/artifacts/index.ts";
import {
  type CheckpointAuthority,
  checkpointAuthoritySchema,
  checkpointBudget,
  HISTORY_PROJECTION_VERSION,
  type HistoryProjection,
  historyProjectionSchema,
} from "../../domain/compression/history-projection.ts";
import { type ClockPort, deadlineAt, instant, sequence } from "../../domain/foundation/index.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/index.ts";
import {
  HISTORY_LIMITS,
  type HistoryPayload,
  historyReferences,
} from "../../domain/sessions/history.ts";
import { createHistoryReader } from "../../domain/sessions/history-reader.ts";
import type { RuntimeEvent, SessionCorrelation } from "../../domain/sessions/index.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import type { TurnEventJournal } from "../runtime/turn-event-journal.ts";
import { historyDigest } from "../sessions/session-history.ts";
import {
  type CheckpointSource,
  type CheckpointSourcePorts,
  checkpointEvents,
  checkpointSource,
  checkpointSourcesCurrent,
} from "./checkpoint-source.ts";

export type CheckpointRequest =
  | { readonly action: "preview" }
  | { readonly action: "apply" | "inspect" | "restore"; readonly candidateId: string };
export type CheckpointOutcome =
  | { readonly kind: "refused"; readonly reason: string; readonly effect: "none" | "uncertain" }
  | {
      readonly kind: "preview" | "applied" | "selected" | "inspected";
      readonly candidateId: string;
      readonly checkpointId: string;
      readonly eventId: string;
      readonly expiresAt: number;
      readonly beforeBytes: number;
      readonly afterBytes: number;
      readonly budget: ReturnType<typeof checkpointBudget>;
      readonly projection: HistoryProjection;
      readonly effect: "none" | "completed";
      readonly duplicate: boolean;
    };
type CheckpointEvent = Extract<RuntimeEvent, { kind: "history.recorded" }> & {
  readonly payload: Extract<HistoryPayload, { type: "checkpoint" }>;
};
function checkpoints(events: readonly RuntimeEvent[]): CheckpointEvent[] {
  return events.filter(
    (event): event is CheckpointEvent =>
      event.kind === "history.recorded" &&
      event.payload.type === "checkpoint" &&
      event.payload.publication?.version === 1,
  );
}
const CHECKPOINT_DEADLINE_MS = 30_000;
const refused = (reason: string, effect: "none" | "uncertain" = "none"): CheckpointOutcome => ({
  kind: "refused",
  reason,
  effect,
});
export function createProductCheckpointAction(
  ports: CheckpointSourcePorts & {
    readonly correlation: SessionCorrelation;
    readonly journal: Pick<TurnEventJournal, "compareAndPersist">;
    readonly clock: ClockPort;
    /** Returns null when the current route, complete request reservation or durability is unknown. */
    readonly authority: () => CheckpointAuthority | null;
    readonly settled: () => boolean;
    readonly durable: boolean;
  },
) {
  let running = false;
  let publicationAttempted = false;
  let lastPublication: CheckpointOutcome | null = null;
  const fingerprint = () => {
    const parsed = checkpointAuthoritySchema.safeParse(ports.authority());
    return parsed.success ? historyDigest(JSON.stringify(parsed.data)) : null;
  };
  async function execute(
    request: CheckpointRequest,
    resources: ProductTaskResources,
    signal: AbortSignal,
  ): Promise<CheckpointOutcome> {
    const inventory = await checkpointEvents(ports, signal);
    if (!inventory.ok) return refused(inventory.reason);
    const history = checkpoints(inventory.value);
    if (request.action === "inspect" || request.action === "apply") {
      const receipt = history.findLast(
        (event) =>
          event.payload.publication?.candidateId === request.candidateId &&
          (request.action === "inspect" || event.payload.publication.stage === "applied"),
      );
      if (receipt)
        return inspect(
          receipt,
          null,
          signal,
          request.action === "inspect" ? "inspected" : "applied",
          request.action === "apply",
        );
      if (request.action === "inspect") return refused("candidate-missing");
    }
    const loaded = await checkpointSource(ports, signal);
    if (!loaded.ok) return refused(loaded.reason);
    const source = loaded.value;
    const authority = checkpointAuthoritySchema.safeParse(ports.authority());
    if (!authority.success) return refused("admission-unavailable");
    const authorityDigest = historyDigest(JSON.stringify(authority.data));
    if (request.action === "preview") {
      const previous = history.at(-1);
      if (
        previous?.payload.publication &&
        previous.payload.publication.stage !== "preview" &&
        previous.payload.publication.sourceDigest === source.digest &&
        previous.payload.publication.authorityDigest === authorityDigest &&
        Number(previous.sequence) === source.head
      )
        return inspect(previous, source, signal, previous.payload.publication.stage, true);
      if (
        previous?.payload.publication?.stage === "preview" &&
        previous.payload.publication.expiresAt > ports.clock.now() &&
        previous.payload.publication.sourceDigest === source.digest &&
        previous.payload.publication.authorityDigest === authorityDigest &&
        Number(previous.sequence) === source.head
      )
        return inspect(previous, source, signal, "preview", true);
      const parent = history.findLast((event) => event.payload.publication?.stage !== "preview");
      const contents: string[] = [];
      const indexes = new Map<string, number>();
      const records = source.records.map(({ event, text }) => {
        let content = indexes.get(text);
        if (content === undefined) {
          content = contents.length;
          indexes.set(text, content);
          contents.push(text);
        }
        return {
          eventId: String(event.eventId),
          sequence: Number(event.sequence),
          payload: event.payload,
          content,
        };
      });
      const fidelities = records
        .flatMap((record) => [record.payload.evidence, ...(record.payload.references ?? [])])
        .map((reference) => reference.fidelity);
      const fidelity = fidelities.includes("partial")
        ? "partial"
        : fidelities.includes("redacted")
          ? "redacted"
          : "exact";
      const projection = historyProjectionSchema.parse({
        version: HISTORY_PROJECTION_VERSION,
        sessionId: ports.correlation.sessionId,
        streamId: ports.streamId,
        sourceHead: source.head,
        sourceDigest: source.digest,
        authority: authority.data,
        parentCheckpointId: parent?.payload.checkpointId ?? null,
        lifecycle: source.events.filter((event) => event.kind !== "history.recorded"),
        records,
        contents,
        omitted: [],
        fidelity,
        recovery: "original-events-under-existing-retention",
        memory: "deterministic-no-memory-authority",
      });
      const bytes = new TextEncoder().encode(JSON.stringify(projection));
      const references = [
        ...new Map(
          source.records
            .flatMap(({ event }) => historyReferences(event.payload))
            .map((reference) => [reference.artifactId, reference]),
        ).values(),
      ];
      if (references.length > HISTORY_LIMITS.relations) return refused("source-reference-limit");
      if (
        bytes.length + references.reduce((sum, reference) => sum + reference.byteLength, 0) >
        HISTORY_LIMITS.contentBytes
      )
        return refused("recovery-byte-limit");
      if (bytes.length > HISTORY_LIMITS.contentBytes) return refused("projection-byte-limit");
      if (!checkpointBudget(authority.data, bytes.length).fits)
        return refused("insufficient-budget");
      const candidateId = randomUUID();
      const digest = historyDigest(bytes);
      const id = artifactId.from(`checkpoint-${candidateId}`);
      const expiresAt = Math.min(
        Number(ports.clock.now()) + CHECKPOINT_DEADLINE_MS,
        resources.expiresAt,
      );
      const staged = await ports.artifacts.ingest(
        {
          artifactId: id,
          mediaType: "application/json",
          encoding: "identity",
          sensitivity: "user-content",
          origin: "tool-output",
          invocationId: null,
          declaredByteLength: bytes.length,
          expectedDigest: contentDigest.from(digest),
          content: (async function* () {
            yield bytes;
          })(),
        },
        signal,
      );
      if (!staged.ok) return refused(`projection-storage-${staged.error.code}`);
      const last = source.records.at(-1)?.event;
      if (!last) return refused("empty-history");
      const payload: CheckpointEvent["payload"] = {
        version: 1,
        type: "checkpoint",
        id: `compact-preview:${candidateId}`,
        generation: authority.data.configurationGeneration,
        checkpointId: candidateId,
        parentCheckpointId: projection.parentCheckpointId,
        transform: HISTORY_PROJECTION_VERSION,
        firstSequence: records[0]?.sequence ?? 1,
        lastSequence: source.head,
        covered: records.slice(0, HISTORY_LIMITS.relations).map((record) => record.payload.id),
        omitted: [],
        references,
        publication: {
          version: 1,
          stage: "preview",
          candidateId,
          sourceHead: source.head,
          sourceDigest: source.digest,
          authorityDigest,
          sourceRecords: records.length,
          coverage: "projection-records",
          expiresAt,
        },
        evidence: {
          availability: "retained",
          artifactId: String(id),
          digest,
          byteLength: bytes.length,
          sensitivity: "user-content",
          fidelity,
          mediaType: "application/json",
        },
      };
      return publish(
        payload,
        source,
        signal,
        "preview",
        () => fingerprint() === authorityDigest && Number(ports.clock.now()) < expiresAt,
        {
          kind: "preview",
          candidateId,
          checkpointId: candidateId,
          eventId: "",
          expiresAt,
          beforeBytes: source.bytes,
          afterBytes: bytes.length,
          budget: checkpointBudget(authority.data, bytes.length),
          projection,
          effect: "none",
          duplicate: false,
        },
      );
    }
    const event = history.findLast(
      (event) => event.payload.publication?.candidateId === request.candidateId,
    );
    if (!event) return refused("candidate-missing");
    const publication = event.payload.publication;
    if (!publication) return refused("candidate-corrupt");
    if (
      request.action === "apply" &&
      (publication.stage !== "preview" ||
        publication.expiresAt <= ports.clock.now() ||
        publication.sourceDigest !== source.digest ||
        publication.authorityDigest !== authorityDigest ||
        Number(event.sequence) !== source.head)
    )
      return refused("stale-preview");
    if (request.action === "restore" && publication.stage === "preview")
      return refused("checkpoint-not-applied");
    const checked = await inspect(event, source, signal, "inspected", false);
    if (checked.kind === "refused") return checked;
    if (!checkpointBudget(authority.data, checked.afterBytes).fits)
      return refused("insufficient-budget");
    const stage = request.action === "apply" ? "applied" : "selected";
    const payload: CheckpointEvent["payload"] = {
      ...event.payload,
      id:
        stage === "applied"
          ? `compact-apply:${publication.candidateId}`
          : `compact-select:${randomUUID()}`,
      publication: { ...publication, stage },
    };
    return publish(
      payload,
      source,
      signal,
      stage,
      () =>
        fingerprint() === authorityDigest &&
        (stage === "selected" || Number(ports.clock.now()) < publication.expiresAt),
      checked,
    );
  }

  async function inspect(
    event: CheckpointEvent,
    latest: CheckpointSource | null,
    signal: AbortSignal,
    kind: Exclude<CheckpointOutcome["kind"], "refused">,
    duplicate: boolean,
  ): Promise<CheckpointOutcome> {
    const publication = event.payload.publication;
    if (!publication) return refused("candidate-corrupt");
    const read = await createHistoryReader({
      ...ports,
      digest: historyDigest,
      maximumReadBytes: HISTORY_LIMITS.contentBytes,
    }).page(
      {
        streamId: ports.streamId,
        afterSequence: sequence.from(Number(event.sequence) - 1),
        limit: 1,
        maxBytes: HISTORY_LIMITS.contentBytes,
      },
      signal,
    );
    if (!read.ok) return refused(read.code);
    const item = read.items[0];
    if (
      !item ||
      item.event?.eventId !== event.eventId ||
      (item.availability !== "exact" && item.availability !== "redacted") ||
      item.text === null
    )
      return refused(item?.availability ?? "missing");
    let projection: HistoryProjection;
    try {
      projection = historyProjectionSchema.parse(JSON.parse(item.text));
    } catch {
      return refused("projection-corrupt");
    }
    const original = await checkpointSource(ports, signal, publication.sourceHead);
    if (!original.ok) return refused(original.reason);
    if (
      original.value.digest !== publication.sourceDigest ||
      projection.sourceDigest !== publication.sourceDigest ||
      projection.sourceHead !== publication.sourceHead ||
      projection.records.length !== publication.sourceRecords ||
      JSON.stringify(projection.lifecycle) !==
        JSON.stringify(
          original.value.events.filter((event) => event.kind !== "history.recorded"),
        ) ||
      projection.sessionId !== ports.correlation.sessionId ||
      projection.streamId !== ports.streamId ||
      historyDigest(JSON.stringify(projection.authority)) !== publication.authorityDigest ||
      projection.records.length !== original.value.records.length ||
      projection.records.some((record, index) => {
        const originalRecord = original.value.records[index];
        return (
          !originalRecord ||
          record.eventId !== originalRecord.event.eventId ||
          record.sequence !== Number(originalRecord.event.sequence) ||
          JSON.stringify(record.payload) !== JSON.stringify(originalRecord.event.payload) ||
          projection.contents[record.content] !== originalRecord.text
        );
      }) ||
      !checkpointSourcesCurrent(ports, original.value) ||
      (latest !== null && !checkpointSourcesCurrent(ports, latest))
    )
      return refused("source-changed");
    return {
      kind,
      candidateId: publication.candidateId,
      checkpointId: event.payload.checkpointId,
      eventId: event.eventId,
      expiresAt: publication.expiresAt,
      beforeBytes: original.value.bytes,
      afterBytes: new TextEncoder().encode(item.text).byteLength,
      budget: checkpointBudget(
        projection.authority,
        new TextEncoder().encode(item.text).byteLength,
      ),
      projection,
      effect: kind === "applied" || kind === "selected" ? "completed" : "none",
      duplicate,
    };
  }
  async function publish(
    payload: CheckpointEvent["payload"],
    source: CheckpointSource,
    signal: AbortSignal,
    kind: "preview" | "applied" | "selected",
    current: () => boolean,
    proof: Exclude<CheckpointOutcome, { kind: "refused" }>,
  ): Promise<CheckpointOutcome> {
    const turn = source.records.at(-1)?.event.correlation.turnId;
    if (!turn) return refused("empty-history");
    const reference = payload.evidence;
    const projectionCurrent = () => {
      if (reference.availability !== "retained") return false;
      const found = ports.artifacts.get(artifactId.from(reference.artifactId));
      const last = source.records.at(-1)?.event;
      return (
        found.ok &&
        found.value !== null &&
        last !== undefined &&
        found.value.availability === "available" &&
        String(found.value.digest) === reference.digest &&
        found.value.byteLength === reference.byteLength &&
        found.value.sensitivity !== "restricted" &&
        ports.authorize({ ...last, payload }, found.value)
      );
    };
    publicationAttempted = true;
    const result = await ports.journal.compareAndPersist(
      { kind: "history.recorded", correlation: { ...ports.correlation, turnId: turn }, payload },
      sequence.from(source.head),
      () =>
        ports.settled() &&
        current() &&
        checkpointSourcesCurrent(ports, source) &&
        projectionCurrent(),
      signal,
    );
    if (result.kind !== "persisted")
      return refused(
        result.kind === "store-error" ? result.error.code : result.kind,
        result.kind === "store-error" && result.error.code === "storage" ? "uncertain" : "none",
      );
    const event = checkpoints(result.events)[0];
    if (!event) return refused("publication-uncertain", "uncertain");
    // No asynchronous work after commit: cancellation cannot erase an observed receipt.
    lastPublication = {
      ...proof,
      kind,
      eventId: event.eventId,
      effect: "completed",
      duplicate: result.receipts[0]?.kind === "duplicate",
    };
    return lastPublication;
  }
  return {
    async run(
      request: CheckpointRequest,
      resources: ProductTaskResources,
      signal = new AbortController().signal,
    ): Promise<CheckpointOutcome> {
      if (!ports.durable) return refused("ephemeral-session");
      if (running || !ports.settled()) return refused("busy");
      running = true;
      publicationAttempted = false;
      lastPublication = null;
      let started = false;
      let finished = false;
      const operation = `compact:${randomUUID()}`;
      try {
        const executed = await resources.execute<CheckpointOutcome>({
          operation,
          attempt: operation,
          generation: resources.generation,
          signal,
          inputBytes: Buffer.byteLength(JSON.stringify(request)),
          amounts: { operations: 1, bufferedBytes: 16 * 1024 * 1024, bufferedItems: 1100 },
          unit: {
            id: workUnitId(operation),
            effect: request.action === "inspect" ? "observation" : "mutation",
            priority: "interactive",
            conflictKeys: [conflictKey("session-history", ports.correlation.sessionId)],
            dependencies: [],
            deadline: deadlineAt(
              instant(
                Math.min(Number(ports.clock.now()) + CHECKPOINT_DEADLINE_MS, resources.expiresAt),
              ),
            ),
            expectedOutputBytes: HISTORY_LIMITS.contentBytes,
            retry: NO_RETRY,
            scopeId: null,
          },
          async run(admittedSignal, publishReceipt) {
            started = true;
            try {
              const value = await execute(request, resources, admittedSignal);
              if (lastPublication !== null) publishReceipt(lastPublication);
              return { value, terminated: true, observedEffect: value.effect };
            } finally {
              finished = true;
              running = false;
            }
          },
        });
        return executed.kind === "completed"
          ? executed.value
          : (lastPublication ??
              refused(executed.receipt.state, publicationAttempted ? "uncertain" : "none"));
      } finally {
        if (!started || finished) running = false;
      }
    },
  };
}
