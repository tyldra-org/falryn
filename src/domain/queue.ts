/**
 * Bounded queue contracts.
 *
 * A queue declares what it will hold and what happens when it cannot hold more.
 * There is no unbounded option: the resolutions below are exhaustive, and every
 * one of them is a decision the producer can observe.
 *
 * The line that matters: **display-only data may be coalesced, semantic facts
 * may not.** A provider text delta can be merged with the next one and nobody
 * loses anything. A terminal result, a lifecycle event, or an artifact
 * commitment that gets merged away is a fact the system will later claim never
 * happened.
 */

import type { DurationMs, Instant } from "./clock.ts";

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type QueueItemId = Brand<string, "QueueItemId">;

/** An opaque reference to spilled bytes. The artifact owner writes them. */
export type ArtifactHandle = {
  readonly artifactId: string;
  readonly byteLength: number;
};

/**
 * What a queue does when a limit is reached.
 *
 * `wait` is only safe for a producer that can be cancelled; `coalesce` is only
 * legal for display-only items; `spill` needs somewhere to put bytes.
 */
export const OVERFLOW_POLICIES = ["reject", "wait", "spill", "coalesce"] as const;

export type OverflowPolicy = (typeof OVERFLOW_POLICIES)[number];

export type QueueLimits = {
  readonly maxItems: number;
  readonly maxBytes: number;
  /** Items older than this are dropped before a new item is considered. */
  readonly maxItemAgeMs: DurationMs;
  readonly overflow: OverflowPolicy;
};

export type QueueItem<Payload> = {
  readonly id: QueueItemId;
  readonly byteLength: number;
  readonly enqueuedAt: Instant;
  /**
   * Whether this item may be merged into a later one.
   *
   * False for every semantic fact. A queue refuses to coalesce it even under a
   * coalescing policy, and falls through to the next resolution instead.
   */
  readonly coalescable: boolean;
  /**
   * Items sharing a merge key may replace one another when coalescing.
   *
   * `null` means the item is not mergeable with anything even if coalescable.
   */
  readonly mergeKey: string | null;
  readonly payload: Payload;
};

export type LimitKind = "items" | "bytes" | "age";

export type EnqueueOutcome<Payload> =
  | { readonly kind: "accepted" }
  /** An older display-only item was replaced by this one. */
  | { readonly kind: "coalesced"; readonly replaced: QueueItem<Payload> }
  /** The payload was moved out of memory; the handle stays in the queue. */
  | { readonly kind: "spilled"; readonly artifact: ArtifactHandle }
  /** The producer waited for room and was then admitted. */
  | { readonly kind: "waited" }
  /** The producer waited and its cancellation fired first. Nothing was queued. */
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "rejected";
      readonly limit: LimitKind;
      readonly maximum: number;
      readonly observed: number;
    };

/**
 * Writes an oversized payload out of memory.
 *
 * Declared here so a queue can resolve to `spilled` without knowing how bytes
 * are stored. The artifact owner implements it; this issue drives an in-memory
 * double.
 */
export type ArtifactSpillPort = {
  spill(payload: unknown, byteLength: number): Promise<ArtifactHandle>;
};

export type QueueReport = {
  readonly items: number;
  readonly bytes: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  /** Producers currently blocked on a `wait` policy. */
  readonly waiting: number;
  readonly accepted: number;
  readonly coalesced: number;
  readonly spilled: number;
  readonly rejected: number;
  /** Items dropped for exceeding the age limit. Never silent. */
  readonly expired: number;
};
