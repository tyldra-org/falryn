# React

Resolve the installed React version and rendering model before applying an API
or performance rule.

## Review in dependency order

1. component and state ownership;
2. hook order, lifecycle, and external synchronization;
3. state transitions, stale closures, and async completion;
4. runtime validation at component boundaries;
5. loading, empty, error, cancellation, retry, and accessibility behavior;
6. measured rendering, interaction, memory, or bundle cost.

## Keep effects for synchronization

Derived values usually belong in render. User-triggered side effects usually
belong in the event path that caused them. Effects synchronize with an external
system.

An effect may own an asynchronous request or retained resource. Cancel prior
work and prevent stale completion after dependency changes. If data is keyed by
an ID, keep the key with the result and avoid displaying the previous ID's data
while the new effect has not run yet. Cancellation alone does not cover that
rendering interval. Test both the visible state and the eventual completion.

## Read external stores through their subscription contract

An external store can change between rendering and subscription, or the component
can receive a different store without that store emitting an event. Mirroring one
initial snapshot into `useState` does not cover those transitions. Use the installed
React subscription API when the source meets its contract:

```tsx
import { useSyncExternalStore } from "react";

type JobStatusValue = { readonly label: string };
type JobFeed = {
  readonly getSnapshot: () => JobStatusValue;
  readonly subscribe: (notify: () => void) => () => void;
};

export function useJobStatus(jobs: JobFeed): string {
  return useSyncExternalStore(jobs.subscribe, jobs.getSnapshot).label;
}
```

Keep the functions stable for each store and callable without a method receiver.
`getSnapshot` must return the same immutable snapshot while data is unchanged;
replace it when data changes and notify subscribers. `subscribe` returns cleanup.
Use the documented server-snapshot contract if the host renders on the server.
See React's [external-store contract](https://react.dev/reference/react/useSyncExternalStore).
Test source replacement, notification, the render/subscription boundary and cleanup.

## Preserve state semantics

- Call hooks unconditionally at the top level unless a documented API permits
  another placement.
- Keep state near its owner. Share it only when consumers need one source of
  truth.
- Do not mutate state containers when React relies on identity for updates.
- Avoid copying server or cache data into local state unless the copy has a
  separate editable lifecycle.
- Do not suppress hook dependency diagnostics without proving an equivalent
  invariant.
- Use stable domain keys for reorderable collections. Array indices fit only
  static identity and ordering.

## Measure before optimizing

Do not prescribe `memo`, `useMemo`, `useCallback`, virtualization, or component
splitting from arbitrary size thresholds. First identify a measured cost and its
cause. Unnecessary memoization can add dependency risk and reader load.

Verify installed-version documentation before changing `use`, actions,
`useActionState`, `useFormStatus`, optimistic state, Server Components, or
compiler-driven memoization.

## Review checks

- Component and state ownership are clear.
- Effects synchronize with external systems and release retained work.
- Async results cannot overwrite newer state.
- Props, callbacks, and external values keep runtime and static contracts aligned.
- Loading, empty, failure, cancellation, and retry states are usable.
- Performance changes have measurements and focused interaction tests.
