# Testing and debugging

Prove state transitions and lifecycle behavior before depending on visual
snapshots.

## Test in layers

1. Test domain state and commands without OpenTUI.
2. Use the installed test renderer for component composition, frames, spans,
   input, focus, selection, scrolling, and resize.
3. Use a real pseudo-terminal for terminal modes, signals, raw input, cursor
   behavior, and restoration.
4. Test the compiled artifact when native resources or packaged path discovery
   are involved.

Every renderer test owns cleanup in a guaranteed finalization path. Repeated
mount, unmount, suspend, resume, and shutdown tests catch leaks that a single
successful render misses.

## Assert the right evidence

Assert semantic state before captured output. Frame assertions should use fixed
dimensions and include the smallest region that proves layout or styling. Avoid
large snapshots whose unrelated whitespace or color churn hides the actual
contract.

Interaction tests should send input through supported test helpers or the host
event boundary. Directly calling a component callback does not prove focus,
keymap precedence, paste parsing, or mouse hit testing.

One test should own the renderer, root, input, frame, and cleanup. This example
uses a representative React test shape. Confirm helper names against the
installed testing package:

```tsx
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { expect, test } from "bun:test";

test("Escape closes the focused dialog", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });

  try {
    const root = createRoot(setup.renderer);
    try {
      root.render(<App initialDialog="help" />);
      await setup.waitForFrame((frame) => frame.includes("Keyboard shortcuts"));

      setup.mockInput.pressEscape();
      const frame = await setup.waitForFrame(
        (next) => !next.includes("Keyboard shortcuts"),
      );

      expect(frame).toContain("Workspace");
    } finally {
      root.unmount();
    }
  } finally {
    setup.renderer.destroy();
  }
});
```

For resize behavior, drive the renderer instead of calling the layout selector
alone. Keep a separate pure test for the selector's exact breakpoints:

```ts
setup.resize(39, 7);
const frame = await setup.waitForFrame((next) => next.includes("needs at least"));
expect(frame).not.toContain("Workspace details");
```

## Diagnose from the first wrong fact

Record package versions, runtime, operating system, terminal identity,
capabilities, dimensions, and the smallest failing action. Then classify the
failure:

- wrong state or command;
- stale focus, selection, scroll, or layout;
- framework reconciliation or identity;
- renderer scheduling or terminal mode;
- native resource or packaged path; or
- cleanup and shutdown order.

Inspect installed exports before inventing an API or borrowing behavior from a
different OpenTUI release. Change the first owner that produces the wrong fact,
then rerun the focused reproduction and cleanup checks.

Measure performance with frame time, update count, retained resources, or
captured native statistics. A subjective report of flicker or lag identifies a
reproduction target, not a cause.

## Review checks

- Pure state and command tests cover outcomes without renderer timing.
- Renderer tests drive supported input, resize, focus, and frame boundaries.
- Every test unmounts its framework root and destroys its renderer after
  failure.
- Frame assertions use fixed dimensions and the smallest meaningful region.
- Pseudo-terminal tests own terminal modes, signals, cursor state, and
  restoration.
- Packaged tests start the produced artifact rather than a source entrypoint.
- Performance claims include a metric, workload, environment, and comparison.
