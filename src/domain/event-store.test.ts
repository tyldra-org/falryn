import { describe, expect, test } from "bun:test";

import { createInMemoryEventStore } from "./event-store.ts";
import {
  everyEventKind,
  FIXTURE_OTHER_STREAM,
  FIXTURE_STREAM,
  onOtherStream,
  sessionStarted,
  turnStarted,
} from "./fixtures.ts";
import { sequence } from "./identity.ts";
import { MAX_STREAM_READ_LIMIT } from "./limits.ts";

describe("append", () => {
  test("stores each event once and reports its sequence", async () => {
    const store = createInMemoryEventStore();
    for (const event of everyEventKind()) {
      const receipt = await store.append(event);
      expect(receipt).toEqual({
        ok: true,
        value: { kind: "appended", sequence: event.sequence, cancelledAfterCommit: false },
      });
    }
  });

  test("a retried append is a duplicate receipt, not a failure or a second event", async () => {
    const store = createInMemoryEventStore();
    const event = sessionStarted(1);
    await store.append(event);
    const retry = await store.append(event);
    expect(retry).toEqual({
      ok: true,
      value: { kind: "duplicate", sequence: event.sequence, cancelledAfterCommit: false },
    });

    const read = await store.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
    }
  });

  test("reports a sequence rejection instead of storing the event", async () => {
    const store = createInMemoryEventStore();
    await store.append(sessionStarted(1));
    const gapped = await store.append(turnStarted(4));
    expect(gapped.ok).toBe(false);
    if (!gapped.ok && gapped.error.code === "sequence") {
      expect(gapped.error.error.code).toBe("sequence-gap");
    }
  });

  test("refuses an event that cannot be encoded", async () => {
    const store = createInMemoryEventStore();
    const invalid = { ...sessionStarted(1), eventId: "" } as ReturnType<typeof sessionStarted>;
    const result = await store.append(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("codec");
    }
  });
});

describe("read from cursor", () => {
  test("resumes strictly after the cursor", async () => {
    const store = createInMemoryEventStore();
    for (const event of everyEventKind()) {
      await store.append(event);
    }
    const read = await store.readFrom(
      { streamId: FIXTURE_STREAM, afterSequence: sequence.from(6) },
      10,
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((event) => event.sequence)).toEqual([
        sequence.from(7),
        sequence.from(8),
      ]);
    }
  });

  test("returns events in sequence order and honours the limit", async () => {
    const store = createInMemoryEventStore();
    for (const event of everyEventKind()) {
      await store.append(event);
    }
    const read = await store.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 3);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.map((event) => event.sequence)).toEqual([
        sequence.from(1),
        sequence.from(2),
        sequence.from(3),
      ]);
    }
  });

  test("reads one stream without observing another", async () => {
    const store = createInMemoryEventStore();
    await store.append(sessionStarted(1));
    await store.append(onOtherStream(sessionStarted(1)));

    const read = await store.readFrom({ streamId: FIXTURE_OTHER_STREAM, afterSequence: null }, 10);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
      expect(read.value[0]?.streamId).toBe(FIXTURE_OTHER_STREAM);
    }
  });

  test("returns nothing for an unknown stream rather than failing", async () => {
    const store = createInMemoryEventStore();
    const read = await store.readFrom({ streamId: FIXTURE_OTHER_STREAM, afterSequence: null }, 10);
    expect(read).toEqual({ ok: true, value: [] });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["above the maximum", MAX_STREAM_READ_LIMIT + 1],
  ])("rejects a %s read limit", async (_label, limit) => {
    const store = createInMemoryEventStore();
    const read = await store.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, limit);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("invalid-read-limit");
    }
  });
});

describe("cancellation", () => {
  test("an aborted append commits nothing", async () => {
    const store = createInMemoryEventStore();
    const controller = new AbortController();
    controller.abort();

    const result = await store.append(sessionStarted(1), controller.signal);
    expect(result).toEqual({ ok: false, error: { code: "cancelled" } });

    const read = await store.readFrom({ streamId: FIXTURE_STREAM, afterSequence: null }, 10);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toEqual([]);
    }
  });

  test("an aborted read reports cancellation rather than an empty page", async () => {
    const store = createInMemoryEventStore();
    await store.append(sessionStarted(1));
    const controller = new AbortController();
    controller.abort();

    const read = await store.readFrom(
      { streamId: FIXTURE_STREAM, afterSequence: null },
      10,
      controller.signal,
    );
    expect(read).toEqual({ ok: false, error: { code: "cancelled" } });
  });
});
