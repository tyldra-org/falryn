/**
 * The append-and-read-from-cursor port for runtime events.
 *
 * Declared here so persistence has one authority to implement rather than a
 * second, differently shaped one invented at the adapter. The port is
 * deliberately minimal: append one event, read forward from a cursor. Every
 * other access pattern is a projection built on top of a cursor read.
 *
 * The in-memory implementation below is a test double. Durable storage,
 * transactions, and retention belong to the persistence owner.
 */

import { decodeRuntimeEvent, encodeRuntimeEvent } from "./codec.ts";
import type { CodecError } from "./codec-error.ts";
import type { RuntimeEvent } from "./event.ts";
import type { Sequence, StreamId } from "./identity.ts";
import { MAX_STREAM_READ_LIMIT } from "./limits.ts";
import { err, ok, type Result } from "./result.ts";
import { createStreamSequencer, type SequenceError } from "./sequence.ts";
import type { SqliteStoreError } from "./sqlite.ts";

/** Reads resume strictly after `afterSequence`; `null` reads from the start. */
export type EventCursor = {
  readonly streamId: StreamId;
  readonly afterSequence: Sequence | null;
};

/**
 * What an append did.
 *
 * `cancelledAfterCommit` is carried rather than folded into the kind, because
 * the two facts are independent: cancellation that arrived after the append
 * committed did not undo it, and reporting it as `cancelled` would tell a
 * caller nothing happened when something did. Cancellation before the write
 * began is the `cancelled` error instead, which keeps that code meaning exactly
 * "did not commit".
 */
export type AppendReceipt =
  | {
      readonly kind: "appended";
      readonly sequence: Sequence;
      readonly cancelledAfterCommit: boolean;
    }
  /** The event was already stored. No second event exists. */
  | {
      readonly kind: "duplicate";
      readonly sequence: Sequence;
      readonly cancelledAfterCommit: boolean;
    };

export type EventStoreError =
  /** Cancellation was requested before the operation committed. */
  | { readonly code: "cancelled" }
  | { readonly code: "sequence"; readonly error: SequenceError }
  | { readonly code: "codec"; readonly error: CodecError }
  | {
      readonly code: "invalid-read-limit";
      readonly requestedLimit: number;
      readonly maximumLimit: number;
    }
  /**
   * The durable store could not answer.
   *
   * Carried whole rather than folded onto `codec` or `sequence`, because a
   * store that is busy, full, unavailable, or closed sends a caller to a
   * completely different diagnosis than a malformed event or a bad sequence.
   * The in-memory double below never produces it.
   */
  | { readonly code: "storage"; readonly error: SqliteStoreError };

export type EventStorePort = {
  /**
   * Appends one event to its stream.
   *
   * Appending an event that was already appended returns a `duplicate`
   * receipt; it never writes a second event and never reports failure.
   */
  append(
    event: RuntimeEvent,
    signal?: AbortSignal,
  ): Promise<Result<AppendReceipt, EventStoreError>>;

  /**
   * Reads up to `limit` events from one stream, in sequence order, starting
   * after the cursor. A subscriber that dropped resumes from its last cursor.
   */
  readFrom(
    cursor: EventCursor,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly RuntimeEvent[], EventStoreError>>;
};

/**
 * An in-memory `EventStorePort` for tests.
 *
 * Events are held in their encoded form so a stored event is proven to survive
 * the codec, exactly as a durable store would require.
 */
export function createInMemoryEventStore(): EventStorePort {
  const sequencer = createStreamSequencer();
  const streams = new Map<StreamId, Uint8Array[]>();

  return {
    async append(
      event: RuntimeEvent,
      signal?: AbortSignal,
    ): Promise<Result<AppendReceipt, EventStoreError>> {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }

      const encoded = encodeRuntimeEvent(event);
      if (!encoded.ok) {
        return err({ code: "codec", error: encoded.error });
      }

      const decision = sequencer.append(event);
      switch (decision.kind) {
        case "rejected":
          return err({ code: "sequence", error: decision.error });
        case "duplicate":
          return ok({
            kind: "duplicate",
            sequence: decision.sequence,
            cancelledAfterCommit: false,
          });
        case "appended": {
          const stored = streams.get(event.streamId) ?? [];
          stored.push(encoded.value);
          streams.set(event.streamId, stored);
          // Nothing awaits between the check above and this line, so an
          // in-memory append can never be cancelled after it committed.
          return ok({
            kind: "appended",
            sequence: decision.sequence,
            cancelledAfterCommit: false,
          });
        }
      }
    },

    async readFrom(
      cursor: EventCursor,
      limit: number,
      signal?: AbortSignal,
    ): Promise<Result<readonly RuntimeEvent[], EventStoreError>> {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STREAM_READ_LIMIT) {
        return err({
          code: "invalid-read-limit",
          requestedLimit: limit,
          maximumLimit: MAX_STREAM_READ_LIMIT,
        });
      }

      const stored = streams.get(cursor.streamId) ?? [];
      const events: RuntimeEvent[] = [];
      for (const bytes of stored) {
        const decoded = decodeRuntimeEvent(bytes);
        if (!decoded.ok) {
          return err({ code: "codec", error: decoded.error });
        }
        if (cursor.afterSequence !== null && decoded.value.sequence <= cursor.afterSequence) {
          continue;
        }
        events.push(decoded.value);
        if (events.length === limit) {
          break;
        }
      }
      return ok(events);
    },
  };
}
