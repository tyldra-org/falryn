import { describe, expect, test } from "bun:test";

import { createManualSignalPort, INTERRUPT_SIGNALS, type InterruptSignal } from "./signal.ts";

describe("manual signal port", () => {
  test("delivers to every subscriber in subscription order", () => {
    const port = createManualSignalPort();
    const seen: string[] = [];
    port.onInterrupt(() => seen.push("first"));
    port.onInterrupt(() => seen.push("second"));

    port.emit("interrupt");
    expect(seen).toEqual(["first", "second"]);
  });

  test("carries the signal it was given", () => {
    const port = createManualSignalPort();
    const seen: InterruptSignal[] = [];
    port.onInterrupt((signal) => seen.push(signal));

    for (const signal of INTERRUPT_SIGNALS) {
      port.emit(signal);
    }
    expect(seen).toEqual([...INTERRUPT_SIGNALS]);
  });

  test("unsubscribing removes only that listener", () => {
    const port = createManualSignalPort();
    const seen: string[] = [];
    const release = port.onInterrupt(() => seen.push("first"));
    port.onInterrupt(() => seen.push("second"));

    release();
    port.emit("interrupt");
    expect(seen).toEqual(["second"]);
    expect(port.subscriberCount()).toBe(1);
  });

  test("unsubscribing twice is safe", () => {
    const port = createManualSignalPort();
    const release = port.onInterrupt(() => {});
    release();
    release();
    expect(port.subscriberCount()).toBe(0);
  });

  test("a listener that unsubscribes during delivery does not disturb the others", () => {
    const port = createManualSignalPort();
    const seen: string[] = [];
    const release = port.onInterrupt(() => {
      seen.push("first");
      release();
    });
    port.onInterrupt(() => seen.push("second"));

    port.emit("interrupt");
    expect(seen).toEqual(["first", "second"]);

    port.emit("interrupt");
    expect(seen).toEqual(["first", "second", "second"]);
  });
});
