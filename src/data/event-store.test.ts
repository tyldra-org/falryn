/**
 * The durable event store.
 *
 * The behavior worth testing here is the behavior the in-memory double cannot
 * have: ordering that survives a process exit, idempotency decided from
 * committed rows, a second connection contending for the same file, and a row
 * that somebody edited by hand. Every check runs against a real database in a
 * temporary state root, so what passes is the store rather than a stand-in for
 * it.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  capabilityInvocationCompleted,
  everyEventKind,
  FIXTURE_OTHER_STREAM,
  FIXTURE_STREAM,
  onOtherStream,
  sessionStarted,
  turnCompleted,
  turnStarted,
} from "../domain/fixtures.ts";
import {
  eventId,
  idempotencyKey,
  type LocalPath,
  MAX_EVENT_BYTES,
  MAX_STREAM_READ_LIMIT,
  type RuntimeEvent,
  type SqliteStorePort,
  sequence,
} from "../domain/index.ts";
import { createEventStoreShutdownParticipant, createSqliteEventStore } from "./event-store.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";

function temporaryRoot(): Promise<LocalPath> {
  return makeTemporaryRoot("falryn-event-store-");
}

afterEach(removeTemporaryRoots);

/** The first event of the second stream, with identities of its own. */
function otherStreamStart(): RuntimeEvent {
  return {
    ...onOtherStream(sessionStarted(1)),
    eventId: eventId.from("event-other-session-1"),
    idempotencyKey: idempotencyKey.from("key-other-session-1"),
  };
}

async function openStore(root: LocalPath): Promise<SqliteStorePort> {
  return openProductStoreOrThrow(root);
}

async function withStore(root: LocalPath) {
  const store = await openStore(root);
  return { store, events: createSqliteEventStore(store) };
}

async function appendAll(
  events: ReturnType<typeof createSqliteEventStore>,
  batch: readonly RuntimeEvent[],
): Promise<void> {
  for (const event of batch) {
    const receipt = await events.append(event);
    if (!receipt.ok) {
      throw new Error(`expected the append to succeed: ${receipt.error.code}`);
    }
  }
}

describe("append", () => {
  test("stores each event once, in order, and reports its sequence", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);

    for (const event of everyEventKind()) {
      expect(await events.append(event)).toEqual({
        ok: true,
        value: { kind: "appended", sequence: event.sequence, cancelledAfterCommit: false },
      });
    }

    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 100);
    expect(read.ok && read.value).toEqual(everyEventKind());
    await store.close();
  });

  test("a retried append is a duplicate receipt, not a second row", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const event = sessionStarted(1);

    await events.append(event);
    expect(await events.append(event)).toEqual({
      ok: true,
      value: { kind: "duplicate", sequence: event.sequence, cancelledAfterCommit: false },
    });

    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok && read.value).toHaveLength(1);
    await store.close();
  });

  test("reports a gap rather than storing an event out of reach", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    await events.append(sessionStarted(1));

    const gapped = await events.append(turnStarted(4));

    expect(gapped.ok).toBe(false);
    expect(!gapped.ok && gapped.error).toEqual({
      code: "sequence",
      error: {
        code: "sequence-gap",
        streamId: FIXTURE_STREAM,
        expectedSequence: sequence.from(2),
        observedSequence: sequence.from(4),
      },
    });
    await store.close();
  });

  test("reports an out-of-order append against the stream's committed head", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    await appendAll(events, [sessionStarted(1), turnStarted(2), turnCompleted(3)]);

    // A different event at a sequence the stream already passed.
    const stale = await events.append({
      ...turnStarted(2),
      eventId: eventId.from("event-late"),
      idempotencyKey: idempotencyKey.from("key-late"),
    });

    expect(!stale.ok && stale.error).toMatchObject({
      code: "sequence",
      error: { code: "sequence-out-of-order", expectedSequence: sequence.from(4) },
    });
    await store.close();
  });

  test("reports an idempotency conflict when a key is reused by another event", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const first = sessionStarted(1);
    await events.append(first);

    const reused = await events.append({
      ...turnStarted(2),
      idempotencyKey: first.idempotencyKey,
    });

    expect(!reused.ok && reused.error).toMatchObject({
      code: "sequence",
      error: {
        code: "idempotency-conflict",
        recordedEventId: first.eventId,
        observedEventId: turnStarted(2).eventId,
      },
    });
    await store.close();
  });

  test("reports an event-id conflict when an identifier is reused", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const first = sessionStarted(1);
    await events.append(first);

    const reused = await events.append({ ...turnStarted(2), eventId: first.eventId });

    expect(!reused.ok && reused.error).toEqual({
      code: "sequence",
      error: { code: "event-id-conflict", streamId: FIXTURE_STREAM, eventId: first.eventId },
    });
    await store.close();
  });

  test("never reports the in-memory ledger's capacity code", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    await events.append(sessionStarted(1));

    const gapped = await events.append(turnStarted(9));

    // `ledger-capacity-exceeded` is a bound on an in-process cache. A durable
    // store has no such bound and must not borrow the code.
    expect(!gapped.ok && gapped.error.code === "sequence" && gapped.error.error.code).not.toBe(
      "ledger-capacity-exceeded",
    );
    await store.close();
  });

  test("refuses an event the codec rejects before a row exists for it", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    // Assembled through a cast, as an unchecked producer could. The encode step
    // that enforces the 64 KiB bound revalidates too, so neither an oversized
    // nor a malformed event can reach a row.
    const malformed = { ...sessionStarted(1), eventId: "not an identifier" } as RuntimeEvent;

    const appended = await events.append(malformed);

    expect(!appended.ok && appended.error).toMatchObject({ code: "codec" });
    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok && read.value).toEqual([]);
    await store.close();
  });

  test("keeps streams independent", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);

    await events.append(sessionStarted(1));
    expect(await events.append(otherStreamStart())).toMatchObject({ ok: true });

    const other = await events.readFrom(
      { streamId: FIXTURE_OTHER_STREAM, afterSequence: null },
      10,
    );
    expect(other.ok && other.value).toHaveLength(1);
    await store.close();
  });

  test("holds event identifiers unique across every stream, not only within one", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const first = sessionStarted(1);
    await events.append(first);

    const elsewhere = await events.append(onOtherStream(first));

    // Stricter than the in-memory double, deliberately: an event identifier
    // names an event, not a position in a stream, and the primary key that
    // makes a row addressable is what enforces it. The double tracks a bounded
    // per-stream window and cannot make this promise.
    expect(!elsewhere.ok && elsewhere.error).toMatchObject({
      code: "sequence",
      error: { code: "event-id-conflict", eventId: first.eventId },
    });
    await store.close();
  });
});

