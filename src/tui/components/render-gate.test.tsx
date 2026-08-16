/**
 * The gate, mounted: a held stream snapshot paints when cadence elapses or
 * when input arrives, and not before.
 *
 * The schedule's own tests already prove the decisions. These prove the clock
 * wait and the listener actually move what is on the frame.
 */

import { describe, expect, test } from "bun:test";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createManualClock, duration } from "../../domain/index.ts";
import { mount, type Rendered } from "../harness.tsx";
import type { RenderKind } from "../render-schedule.ts";
import { STREAM_PUBLISH_CADENCE } from "../render-schedule.ts";
import { RenderGateProvider, useRenderGate } from "./render-gate.tsx";

type Handle = {
  push(value: string, kind: RenderKind): void;
};

function Display(props: { readonly handle: Handle }) {
  const [shown, setShown] = useState("none");
  const held = useRef("none");
  const gate = useRenderGate();

  useEffect(() => {
    props.handle.push = (value, kind) => {
      held.current = value;
      if (gate.note(kind)) {
        setShown(held.current);
      }
    };
    return gate.onDue(() => {
      setShown(held.current);
    });
  }, [gate, props.handle]);

  return <text>{shown}</text>;
}

function gated(clock: ReturnType<typeof createManualClock>, handle: Handle): ReactNode {
  return (
    <RenderGateProvider clock={clock}>
      <Display handle={handle} />
    </RenderGateProvider>
  );
}

async function shown(view: Rendered): Promise<string> {
  return (await view.frame()).trim();
}

describe("the render gate", () => {
  test("holds a stream burst and paints the latest snapshot when cadence elapses", async () => {
    const clock = createManualClock();
    const handle: Handle = { push: () => {} };
    using view = await mount(gated(clock, handle), { shape: { columns: 40, rows: 4 } });
    expect(await shown(view)).toBe("none");

    handle.push("one", "stream");
    expect(await shown(view)).toBe("one");

    handle.push("two", "stream");
    handle.push("ten", "stream");
    expect(await shown(view)).toBe("one");

    await clock.advance(STREAM_PUBLISH_CADENCE);
    expect(await shown(view)).toBe("ten");
  });

  test("paints a held stream snapshot as soon as input arrives", async () => {
    const clock = createManualClock();
    const handle: Handle = { push: () => {} };
    using view = await mount(gated(clock, handle), { shape: { columns: 40, rows: 4 } });
    expect(await shown(view)).toBe("none");

    handle.push("one", "stream");
    handle.push("two", "stream");
    expect(await shown(view)).toBe("one");

    handle.push("typed", "input");
    expect(await shown(view)).toBe("typed");
    expect(clock.pendingWaitCount()).toBe(0);
  });

  test("does not wait a full cadence when none is configured on the provider", async () => {
    // A missing provider is the immediate gate; this is the same contract with
    // a zero cadence, so a test can name the clock without waiting.
    const clock = createManualClock();
    const handle: Handle = { push: () => {} };
    using view = await mount(
      <RenderGateProvider clock={clock} cadence={duration(0)}>
        <Display handle={handle} />
      </RenderGateProvider>,
      { shape: { columns: 40, rows: 4 } },
    );
    expect(await shown(view)).toBe("none");

    handle.push("one", "stream");
    handle.push("two", "stream");
    expect(await shown(view)).toBe("two");
  });
});
