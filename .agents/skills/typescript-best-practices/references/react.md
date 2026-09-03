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

An effect is not defective merely because it sets state. Check whether it owns
an asynchronous request, subscription, or other lifecycle. Protect against
stale completion and release retained work:

```tsx
import { useEffect, useState } from "react";

type Profile = { readonly id: string; readonly name: string };
type ProfileState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly profile: Profile }
  | { readonly kind: "failed"; readonly message: string };

function useProfile(
  id: string,
  load: (id: string, signal: AbortSignal) => Promise<Profile>,
): ProfileState {
  const [state, setState] = useState<ProfileState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });

    void load(id, controller.signal).then(
      (profile) => {
        if (!controller.signal.aborted) {
          setState({ kind: "ready", profile });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : "Profile request failed";
        setState({ kind: "failed", message });
      },
    );

    return () => controller.abort();
  }, [id, load]);

  return state;
}
```

The transport must honor `AbortSignal`. The aborted check also prevents an old
completion from replacing current state after a dependency changes.

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
