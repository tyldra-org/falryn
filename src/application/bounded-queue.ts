/**
 * A queue that cannot grow without bound.
 *
 * Every enqueue resolves to one of the declared outcomes. There is no path that
 * silently drops an item and reports success, and no path that grows memory
 * because the consumer is slow.
 *
 * The resolution order is fixed: expire what is too old, then try to fit, then
 * apply the overflow policy. Coalescing is attempted only against items that
 * declared themselves display-only — a semantic fact is never merged away, even
 * under a coalescing policy, and the queue falls through to reject instead.
 */

import {
  type ArtifactSpillPort,
  type ClockPort,
  type EnqueueOutcome,
  elapsedBetween,
  type Instant,
  type LimitKind,
  type QueueItem,
  type QueueItemId,
  type QueueLimits,
  type QueueReport,
} from "../domain/index.ts";

export type EnqueueRequest<Payload> = {
  readonly id: QueueItemId;
  readonly byteLength: number;
  readonly coalescable: boolean;
  readonly mergeKey: string | null;
  readonly payload: Payload;
};

export type BoundedQueue<Payload> = {
  /**
   * Offers an item.
   *
   * Under a `wait` policy this resolves once there is room or `signal` aborts;
   * under every other policy it resolves immediately.
   */
  enqueue(request: EnqueueRequest<Payload>, signal?: AbortSignal): Promise<EnqueueOutcome<Payload>>;

  /** Takes the oldest item, expiring anything past the age limit first. */
  dequeue(): QueueItem<Payload> | null;
  peek(): QueueItem<Payload> | null;
  size(): number;
  byteLength(): number;
  report(): QueueReport;
  /** Fails every waiting producer. Used when the queue's owner is shutting down. */
  drain(): void;
};

export type BoundedQueueOptions = {
  readonly clock: ClockPort;
  readonly limits: QueueLimits;
  /** Required for a `spill` policy; without it the queue rejects instead. */
  readonly spill?: ArtifactSpillPort;
};

type Waiter = { readonly release: () => void };

export function createBoundedQueue<Payload>(options: BoundedQueueOptions): BoundedQueue<Payload> {
  const { clock, limits, spill } = options;
  const items: QueueItem<Payload>[] = [];
  let waiters: Waiter[] = [];
  let bytes = 0;

  const counters = { accepted: 0, coalesced: 0, spilled: 0, rejected: 0, expired: 0 };

  /** Drops items past the age limit. Counted, never silent. */
  const expire = (now: Instant): void => {
    while (items.length > 0) {
      const oldest = items[0];
      if (oldest === undefined) {
        break;
      }
      if (elapsedBetween(oldest.enqueuedAt, now) <= limits.maxItemAgeMs) {
        break;
      }
      items.shift();
      bytes -= oldest.byteLength;
      counters.expired += 1;
    }
  };

  const hasRoomFor = (byteLength: number): boolean =>
    items.length + 1 <= limits.maxItems && bytes + byteLength <= limits.maxBytes;

  const admit = (request: EnqueueRequest<Payload>, at: Instant): void => {
    items.push({
      id: request.id,
      byteLength: request.byteLength,
      enqueuedAt: at,
      coalescable: request.coalescable,
      mergeKey: request.mergeKey,
      payload: request.payload,
    });
    bytes += request.byteLength;
  };

  const releaseOneWaiter = (): void => {
    const next = waiters.shift();
    next?.release();
  };

  const overflowLimit = (
    byteLength: number,
  ): { limit: LimitKind; maximum: number; observed: number } =>
    items.length + 1 > limits.maxItems
      ? { limit: "items", maximum: limits.maxItems, observed: items.length }
      : { limit: "bytes", maximum: limits.maxBytes, observed: bytes + byteLength };

  return {
    async enqueue(
      request: EnqueueRequest<Payload>,
      signal?: AbortSignal,
    ): Promise<EnqueueOutcome<Payload>> {
      const now = clock.now();
      expire(now);

      if (hasRoomFor(request.byteLength)) {
        admit(request, now);
        counters.accepted += 1;
        return { kind: "accepted" };
      }

      switch (limits.overflow) {
        case "reject": {
          counters.rejected += 1;
          return { kind: "rejected", ...overflowLimit(request.byteLength) };
        }

        case "coalesce": {
          // Only a display-only item with a matching merge key may be replaced.
          // A semantic fact is never a coalescing candidate.
          const index =
            request.mergeKey === null
              ? -1
              : items.findIndex((item) => item.coalescable && item.mergeKey === request.mergeKey);
          if (index < 0 || !request.coalescable) {
            counters.rejected += 1;
            return { kind: "rejected", ...overflowLimit(request.byteLength) };
          }
          const [replaced] = items.splice(index, 1);
          if (replaced === undefined) {
            counters.rejected += 1;
            return { kind: "rejected", ...overflowLimit(request.byteLength) };
          }
          bytes -= replaced.byteLength;
          admit(request, now);
          counters.coalesced += 1;
          return { kind: "coalesced", replaced };
        }

        case "spill": {
          if (spill === undefined) {
            counters.rejected += 1;
            return { kind: "rejected", ...overflowLimit(request.byteLength) };
          }
          const artifact = await spill.spill(request.payload, request.byteLength);
          counters.spilled += 1;
          return { kind: "spilled", artifact };
        }

        case "wait": {
          if (signal?.aborted === true) {
            return { kind: "cancelled" };
          }
          const admitted = await new Promise<boolean>((resolve) => {
            let settled = false;
            const waiter: Waiter = {
              release: () => {
                if (settled) {
                  return;
                }
                settled = true;
                signal?.removeEventListener("abort", onAbort);
                resolve(true);
              },
            };
            const onAbort = (): void => {
              if (settled) {
                return;
              }
              settled = true;
              waiters = waiters.filter((candidate) => candidate !== waiter);
              resolve(false);
            };
            waiters.push(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
          });

          if (!admitted) {
            return { kind: "cancelled" };
          }
          const admittedAt = clock.now();
          expire(admittedAt);
          if (!hasRoomFor(request.byteLength)) {
            counters.rejected += 1;
            return { kind: "rejected", ...overflowLimit(request.byteLength) };
          }
          admit(request, admittedAt);
          counters.accepted += 1;
          return { kind: "waited" };
        }
      }
    },

    dequeue(): QueueItem<Payload> | null {
      expire(clock.now());
      const item = items.shift();
      if (item === undefined) {
        return null;
      }
      bytes -= item.byteLength;
      releaseOneWaiter();
      return item;
    },

    peek(): QueueItem<Payload> | null {
      expire(clock.now());
      return items[0] ?? null;
    },

    size(): number {
      return items.length;
    },

    byteLength(): number {
      return bytes;
    },

    report(): QueueReport {
      return {
        items: items.length,
        bytes,
        maxItems: limits.maxItems,
        maxBytes: limits.maxBytes,
        waiting: waiters.length,
        ...counters,
      };
    },

    drain(): void {
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) {
        waiter.release();
      }
    },
  };
}
