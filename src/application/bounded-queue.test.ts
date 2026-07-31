import { describe, expect, test } from "bun:test";

import {
  type ArtifactSpillPort,
  createManualClock,
  duration,
  instant,
  type OverflowPolicy,
  type QueueItemId,
  type QueueLimits,
} from "../domain/index.ts";
import { createBoundedQueue } from "./bounded-queue.ts";

function limits(overflow: OverflowPolicy, overrides: Partial<QueueLimits> = {}): QueueLimits {
  return {
    maxItems: 3,
    maxBytes: 300,
    maxItemAgeMs: duration(1_000),
    overflow,
    ...overrides,
  };
}

/** A display-only delta: safe to merge with the next one. */
function delta(id: string, bytes = 10) {
  return {
    id: id as QueueItemId,
    byteLength: bytes,
    coalescable: true,
    mergeKey: "transcript",
    payload: id,
  };
}

/** A semantic fact: a terminal result, lifecycle event, or artifact commitment. */
function semantic(id: string, bytes = 10) {
  return {
    id: id as QueueItemId,
    byteLength: bytes,
    coalescable: false,
    mergeKey: null,
    payload: id,
  };
}

describe("saturation", () => {
  test("rejects past the item limit and names the limit it hit", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("reject") });

    for (const id of ["a", "b", "c"]) {
      expect((await queue.enqueue(semantic(id))).kind).toBe("accepted");
    }
    const overflowed = await queue.enqueue(semantic("d"));
    expect(overflowed).toEqual({ kind: "rejected", limit: "items", maximum: 3, observed: 3 });
  });

  test("rejects past the byte limit before the item limit is reached", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({
      clock,
      limits: limits("reject", { maxItems: 100, maxBytes: 50 }),
    });

    expect((await queue.enqueue(semantic("a", 40))).kind).toBe("accepted");
    const overflowed = await queue.enqueue(semantic("b", 40));
    expect(overflowed).toEqual({ kind: "rejected", limit: "bytes", maximum: 50, observed: 80 });
  });

  test("drops items past the age limit and counts them", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("reject") });

    await queue.enqueue(semantic("stale"));
    await clock.advance(duration(1_001));

    expect(queue.peek()).toBeNull();
    expect(queue.report().expired).toBe(1);
    expect(queue.byteLength()).toBe(0);
  });

  test("an item exactly at the age limit is not expired", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("reject") });

    await queue.enqueue(semantic("fresh"));
    await clock.advance(duration(1_000));
    expect(queue.peek()?.id).toBe("fresh" as QueueItemId);
  });

  test("expiring frees room for a new item", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("reject") });

    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }
    await clock.advance(duration(1_001));

    expect((await queue.enqueue(semantic("d"))).kind).toBe("accepted");
    expect(queue.report().expired).toBe(3);
  });
});

describe("coalescing", () => {
  test("a slow consumer merges display-only deltas", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("coalesce") });

    for (const id of ["d1", "d2", "d3"]) {
      expect((await queue.enqueue(delta(id))).kind).toBe("accepted");
    }
    const merged = await queue.enqueue(delta("d4"));
    expect(merged.kind).toBe("coalesced");
    if (merged.kind === "coalesced") {
      expect(merged.replaced.id).toBe("d1" as QueueItemId);
    }
    expect(queue.size()).toBe(3);
  });

  test("order is preserved for what remains", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("coalesce") });

    for (const id of ["d1", "d2", "d3", "d4"]) {
      await queue.enqueue(delta(id));
    }
    const drained: string[] = [];
    for (;;) {
      const item = queue.dequeue();
      if (item === null) {
        break;
      }
      drained.push(item.payload);
    }
    expect(drained).toEqual(["d2", "d3", "d4"]);
  });

  test("a semantic fact is never coalesced away", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("coalesce") });

    await queue.enqueue(semantic("terminal-result"));
    await queue.enqueue(delta("d1"));
    await queue.enqueue(delta("d2"));

    // Overflow under a coalescing policy: the only mergeable candidates are the
    // deltas, and the semantic item must survive untouched.
    const merged = await queue.enqueue(delta("d3"));
    expect(merged.kind).toBe("coalesced");

    const remaining: string[] = [];
    for (;;) {
      const item = queue.dequeue();
      if (item === null) {
        break;
      }
      remaining.push(item.payload);
    }
    expect(remaining).toContain("terminal-result");
  });

  test("a semantic fact that overflows is rejected, not merged", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("coalesce") });

    for (const id of ["d1", "d2", "d3"]) {
      await queue.enqueue(delta(id));
    }
    const overflowed = await queue.enqueue(semantic("terminal-result"));
    expect(overflowed.kind).toBe("rejected");
    expect(queue.report().coalesced).toBe(0);
  });

  test("an item with no merge key is not a coalescing candidate", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("coalesce") });

    for (const id of ["d1", "d2", "d3"]) {
      await queue.enqueue(delta(id));
    }
    const keyless = await queue.enqueue({ ...delta("d4"), mergeKey: null });
    expect(keyless.kind).toBe("rejected");
  });
});