describe("reads", () => {
  test("resume strictly after the cursor", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    await appendAll(events, everyEventKind());

    const read = await events.readFrom(
      { streamId: FIXTURE_STREAM, afterSequence: sequence.from(6) },
      10,
    );

    expect(read.ok && read.value.map((event) => event.sequence)).toEqual([
      sequence.from(7),
      sequence.from(8),
    ]);
    await store.close();
  });

  test("refuse a limit above the declared bound", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);

    const read = await events.readFrom(
      { streamId: FIXTURE_STREAM, afterSequence: null },
      MAX_STREAM_READ_LIMIT + 1,
    );

    expect(!read.ok && read.error).toEqual({
      code: "invalid-read-limit",
      requestedLimit: MAX_STREAM_READ_LIMIT + 1,
      maximumLimit: MAX_STREAM_READ_LIMIT,
    });
    await store.close();
  });

  test("report every stream's head, which is what a checkpoint pass walks", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    await appendAll(events, [sessionStarted(1), turnStarted(2)]);
    await events.append(otherStreamStart());

    expect(events.streamHeads(10)).toEqual({
      ok: true,
      value: [
        { streamId: FIXTURE_STREAM, lastSequence: sequence.from(2) },
        { streamId: FIXTURE_OTHER_STREAM, lastSequence: sequence.from(1) },
      ],
    });
    await store.close();
  });
});

describe("a restart", () => {
  test("continues at the correct sequence with no in-memory ledger", async () => {
    const root = await temporaryRoot();
    const first = await withStore(root);
    await appendAll(first.events, [sessionStarted(1), turnStarted(2)]);
    await first.store.close();

    const second = await withStore(root);
    const continued = await second.events.append(turnCompleted(3));

    expect(continued).toMatchObject({ ok: true, value: { kind: "appended" } });
    // And the restart still recognizes an event it never saw appended.
    expect(await second.events.append(turnStarted(2))).toMatchObject({
      ok: true,
      value: { kind: "duplicate", sequence: 2 },
    });
    await second.store.close();
  });

  test("rejects a gap decided against the rows the previous run left", async () => {
    const root = await temporaryRoot();
    const first = await withStore(root);
    await first.events.append(sessionStarted(1));
    await first.store.close();

    const second = await withStore(root);
    const gapped = await second.events.append(turnCompleted(3));

    expect(!gapped.ok && gapped.error).toMatchObject({
      code: "sequence",
      error: { code: "sequence-gap", expectedSequence: sequence.from(2) },
    });
    await second.store.close();
  });
});

describe("contention", () => {
  test("a second connection sees the first's committed events", async () => {
    const root = await temporaryRoot();
    const first = await withStore(root);
    const second = await withStore(root);

    await first.events.append(sessionStarted(1));

    // The second connection decides its append from the rows the first
    // committed, not from anything it remembers.
    const gapped = await second.events.append(turnCompleted(3));
    expect(!gapped.ok && gapped.error).toMatchObject({
      code: "sequence",
      error: { code: "sequence-gap", expectedSequence: sequence.from(2) },
    });

    expect(await second.events.append(turnStarted(2))).toMatchObject({
      ok: true,
      value: { kind: "appended" },
    });
    await second.store.close();
    await first.store.close();
  });
});

