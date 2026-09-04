# Architecture and lifecycle

Keep terminal ownership visible and keep product behavior usable without a
renderer.

## Choose the binding deliberately

- Use Core when the application needs direct renderable ownership, a custom
  host, or a narrow imperative tree.
- Use React or Solid when the application already uses that binding or benefits
  from declarative composition and its lifecycle model.
- Do not mix framework roots in one render tree or mutate a framework-owned
  renderable outside the binding contract.

## Separate product and UI state

Domain state should not import OpenTUI or depend on terminal dimensions. Project
domain facts into a UI model that owns focus, viewport, expansion, selection,
and transient rendering state. Keep commands distinct from key bindings so the
same behavior can be tested or exposed through another interface.

Do not maintain parallel booleans for coupled lifecycle states. Use one explicit
state model for starting, active, suspended, cancelling, failed, and closed
behavior when those distinctions affect cleanup or input.

For example, keep impossible lifecycle combinations out of the type:

```ts
type UiState =
  | { readonly kind: "starting" }
  | { readonly kind: "active"; readonly selection: string | null }
  | { readonly kind: "suspended"; readonly selection: string | null }
  | { readonly kind: "closing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "closed" };

type UiEvent =
  | { readonly type: "ready" }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "suspend" }
  | { readonly type: "resume" }
  | { readonly type: "close" }
  | { readonly type: "fail"; readonly message: string };

function update(state: UiState, event: UiEvent): UiState {
  if (event.type === "fail") return { kind: "failed", message: event.message };
  if (event.type === "close") return { kind: "closing" };
  if (state.kind === "starting" && event.type === "ready") {
    return { kind: "active", selection: null };
  }
  if (state.kind === "active" && event.type === "select") {
    return { ...state, selection: event.id };
  }
  if (state.kind === "active" && event.type === "suspend") {
    return { kind: "suspended", selection: state.selection };
  }
  if (state.kind === "suspended" && event.type === "resume") {
    return { kind: "active", selection: state.selection };
  }
  return state;
}
```

## Own the lifecycle once

The composition owner creates the renderer, mounts the framework root, starts
producers, and tears them down in the reverse dependency order. Cleanup belongs
in a guaranteed finalization path and must cover partial startup.

Shutdown should:

1. stop accepting new user effects;
2. cancel or settle producers with bounded waiting;
3. unmount the framework tree and release subscriptions;
4. destroy the renderer and restore terminal state; and
5. report incomplete cleanup without forcing a false success.

Suspension is a temporary transfer of terminal ownership. Pause rendering and
input, preserve only state that remains valid, then force a coherent repaint on
resume. Do not create a second renderer merely to run a prompt or subprocess.

A React host can make ownership visible with one guarded cleanup path. Verify
the exact renderer options and root API for the installed release:

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

export async function runTerminalApp(
  node: ReactNode,
  untilExit: Promise<void>,
): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  try {
    const root = createRoot(renderer);
    try {
      root.render(node);
      await untilExit;
    } finally {
      root.unmount();
    }
  } finally {
    renderer.destroy();
  }
}
```

## Protect the host loop

Rendering, resize handling, and keystroke dispatch must not perform blocking
I/O, unbounded traversal, or synchronous plugin calls. Feed background results
through bounded queues or immutable snapshots. Coalesce replaceable visual
updates, but publish semantic state changes such as failure or cancellation
without hiding them behind a frame cadence.

## Review checks

- Renderer creation and terminal restoration have one visible owner.
- Partial startup and teardown failures still release every resource they can.
- Domain commands can run in tests without constructing an OpenTUI renderer.
- Suspend and resume preserve valid state without creating a competing root.
- Background work has cancellation, capacity, and a defined shutdown outcome.
