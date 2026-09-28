/**
 * The memory-owned turn-end reflection worker (#882). It is an in-process derived-data
 * service: a settled turn or a session opening wakes it, it does bounded work through
 * the fenced reflection actions (#881) and becomes idle. There is no timer, polling
 * loop, shell, model call, delegated agent or general background-task runtime. Its
 * state never changes a committed turn result and never gates the next turn.
 */
import { type ClockPort, instant, sequence, streamId } from "../../domain/foundation/index.ts";
import {
  REFLECTION_LIMITS,
  type ReflectionBinding,
  type ReflectionFence,
  type ReflectionRange,
  type ReflectionResult,
} from "../../domain/memory/reflection.ts";
import type { ReflectionView } from "../../domain/memory/reflection-export.ts";
import { extractTurnEnd, TURN_END_TRANSFORM } from "../../domain/memory/reflection-extraction.ts";
import { reflectionDigest, reflectionLineage } from "../../domain/memory/reflection-state.ts";
import type { RuntimeEvent } from "../../domain/sessions/event.ts";
import type { EventStorePort } from "../../domain/sessions/event-store.ts";
import type { ReflectionMetadata, ReflectionResponse } from "./reflection-actions.ts";

export const REFLECTION_WORKER_LIMITS = Object.freeze({
  /** Requests processed per wake; more due work waits for the next event. */
  requestsPerWake: 8,
  leaseMs: 60_000,
  shutdownDrainMs: 2_000,
  receipts: 32,
  /** Events scanned forward at startup to find the last committed turn boundary. */
  startupScanEvents: REFLECTION_LIMITS.sourceEvents,
});

export type ReflectionReceipt = {
  readonly requestId: string | null;
  readonly range: ReflectionRange | null;
  readonly outcome:
    | "empty"
    | "completed"
    | "partial"
    | "unavailable"
    | "failed"
    | "cancelled"
    | "stale"
    | "uncertain";
  readonly candidates: number;
  readonly omittedCandidates: number;
  readonly unavailableMessages: number;
  readonly scannedEvents: number;
  readonly scannedBytes: number;
  /** A reflection error code; never source or candidate text. */
  readonly code: string | null;
};
export type ReflectionWorkerStatus = {
  readonly state: "idle" | "running" | "closed";
  readonly receipts: readonly ReflectionReceipt[];
};
export type ReflectionWorker = {
  /** A settled, committed turn through this stream sequence. Ignored once closed. */
  wake(input: { readonly throughSequence: number }): "accepted" | "closed";
  /** Bounded startup reconciliation for the bound session. */
  reconcile(): "accepted" | "closed";
  /** Resolves when the current bounded work, if any, has settled. */
  idle(): Promise<void>;
  status(): ReflectionWorkerStatus;
  /** Idempotent: stop wakes, cancel extraction, release uncommitted leases, bounded drain. */
  close(): Promise<void>;
};

export type ReflectionWorkerPorts = {
  readonly actions: {
    execute(json: string, signal?: AbortSignal): Promise<ReflectionResult<ReflectionResponse>>;
  };
  readonly events: Pick<EventStorePort, "readFrom">;
  readonly binding: () => ReflectionBinding | null;
  readonly clock: ClockPort;
  readonly process?: { readonly pid: number; readonly birth: string | null } | null;
};

type Job = { throughSequence: number | null; startup: boolean };