describe("cancellation", () => {
  test("before the write begins reports cancelled and commits nothing", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const aborted = AbortSignal.abort();

    const appended = await events.append(sessionStarted(1), aborted);

    expect(!appended.ok && appended.error).toEqual({ code: "cancelled" });
    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok && read.value).toEqual([]);
    await store.close();
  });

  test("after the commit reports the commit and the cancellation beside it", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const controller = new AbortController();
    // Aborts inside the transaction, after the work and before the commit is
    // observed. The write still commits, and reporting it as `cancelled` would
    // say nothing happened when something did.
    const original = store.write.bind(store);
    (store as { write: typeof store.write }).write = (work, signal) =>
      original((statements) => {
        const value = work(statements);
        controller.abort();
        return value;
      }, signal);

    const appended = await events.append(sessionStarted(1), controller.signal);

    expect(appended).toMatchObject({
      ok: true,
      value: { kind: "appended", cancelledAfterCommit: true },
    });
    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok && read.value).toHaveLength(1);
    await store.close();
  });

  test("a cancelled read reports cancelled", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);

    const read = await events.readFrom(
      { streamId: FIXTURE_STREAM, afterSequence: null },
      10,
      AbortSignal.abort(),
    );

    expect(!read.ok && read.error).toEqual({ code: "cancelled" });
    await store.close();
  });
});

describe("a hand-edited row", () => {
  async function corrupt(root: LocalPath, sql: string): Promise<void> {
    const store = await openStore(root);
    const events = createSqliteEventStore(store);
    await events.append(sessionStarted(1));
    store.write((statements) => statements.run(sql));
    await store.close();
  }

  test("with an unknown kind is rejected on read rather than admitted", async () => {
    const root = await temporaryRoot();
    await corrupt(root, "UPDATE events SET kind = 'session.deleted'");

    const { store, events } = await withStore(root);
    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);

    expect(!read.ok && read.error).toEqual({
      code: "codec",
      error: { kind: "unknown-event-kind", observedKind: "session.deleted" },
    });
    await store.close();
  });

  test("with a malformed identity is rejected with a path and no value", async () => {
    const root = await temporaryRoot();
    await corrupt(root, "UPDATE events SET event_id = 'not an identifier'");

    const { store, events } = await withStore(root);
    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);

    expect(!read.ok && read.error).toEqual({
      code: "codec",
      error: { kind: "invalid-envelope", issues: [{ path: "eventId", code: "custom" }] },
    });
    await store.close();
  });

  test("with an oversized payload is rejected on read", async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);
    const events = createSqliteEventStore(store);
    await events.append(sessionStarted(1));
    store.write((statements) =>
      statements.run("UPDATE events SET payload = $payload", {
        payload: JSON.stringify({ correlation: {}, padding: "x".repeat(MAX_EVENT_BYTES) }),
      }),
    );
    await store.close();

    const reopened = await withStore(root);
    const read = await reopened.events.readFrom(
      { streamId: FIXTURE_STREAM, afterSequence: null },
      10,
    );

    expect(!read.ok && read.error).toMatchObject({
      code: "codec",
      error: { kind: "oversized-event", maximumBytes: MAX_EVENT_BYTES },
    });
    await reopened.store.close();
  });

  test("with a payload that is not JSON is rejected", async () => {
    const root = await temporaryRoot();
    await corrupt(root, "UPDATE events SET payload = 'not json'");

    const { store, events } = await withStore(root);
    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);

    expect(!read.ok && read.error).toMatchObject({ code: "codec" });
    await store.close();
  });
});

describe("a store failure", () => {
  test("is reported as storage with its operation and effect intact", async () => {
    const root = await temporaryRoot();
    const healthy = await openStore(root);
    const full = createSqliteEventStore(
      await openProductStoreOrThrow(root, {
        faults: { failOperations: { transaction: "disk-full" } },
      }),
    );

    const appended = await full.append(sessionStarted(1));

    expect(!appended.ok && appended.error).toMatchObject({
      code: "storage",
      error: { code: "disk-full", operation: "transaction", effect: "none" },
    });
    await healthy.close();
  });
});

describe("the persist-outcomes participant", () => {
  test("stops accepting appends so the close phase has nothing still writing", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    const participant = createEventStoreShutdownParticipant(events);

    expect(participant.phase).toBe("persist-outcomes");
    expect(events.isAccepting()).toBe(true);
    await participant.run({
      phase: "persist-outcomes",
      signal: new AbortController().signal,
      clock: { now: () => 0 } as never,
    });

    expect(events.isAccepting()).toBe(false);
    const late = await events.append(sessionStarted(1));
    expect(!late.ok && late.error).toMatchObject({ code: "storage", error: { code: "closed" } });
    await store.close();
  });

  test("leaves reads working, because the checkpoint phase still has to read", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);
    await appendAll(events, [sessionStarted(1), turnStarted(2), capabilityInvocationCompleted(3)]);

    await events.quiesce();

    const read = await events.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok && read.value).toHaveLength(3);
    await store.close();
  });

  test("is idempotent", async () => {
    const root = await temporaryRoot();
    const { store, events } = await withStore(root);

    await events.quiesce();
    await events.quiesce();

    expect(events.isAccepting()).toBe(false);
    await store.close();
  });
});
