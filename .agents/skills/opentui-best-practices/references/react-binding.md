# React terminal binding

React owns component identity and renderable reconciliation. OpenTUI owns terminal
cells, focus, input protocols, renderer scheduling and terminal restoration. Verify
the installed binding's public exports before crossing that boundary.

## Project state into terminal components

Use the [React guidance](../../typescript-best-practices/references/react.md) for
hooks, subscriptions, stale completion and state identity. Keep those rules in one
owner. An external feed must display the new store's snapshot when its prop changes,
even if that store has not emitted an event yet.

Do not assume browser DOM, CSS, event bubbling, hydration or accessibility behavior.
Use OpenTUI's intrinsic component, layout and focus contracts. Ref operations must
be supported by the binding; mutating framework-owned renderables directly can
bypass reconciliation.

React may own transient focus, viewport and selection state. Durable domain facts
remain with their application owner. Keep keymap registrations and retained effects
within a lifetime that releases them on replacement and unmount.

## Own the root lifetime

Use one React root per renderer ownership boundary. The application renderer owner
coordinates root unmount and renderer destruction on success and failure. Binding
helpers may already couple these operations; inspect that contract before adding a
second teardown path. Use the supported binding-aware test helper for tests.

Do not run another reconciler over the same tree during migration. Transfer one
tree owner, update consumers and remove the previous adapters.

## Prove terminal integration

Exercise prop changes, input/focus changes and repeated mount/unmount through the
binding. Assert the resulting terminal frame and relevant application effect.
Check released subscriptions and keymap layers after teardown; a correct frame
does not prove cleanup. Use [testing and debugging](testing-and-debugging.md) for
the renderer, pseudo-terminal and packaged proof boundaries.
