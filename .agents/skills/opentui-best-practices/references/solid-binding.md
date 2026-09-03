# Solid binding

Use the Solid binding when Solid owns the terminal component tree. Read signals
where the binding tracks them and dispose effects, subscriptions, and resources
with their reactive owner.

## Follow Solid ownership

Do not transplant React hook or component lifecycle assumptions into Solid.
Avoid copying reactive values into parallel mutable fields only to make them
available to handlers.

Use the Solid owner to connect a subscription to cleanup:

```tsx
import { createEffect, createSignal, onCleanup } from "solid-js";

type JobStatusValue = { readonly label: string };
type JobFeed = {
  readonly current: () => JobStatusValue;
  readonly subscribe: (listener: (value: JobStatusValue) => void) => () => void;
};

function JobStatus(props: { readonly jobs: JobFeed }) {
  const [status, setStatus] = createSignal(props.jobs.current());

  createEffect(() => {
    const jobs = props.jobs;
    setStatus(jobs.current());
    onCleanup(jobs.subscribe(setStatus));
  });

  return <text>{status().label}</text>;
}
```

Verify intrinsic components, reactive helpers, cleanup timing, and renderer-root
APIs against the installed Solid binding. A similar name in the React binding
does not establish equivalent behavior.

## Preserve reactive identity

Keep signals with the owner that changes them. Derive values rather than
synchronizing copies. Do not create effects only to mirror one signal into
another unless the second value has a separate lifecycle.

Handlers should read current reactive state through supported accessors. Keep
blocking work outside reactive evaluation and send background results through
bounded state updates.

## Root lifecycle

Create one Solid root per renderer ownership boundary. Dispose the root before
destroying the renderer. Nested roots and plugin slots need independent owners
only when their lifetimes can actually diverge.

When changing bindings, migrate one tree owner at a time. Remove React-specific
or Core-specific adapters after the Solid path owns every caller.

## Review checks

- Signals and effects belong to one visible owner.
- Reactive evaluation contains no blocking or hidden external work.
- Subscriptions and retained resources register cleanup with that owner.
- Handlers read current state without maintaining a second mutable copy.
- The root is disposed before renderer destruction.
- React lifecycle assumptions have not been copied into Solid code.
