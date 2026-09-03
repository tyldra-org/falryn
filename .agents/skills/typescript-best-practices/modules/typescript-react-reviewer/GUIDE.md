# React and TypeScript review

Use with `change-review`: this guide owns React/TypeScript correctness, while `change-review` owns evidence, severity, and reporting. Judge severity from reachable consequences rather than pattern labels or numeric thresholds.

## Review order

1. Installed React/framework version and server/client model.
2. Hooks ordering, lifecycle, and external synchronization.
3. State ownership, transitions, and stale closures.
4. Runtime input validation and TypeScript soundness.
5. Accessibility, loading, empty, error, cancellation, and retry states.
6. Measured rendering or bundle performance.
7. Focused interaction and failure tests.

## Effects

Effects synchronize React with external systems. Derived render values usually belong in render; user-triggered effects usually belong in the event path that caused them.

```tsx
// Derived value: no effect or mirrored state needed.
const fullName = `${firstName} ${lastName}`;
```

An effect is not automatically defective because it sets state. Verify whether it coordinates an external subscription, asynchronous result, or lifecycle. Require cleanup for retained resources and protection against stale async results when relevant.

## Hooks and state

- Call hooks unconditionally at the top level, except APIs whose documented contract explicitly permits other placement.
- Keep state near its owner; lift or share it only when multiple consumers need one source of truth.
- Do not mutate state containers in place when React depends on identity to detect change.
- Avoid copying server/cache data into local state unless the copy has an explicit independent lifecycle.
- Use the repository's existing state and data libraries. Do not prescribe a new library merely from component size or nesting depth.
- Do not suppress hook dependency diagnostics without proving an equivalent invariant.

## Type boundaries

- Type props and exported callbacks explicitly where they form a public contract.
- Validate network, storage, URL, form, and postMessage input at runtime.
- Avoid broad `any`, unproved assertions, and optional fields that create impossible state combinations.
- `React.FC` is not inherently a defect; assess whether its semantics help or hinder the specific public API.
- Use stable domain keys for reorderable collections; an array index is valid only when identity and order are truly static.

## Performance

Do not require `memo`, `useMemo`, `useCallback`, virtualization, or component splitting from arbitrary line, duration, or item-count thresholds. First identify a measured render, interaction, memory, or bundle problem and its cause. Remove unnecessary memoization when it adds dependency risk without evidence.

## Version-sensitive APIs

Before reviewing `use`, actions, `useActionState`, `useFormStatus`, optimistic state, Server Components, or compiler-driven memoization, verify the installed React and framework documentation. `useFormStatus` observes a parent form and therefore belongs in a descendant. Promises consumed during render must have stable ownership rather than being recreated every render.

See [the focused checklist](references/checklist.md).