describe("spill", () => {
  test("moves an overflowing payload out of memory", async () => {
    const clock = createManualClock(instant(0));
    const spilled: number[] = [];
    const spill: ArtifactSpillPort = {
      spill: (_payload, byteLength) => {
        spilled.push(byteLength);
        return Promise.resolve({ artifactId: `artifact-${spilled.length}`, byteLength });
      },
    };
    const queue = createBoundedQueue<string>({ clock, limits: limits("spill"), spill });

    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }
    const outcome = await queue.enqueue(semantic("d", 99));
    expect(outcome.kind).toBe("spilled");
    if (outcome.kind === "spilled") {
      expect(outcome.artifact.byteLength).toBe(99);
    }
    expect(spilled).toEqual([99]);
    expect(queue.size()).toBe(3);
  });

  test("rejects rather than growing when no spill port is wired", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("spill") });
    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }
    expect((await queue.enqueue(semantic("d"))).kind).toBe("rejected");
  });
});

describe("backpressure", () => {
  test("a waiting producer is admitted once the consumer drains one", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("wait") });

    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }
    const waiting = queue.enqueue(semantic("d"));
    await Promise.resolve();
    expect(queue.report().waiting).toBe(1);

    queue.dequeue();
    expect((await waiting).kind).toBe("waited");
    expect(queue.size()).toBe(3);
  });

  test("a cancelled producer queues nothing", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("wait") });
    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }

    const controller = new AbortController();
    const waiting = queue.enqueue(semantic("d"), controller.signal);
    await Promise.resolve();
    controller.abort();

    expect((await waiting).kind).toBe("cancelled");
    expect(queue.size()).toBe(3);
    expect(queue.report().waiting).toBe(0);
  });

  test("an already-cancelled producer does not wait at all", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("wait") });
    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }
    const controller = new AbortController();
    controller.abort();

    expect((await queue.enqueue(semantic("d"), controller.signal)).kind).toBe("cancelled");
  });

  test("draining releases every waiting producer", async () => {
    const clock = createManualClock(instant(0));
    const queue = createBoundedQueue<string>({ clock, limits: limits("wait") });
    for (const id of ["a", "b", "c"]) {
      await queue.enqueue(semantic(id));
    }
    const waiting = queue.enqueue(semantic("d"));
    await Promise.resolve();

    queue.drain();
    // Released with the queue still full, so it is refused rather than admitted.
    expect((await waiting).kind).toBe("rejected");
    expect(queue.report().waiting).toBe(0);
  });
});

describe("queue separation", () => {
  test("a saturated maintenance queue cannot block a lifecycle queue", async () => {
    const clock = createManualClock(instant(0));
    const maintenance = createBoundedQueue<string>({
      clock,
      limits: limits("reject", { maxItems: 1 }),
    });
    const lifecycle = createBoundedQueue<string>({ clock, limits: limits("reject") });

    await maintenance.enqueue(semantic("gc"));
    expect((await maintenance.enqueue(semantic("index"))).kind).toBe("rejected");

    // The lifecycle queue is untouched by the other queue's saturation.
    expect((await lifecycle.enqueue(semantic("turn.completed"))).kind).toBe("accepted");
    expect(lifecycle.report().rejected).toBe(0);
  });
});
