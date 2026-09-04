# Core binding

Use Core when the application needs direct renderable ownership, a custom host,
or a narrow imperative tree. Core code owns construction, insertion, updates,
removal, and disposal.

## Keep ownership visible

Place tree mutations beside the state transition that requires them. A helper
should return an owner that updates and disposes the exact subtree it mounted.
Do not build an imitation reconciler around ordinary Core renderables.

Verify constructors, options, mutable properties, and disposal methods against
the installed Core version:

```ts
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";

function mountStatusPanel(renderer: CliRenderer) {
  const panel = new BoxRenderable(renderer, {
    border: true,
    flexDirection: "column",
    padding: 1,
  });
  const label = new TextRenderable(renderer, { content: "Starting" });

  panel.add(label);
  renderer.root.add(panel);

  return {
    update(message: string) {
      label.content = message;
    },
    dispose() {
      try {
        renderer.root.remove(panel);
      } finally {
        panel.destroyRecursively();
      }
    },
  };
}
```

The owner should not expose child renderables unless a caller genuinely owns an
imperative operation on them. Keep domain state and commands independent of
OpenTUI so tests can exercise behavior without a renderer.

## Custom renderables

Prefer existing renderables and composition before implementing a custom one. A
custom renderable owns its buffers, dirty state, clipping, hit regions, layout
inputs, and disposal. Keep parsing, I/O, and expensive preparation outside its
draw path.

If a custom renderable retains native or external resources, connect their
lifetime to the same owner that removes it from the tree. A successful removal
does not prove that native handles were released.

## Do not mix ownership models

Do not insert Core mutations behind a React or Solid reconciler unless the
binding explicitly exposes that operation. Portals, nested roots, and plugin
slots are separate ownership boundaries only when their lifetimes are genuinely
independent.

When moving from Core to a framework binding, migrate one owned subtree at a
time. Remove the old owner after all callers move. Never let two owners update
the same renderable tree.

## Review checks

- Every mounted subtree has one updater and one disposal path.
- Removal and recursive destruction both occur after partial failure.
- Renderables do not conceal domain behavior or blocking work.
- Custom drawing respects clipping, dirty state, hit regions, and cell bounds.
- No framework-owned renderable is mutated behind its reconciler.
