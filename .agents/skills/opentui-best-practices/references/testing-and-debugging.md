# Testing and debugging

Prove state transitions and lifecycle behavior before depending on visual
snapshots.

## Choose the terminal evidence

Use pure tests for domain commands, the installed test renderer for cells and
interaction, a pseudo-terminal for actual terminal modes and restoration, and
the compiled artifact for packaged resource resolution. Choose the levels the
change needs. They are not four mandatory stages for every UI edit.

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
binding contract. This example illustrates the test shape; supply the application
fixture and check helpers against the installed binding:

```tsx
import { testRender } from "@opentui/react/test-utils";
import { expect, test } from "bun:test";
import { act } from "react";

test("Escape closes the focused dialog", async () => {
  const setup = await testRender(<App initialDialog="help" />, {
    width: 80,
    height: 24,
    kittyKeyboard: true,
  });

  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Keyboard shortcuts");

    await act(async () => {
      setup.mockInput.pressEscape();
    });
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Keyboard shortcuts");
    expect(frame).toContain("Workspace");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
```

The explicit keyboard protocol makes Escape unambiguous for this interaction
test. Test legacy Escape disambiguation separately with the parser's clock and
timing contract; one immediate frame is not proof that deferred input settled.

Core tests use `createTestRenderer()` from `@opentui/core/testing`. Solid tests
use `testRender()` from `@opentui/solid`. Destroying the returned renderer
unmounts or disposes the binding root. Flush the binding's scheduled cleanup before
asserting that subscriptions have been released; a synchronous destroy call alone
may return before React passive cleanup finishes.

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

Use the task's review format to report the observed terminal behavior and gaps.
Keep package/runtime and terminal conditions with evidence that depends on them.
