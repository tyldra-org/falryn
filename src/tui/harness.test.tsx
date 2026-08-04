/**
 * Cleanup, as assertions.
 *
 * Every rendered check in this area leaves a renderer, a React tree, and
 * whatever that tree subscribed to behind it. None of that is cleaned up by the
 * runtime: OpenTUI releases nothing on `process.exit` or on an unhandled error,
 * so a renderer that outlives its check does not fail that check — it fails the
 * next one, for a reason that has nothing to do with it. That is the worst
 * failure shape a suite can have, and #27 asks for it to be asserted rather
 * than left to a teardown convention.
 *
 * The negative control is the point of the file. "The renderer was destroyed"
 * proves nothing if `isDestroyed` were true whatever happened, so one check
 * here deliberately leaks one and asserts that the observation notices.
 */

import { describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { hasPainted, mount, openRenderer, type Rendered } from "./harness.tsx";

const SHAPE = { columns: 40, rows: 8 };

/** A tree that reports its own mounting and unmounting. */
function Probe(props: { readonly onUnmount: () => void }): React.ReactNode {
  const { onUnmount } = props;
  useEffect(() => onUnmount, [onUnmount]);
  return (
    <box flexDirection="column">
      <text>mounted</text>
    </box>
  );
}

describe("what a check leaves behind", () => {
  test("destroys the renderer when the scope that opened it ends", async () => {
    let held: Rendered | null = null;
    {
      using shell = await mount(<Probe onUnmount={() => {}} />, { shape: SHAPE });
      held = shell;
      expect(shell.setup.renderer.isDestroyed).toBe(false);
    }
    expect(held.setup.renderer.isDestroyed).toBe(true);
  });

  test("destroys it even when the check throws on the way out", async () => {
    // The reason teardown is a disposable and not a line at the end of the
    // check: a failing assertion leaves by a different door.
    let held: Rendered | null = null;
    await expect(
      (async () => {
        using shell = await mount(<Probe onUnmount={() => {}} />, { shape: SHAPE });
        held = shell;
        throw new Error("the assertion failed");
      })(),
    ).rejects.toThrow("the assertion failed");
    expect((held as Rendered | null)?.setup.renderer.isDestroyed).toBe(true);
  });

  test("unmounts the React tree rather than only destroying the renderer", async () => {
    // Destroying the renderer underneath a mounted tree leaves every effect
    // subscribed to something that no longer exists. React only runs cleanup on
    // unmount, so unmounting is the observation — the effect below says so.
    let unmounted = false;
    {
      using shell = await mount(
        <Probe
          onUnmount={() => {
            unmounted = true;
          }}
        />,
        { shape: SHAPE },
      );
      expect(await shell.frame("mounted")).toContain("mounted");
      expect(unmounted).toBe(false);
    }
    expect(unmounted).toBe(true);
  });

  test("releases what the tree subscribed to", async () => {
    // A subscription is the leak that survives both destroy and unmount when
    // the effect's cleanup is wrong, and it is the shape the rail actually uses.
    const listeners = new Set<() => void>();
    function Subscriber(): React.ReactNode {
      useEffect(() => {
        const listener = () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }, []);
      return <text>subscribed</text>;
    }

    {
      using shell = await mount(<Subscriber />, { shape: SHAPE });
      expect(await shell.frame("subscribed")).toContain("subscribed");
      expect(listeners.size).toBe(1);
    }
    expect(listeners.size).toBe(0);
  });

  test("notices a renderer that was not cleaned up", async () => {
    // The negative control. Without it every assertion above would pass against
    // a property that was simply always true, which is the failure mode a
    // cleanup check is most prone to.
    const leaked = await openRenderer({ shape: SHAPE });
    expect(leaked.renderer.isDestroyed).toBe(false);

    // And cleaned up by hand, because this check deliberately did not use the
    // scope that would have done it.
    leaked[Symbol.dispose]();
    expect(leaked.renderer.isDestroyed).toBe(true);
  });
});

describe("settling", () => {
  test("waits for the frame to stop changing when nothing was named", async () => {
    // The difference between "something is on screen" and "the shell finished
    // reacting". A predicate that returned the first painted frame would hand
    // back the state before the key on every check that presses one.
    using shell = await mount(<Probe onUnmount={() => {}} />, { shape: SHAPE });
    const first = await shell.frame();
    expect(hasPainted(first)).toBe(true);
    expect(await shell.frame()).toBe(first);
  });

  test("reports a marker that never arrives rather than returning what it has", async () => {
    using shell = await mount(<Probe onUnmount={() => {}} />, { shape: SHAPE });
    await expect(shell.frame("nothing draws this")).rejects.toThrow(/never settled/);
  });
});
