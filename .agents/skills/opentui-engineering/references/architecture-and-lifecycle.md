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

Model starting, active, suspended and closing states only when they change
input or cleanup behavior. General state-model design belongs to engineering and
TypeScript guidance; here the important boundary is who currently owns the terminal.

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
