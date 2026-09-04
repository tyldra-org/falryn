# React binding

Use the React binding when React owns the terminal component tree. Create one
React root per renderer ownership boundary and let reconciliation own component
identity and renderable updates.

## Keep render pure

Render functions derive output from props, state, and context. Put external
subscriptions, timers, and retained resources in effects with complete cleanup.
Use stable keys for logical identity and refs only for documented imperative
operations.

Keep a subscription and its cleanup in the component that owns it:

```tsx
import { useEffect, useState, type ReactNode } from "react";

type JobStatusValue = { readonly label: string };
type JobFeed = {
  readonly current: () => JobStatusValue;
  readonly subscribe: (listener: (value: JobStatusValue) => void) => () => void;
};

function JobStatus({ jobs }: { readonly jobs: JobFeed }): ReactNode {
  const [status, setStatus] = useState(() => jobs.current());

  useEffect(() => jobs.subscribe(setStatus), [jobs]);

  return <text>{status.label}</text>;
}
```

This pattern requires `subscribe` to return its unsubscribe function. If the
source uses another contract, return an explicit cleanup callback from the
effect.

## Respect terminal semantics

Do not assume browser DOM, CSS, event bubbling, hydration, or accessibility
behavior. OpenTUI intrinsic components, layout rules, event contracts, focus,
and terminal capabilities are the authority.

Keep framework state separate from domain state. React may own focus, viewport,
selection, and transient interaction. It should project domain facts rather
than becoming their only storage location.

Avoid mirrored state for derived values. Do not suppress effect dependency
diagnostics without proving the replacement invariant. When async work depends
on props or state, cancel it or prevent stale completion from updating the
current tree.

## Root lifecycle

The renderer owner creates the React root, renders the application, and unmounts
the root before destroying the renderer. Repeated mount, unmount, failure, and
shutdown paths must release the same resources.

Do not run React and another reconciler over the same tree as a migration
strategy. Move one ownership boundary, update its callers and tests, then remove
the old root and adapters.

## Review checks

- One React root owns each reconciled tree.
- Render functions have no hidden I/O or mutation.
- Every retained effect returns cleanup.
- Keys represent domain identity rather than array position or layout.
- Refs use supported imperative operations and do not bypass reconciliation.
- Root unmount happens before renderer destruction.