export function createReflectionWorker(ports: ReflectionWorkerPorts): ReflectionWorker {
  const stop = new AbortController();
  const receipts: ReflectionReceipt[] = [];
  let closed = false;
  let pending: Job | null = null;
  let running: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  const record = (receipt: ReflectionReceipt) => {
    receipts.push(receipt);
    if (receipts.length > REFLECTION_WORKER_LIMITS.receipts) receipts.shift();
  };
  const send = (command: unknown, signal: AbortSignal = stop.signal) =>
    ports.actions.execute(JSON.stringify(command), signal);
  const binding = ports.binding;

  async function list(): Promise<ReflectionMetadata[] | null> {
    const items: ReflectionMetadata[] = [];
    let after: string | null = null;
    const pages = Math.ceil(REFLECTION_LIMITS.requestsPerSession / REFLECTION_LIMITS.page);
    for (let page = 0; page < pages; page++) {
      const result = await send({ action: "reconcile", after, limit: REFLECTION_LIMITS.page });
      if (!result.ok || result.value.kind !== "page") return null;
      items.push(...result.value.items.filter((item) => item.transform === TURN_END_TRANSFORM));
      if (result.value.next === null) return items;
      after = result.value.next;
    }
    return items;
  }

  /** The last sequence already requested under the current lineage. */
  function requestedThrough(items: readonly ReflectionMetadata[], lineage: string): number {
    return Math.max(
      0,
      ...items
        .filter((item) => reflectionLineage(item.binding) === lineage)
        .map((item) => item.range.last),
    );
  }

  /** The last committed turn boundary after the requested range, bounded. */
  async function committedBoundary(bound: ReflectionBinding, after: number): Promise<number> {
    const read = await ports.events.readFrom(
      {
        streamId: streamId.from(bound.streamId),
        afterSequence: after === 0 ? null : sequence.from(after),
      },
      REFLECTION_WORKER_LIMITS.startupScanEvents,
      stop.signal,
    );
    if (!read.ok) return after;
    const terminal = read.value.filter((event) => event.kind === "turn.completed");
    return terminal.length === 0 ? after : Number(terminal.at(-1)?.sequence ?? after);
  }

  /** Create due requests covering exactly (requested, through], in bounded chunks. */
  async function createDue(through: number, items: readonly ReflectionMetadata[]) {
    const bound = binding();
    if (bound === null) return;
    let first = requestedThrough(items, reflectionLineage(bound)) + 1;
    let size: number = REFLECTION_LIMITS.sourceEvents;
    while (first <= through && !stop.signal.aborted) {
      const last = Math.min(through, first + size - 1);
      const created = await send({
        action: "create",
        binding: bound,
        transform: TURN_END_TRANSFORM,
        range: { first, last },
        reason: "turn-end",
      });
      if (created.ok) {
        first = last + 1;
        size = REFLECTION_LIMITS.sourceEvents;
        continue;
      }
      // A range too large in bytes is halved; one oversized event is left unrequested.
      if (created.error.code === "source-too-large" && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      record({
        requestId: null,
        range: { first, last },
        outcome: created.error.code === "source-overlap" ? "stale" : "unavailable",
        candidates: 0,
        omittedCandidates: 0,
        unavailableMessages: 0,
        scannedEvents: 0,
        scannedBytes: 0,
        code: created.error.code,
      });
      return;
    }
  }

  /** Release a lease without settling, so its due work stays for the next reconciliation. */
  async function release(id: string, fence: ReflectionFence) {
    const quiet = new AbortController();
    await send({ action: "heartbeat", id, fence, durationMs: 1 }, quiet.signal);
  }

  async function run(item: ReflectionMetadata): Promise<void> {
    const empty = {
      requestId: item.id,
      range: item.range,
      candidates: 0,
      omittedCandidates: 0,
      unavailableMessages: 0,
      scannedEvents: 0,
      scannedBytes: 0,
    };
    const leased = await send({
      action: "lease",
      id: item.id,
      durationMs: REFLECTION_WORKER_LIMITS.leaseMs,
      process: ports.process ?? null,
    });
    if (!leased.ok) {
      // Another owner holds it, or it just settled: nothing of ours to report.
      if (leased.error.code === "conflict") return;
      record({
        ...empty,
        outcome: leased.error.code === "cancelled" ? "cancelled" : "failed",
        code: leased.error.code,
      });
      return;
    }
    if (leased.value.kind === "stale") {
      record({ ...empty, outcome: "stale", code: "stale" });
      return;
    }
    if (leased.value.kind !== "record" || !leased.value.fence) return;
    const fence = leased.value.fence;
    const view: ReflectionView = leased.value.record;
    const settle = async (state: "failed" | "unavailable", code: string) => {
      await send(
        { action: "settle", id: item.id, fence, state, uncertainty: "none" },
        new AbortController().signal,
      );
      record({ ...empty, outcome: state, code });
    };
    // The committed events, checked source by source against the leased request.
    const read = await ports.events.readFrom(
      {
        streamId: streamId.from(view.binding.streamId),
        afterSequence: view.range.first === 1 ? null : sequence.from(view.range.first - 1),
      },
      view.range.last - view.range.first + 1,
      stop.signal,
    );
    if (stop.signal.aborted) {
      await release(item.id, fence);
      record({ ...empty, outcome: "cancelled", code: "cancelled" });
      return;
    }
    if (!read.ok) return settle("unavailable", "source-unavailable");
    const events: RuntimeEvent[] = [...read.value];
    if (
      events.length !== view.sources.length ||
      events.some(
        (event, index) =>
          String(event.eventId) !== view.sources[index]?.eventId ||
          reflectionDigest(event) !== view.sources[index]?.digest,
      )
    )
      return settle("failed", "source-changed");
    const extraction = extractTurnEnd(events, view.range);
    const receipt = {
      ...empty,
      omittedCandidates: extraction.omittedCandidates,
      unavailableMessages: extraction.unavailableMessages,
      scannedEvents: extraction.scannedEvents,
      scannedBytes: extraction.scannedBytes,
    };
    let state: ReflectionView["state"] = view.state;
    let candidates = 0;
    for (const segment of extraction.segments) {
      // Cancellation is checked before every commit; committed segments stay committed.
      if (stop.signal.aborted) {
        await release(item.id, fence);
        record({ ...receipt, candidates, outcome: "cancelled", code: "cancelled" });
        return;
      }
      const published = await send({
        action: "publish",
        id: item.id,
        fence,
        // Deterministic: a retry after an interrupted acknowledgement finds this publication.
        publicationId:
          "turn-end-" + reflectionDigest({ request: item.id, range: segment.range }).slice(8, 40),
        range: segment.range,
        disposition: segment.disposition,
        candidates: segment.candidates,
        prepared: null,
      });
      if (!published.ok) {
        const code = published.error.code;
        if (code === "uncertain") {
          // The candidate transaction may have committed; restart resolves it by identity.
          record({ ...receipt, candidates, outcome: "uncertain", code });
          return;
        }
        if (code === "cancelled") {
          await release(item.id, fence);
          record({ ...receipt, candidates, outcome: "cancelled", code });
          return;
        }
        if (code === "stale-lease" || code === "stale") {
          record({ ...receipt, candidates, outcome: "stale", code });
          return;
        }
        await send(
          { action: "settle", id: item.id, fence, state: "failed", uncertainty: "none" },
          new AbortController().signal,
        );
        record({ ...receipt, candidates, outcome: "failed", code });
        return;
      }
      if (published.value.kind === "stale") {
        record({ ...receipt, candidates, outcome: "stale", code: "stale" });
        return;
      }
      if (published.value.kind === "record") {
        state = published.value.record.state;
        candidates = published.value.record.candidates.length;
      }
    }
    record({
      ...receipt,
      candidates,
      outcome:
        state === "completed" || state === "empty" || state === "partial" || state === "unavailable"
          ? state
          : "partial",
      code: null,
    });
  }

  async function drain(): Promise<void> {
    while (pending !== null && !closed) {
      const job = pending;
      pending = null;
      const bound = binding();
      if (bound === null) continue;
      let items = await list();
      if (items === null) continue;
      const lineage = reflectionLineage(bound);
      const through =
        job.throughSequence ??
        (job.startup ? await committedBoundary(bound, requestedThrough(items, lineage)) : 0);
      if (through > requestedThrough(items, lineage)) {
        await createDue(through, items);
        items = (await list()) ?? items;
      }
      const now = Number(ports.clock.now());
      const due = items
        .filter(
          (item) =>
            reflectionLineage(item.binding) === lineage &&
            (item.state === "due" ||
              item.state === "partial" ||
              (item.state === "leased" && item.lease !== null && item.lease.expiresAt <= now)),
        )
        .sort((a, b) => a.range.first - b.range.first)
        .slice(0, REFLECTION_WORKER_LIMITS.requestsPerWake);
      for (const item of due) {
        if (closed || stop.signal.aborted) return;
        await run(item);
      }
    }
  }

  function schedule() {
    if (running !== null || pending === null || closed) return;
    running = drain()
      .catch(() => {
        record({
          requestId: null,
          range: null,
          outcome: "failed",
          candidates: 0,
          omittedCandidates: 0,
          unavailableMessages: 0,
          scannedEvents: 0,
          scannedBytes: 0,
          code: "worker-failed",
        });
      })
      .finally(() => {
        running = null;
        schedule();
      });
  }
  function enqueue(job: Job): "accepted" | "closed" {
    if (closed) return "closed";
    pending = {
      throughSequence: Math.max(pending?.throughSequence ?? 0, job.throughSequence ?? 0) || null,
      startup: (pending?.startup ?? false) || job.startup,
    };
    schedule();
    return "accepted";
  }

  return {
    wake: ({ throughSequence }) =>
      Number.isSafeInteger(throughSequence) && throughSequence > 0
        ? enqueue({ throughSequence, startup: false })
        : closed
          ? "closed"
          : "accepted",
    reconcile: () => enqueue({ throughSequence: null, startup: true }),
    async idle() {
      while (running !== null) await running;
    },
    status: () => ({
      state: closed ? "closed" : running === null ? "idle" : "running",
      receipts: [...receipts],
    }),
    close() {
      if (closing !== null) return closing;
      closed = true;
      pending = null;
      stop.abort();
      const active = running;
      closing = (async () => {
        if (active === null) return;
        const timer = new AbortController();
        await Promise.race([
          active,
          ports.clock.waitUntil(
            instant(Number(ports.clock.now()) + REFLECTION_WORKER_LIMITS.shutdownDrainMs),
            timer.signal,
          ),
        ]);
        timer.abort();
      })();
      return closing;
    },
  };
}
