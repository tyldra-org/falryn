# JSDoc and API comments

Use comments to preserve contracts the signature cannot express clearly.

## Include when relevant

- accepted units, ranges, normalization, or ordering;
- trust and validation boundary;
- side effects and ownership;
- cancellation and concurrency behavior;
- errors or typed failure outcomes;
- deprecation replacement and migration;
- a short example for a non-obvious generic or lifecycle.

```ts
/**
 * Reserves capacity until the returned release function is called.
 *
 * @param units - Positive integer units to reserve.
 * @param signal - Cancels only the pending reservation, not settled work.
 * @returns A release function that is safe to call once.
 * @throws {RangeError} When `units` is not a positive integer.
 */
export async function reserve(
  units: number,
  signal: AbortSignal,
): Promise<() => void> {
  // implementation
}
```

Avoid narrating implementation steps, promising complexity not measured by the code, or documenting private helpers merely to satisfy a coverage metric. Keep tags compatible with the repository's installed documentation tool.
