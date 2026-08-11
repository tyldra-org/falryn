---
name: typescript-react-reviewer
description: Review TypeScript + React code for correctness, hooks misuse, state bugs, and maintainability. Use for PR reviews, React 19 patterns, useEffect abuse, state management checks, or TypeScript safety in React components.
---

# TypeScript + React Review

Defect-first review for React + TypeScript. Scan critical issues before style.

## Critical (block merge)

| Issue | Why |
| --- | --- |
| `useEffect` for derived state | Extra render, sync bugs |
| Missing effect cleanup | Leaks |
| Direct state mutation | Silent stale UI |
| Conditional hooks | Breaks Rules of Hooks |
| `key={index}` on dynamic lists | State corruption on reorder |
| Unjustified `any` | Safety bypass |
| `useFormStatus` in same component as `<form>` | Always pending=false |
| Promise created in render for `use()` | Infinite loop |

## High priority

| Issue | Impact |
| --- | --- |
| Incomplete dependency arrays | Stale closures |
| Props typed `any` | Runtime surprises |
| Unjustified `useMemo` / `useCallback` | Noise (unless Compiler / measured) |
| Missing Error Boundaries | Poor failure UX |
| Controlled input from `undefined` | React warnings |

## Architecture / style

| Issue | Prefer |
| --- | --- |
| Component ≫ 300 lines | Split |
| Prop drilling > 2–3 levels | Composition / context |
| State far from usage | Colocate |
| Custom hooks without `use` prefix | Rename |

## Quick detections

### Derived state / events in effects

```tsx
// Bad
useEffect(() => setFullName(firstName + " " + lastName), [firstName, lastName]);
// Good
const fullName = `${firstName} ${lastName}`;

// Bad: notify in effect on cart flag
// Good: notify in the click handler that mutates cart
```

### React 19

```tsx
// useFormStatus must be in a child of <form>
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      Send
    </button>
  );
}

// use() needs a stable promise (props/state), not fetch() in render
function View({ dataPromise }: { dataPromise: Promise<Data> }) {
  const data = use(dataPromise);
  return <>{data.id}</>;
}
```

### Mutations

```ts
// Bad
items.push(newItem);
setItems(items);
// Good
setItems([...items, newItem]);
```

### TypeScript red flags

```ts
const data: any = response; // bad
const App: React.FC<Props> = () => null; // avoid; prefer explicit props
const App = ({ prop }: Props) => null; // good
```

Prefer `noUncheckedIndexedAccess` so `arr[i]` is `T | undefined`.

## Review workflow

1. Critical table patterns
2. React 19 APIs — [react19-patterns.md](references/react19-patterns.md)
3. Server vs client state separation
4. TypeScript safety (generics, discriminants, strict config)
5. Maintainability (size, hooks, structure) — [checklist.md](references/checklist.md)

## State defaults

| Data | Prefer |
| --- | --- |
| Server/async | TanStack Query (don't mirror into `useState`) |
| Simple global UI | Zustand (or existing store) |
| Fine-grained atoms | Jotai (if already used) |
| Local UI | `useState` / `useReducer` |
| Forms | React 19 `useActionState` when applicable |

```ts
// Bad: copy query → local state
// Good: const { data: todos } = useQuery(...)
```

## Immediate flags

| Pattern | Fix |
| --- | --- |
| `eslint-disable react-hooks/exhaustive-deps` | Refactor |
| Component defined inside component | Hoist |
| `useState(undefined)` for text inputs | `""` |
| App-level barrel `index.ts` | Direct imports |

## References

- [react19-patterns.md](references/react19-patterns.md)
- [antipatterns.md](references/antipatterns.md)
- [checklist.md](references/checklist.md)

For Next.js App Router conventions → `modules/nextjs-react-typescript/GUIDE.md`.
