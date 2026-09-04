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

One test should own the renderer, binding root, input, frame, and cleanup. Use
the binding-aware test helper so framework updates and teardown follow the
binding contract. This React example matches the 0.5.10 entry point. Confirm it
against the installed release:

```tsx
import { testRender } from "@opentui/react/test-utils";
import { expect, test } from "bun:test";

test("Escape closes the focused dialog", async () => {
  const setup = await testRender(<App initialDialog="help" />, {
    width: 80,
    height: 24,
  });

  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Keyboard shortcuts");

    setup.mockInput.pressEscape();
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Keyboard shortcuts");
    expect(frame).toContain("Workspace");
  } finally {
    setup.renderer.destroy();
  }
});
```

Core tests use `createTestRenderer()` from `@opentui/core/testing`. Solid tests
use `testRender()` from `@opentui/solid`. Destroying the returned renderer
unmounts or disposes the binding root.

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

## Use deterministic diagnostics

Use `ManualClock` for timers, animation, repeat input, and debounce behavior.
Set explicit terminal capabilities for color, keyboard protocol, and fallback
tests. Use `TestRecorder` only when frame sequence or timing is the contract,
and stop it before renderer destruction. Keep Tree-sitter work behind the
testing mock when a test needs deterministic highlight completion.

Use the console overlay for logs that would otherwise corrupt terminal output.
Keep production logs and captured values bounded, and redact secrets before they
enter the overlay. For rendering stalls, inspect scheduler state, frame counts,
cell updates, memory, and the debug overlay before changing frame cadence.

## Review checks

- Pure state and command tests cover outcomes without renderer timing.
- Renderer tests drive supported input, resize, focus, and frame boundaries.
- React and Solid tests use their binding-aware `testRender()` entry points.
- Every test unmounts its framework root and destroys its renderer after
  failure.
- Frame assertions use fixed dimensions and the smallest meaningful region.
- Pseudo-terminal tests own terminal modes, signals, cursor state, and
  restoration.
- Packaged tests start the produced artifact rather than a source entrypoint.
- Performance claims include a metric, workload, environment, and comparison.
- Time-sensitive tests use a manual clock instead of wall-clock sleeps.
- Console and rendering diagnostics remain usable without corrupting the live
  terminal region or exposing sensitive values.
