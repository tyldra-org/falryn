# React review checklist

Use only checks relevant to the changed surface.

## Correctness

- Hooks execute in a stable documented order.
- External subscriptions, timers, observers, and requests have lifecycle ownership.
- Async results cannot overwrite newer state after dependency changes.
- State updates preserve React-visible identity where required.
- Controlled inputs do not switch uncontrolled accidentally.
- Lists use keys that represent stable item identity.
- Error, loading, empty, cancellation, and retry transitions are reachable and tested.

## Effects and events

- Effects synchronize with something outside render rather than mirror derived values without need.
- Event-caused side effects remain attached to the event path unless lifecycle semantics require an effect.
- Dependency arrays match values actually read; suppressions carry a proved invariant.
- Cleanup releases exactly the resource created by that effect instance.

## Types and boundaries

- Props, context, reducer actions, refs, and callbacks preserve intended variance and nullability.
- External input is runtime-validated.
- State unions exclude invalid field combinations.
- Assertions are narrow, local, and justified.
- Server/client or serializable boundaries match the installed framework.

## Performance and maintainability

- A performance finding cites profiler, trace, bundle, or reproducible interaction evidence.
- Memoization has a measurable owner and correct dependencies.
- Component splitting follows responsibility, lifecycle, reuse, or testability—not a line threshold.
- Shared state uses the repository's established solution unless evidence justifies migration.
- Direct imports, barrels, lazy loading, and code splitting are judged in the actual bundler.

## Tests

Prefer tests that exercise visible behavior and failure transitions over implementation-detail snapshots. Add regression evidence for changed hooks, focus/input, async races, server/client boundaries, and accessibility semantics.
