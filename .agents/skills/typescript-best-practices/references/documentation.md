# Documentation

Document facts that a reader cannot recover cheaply from syntax. Keep prose
connected to code, tests, issues, or delivery evidence.

## Write useful API contracts

Document public APIs when misuse is plausible. Explain purpose, constraints,
units, nullability, failure, side effects, ownership, cancellation, examples,
and compatibility. Do not restate the function name or its TypeScript syntax.

```ts
/**
 * Starts watching a directory until the returned cleanup function is called.
 *
 * Rejects if the initial watcher cannot be created. Runtime watcher failures are
 * delivered to `onError`. Calling cleanup more than once has no effect.
 */
export async function watchDirectory(
  path: string,
  onError: (error: Error) => void,
): Promise<() => void> {
  return startPlatformWatcher(path, onError);
}

declare function startPlatformWatcher(
  path: string,
  onError: (error: Error) => void,
): Promise<() => void>;
```

Keep examples compiled or tested when practical. Remove stale comments when the
code changes instead of preserving false authority.

## Choose the right document

- Use a concise API comment for caller-facing behavior beside the declaration.
- Use a guide for workflows, integration steps, or several related examples.
- Use an ADR for a durable decision with meaningful alternatives or migration
  cost.
- Use tests, issues, and delivery records as implementation evidence.

Do not duplicate the same contract across comments, guides, and configuration.
Choose one owner and link to it where another reader needs context.

## Record architectural decisions

A useful ADR contains:

- status and date;
- context and constraints;
- the decision and its owner;
- alternatives considered;
- consequences and risks;
- verification and rollback or replacement conditions.

Repository code, tests, issues, and delivery records establish shipped behavior.
An ADR records the decision and points to that evidence.

## Maintain documentation with code

- Update public examples when signatures, defaults, or failure behavior change.
- Mark version-sensitive framework behavior and verify it against the installed
  version.
- Delete instructions for removed compatibility paths.
- Keep generated API documentation tied to the actual declaration source.
- Do not claim a feature is shipped because a design document describes it.

## Review checks

- Comments explain constraints, ownership, failure, or non-obvious behavior.
- Examples compile or have a named reason they cannot.
- One canonical location owns each fact.
- ADRs distinguish decisions from implementation evidence.
- Version-sensitive statements identify their authority.
- Removed APIs leave no stale examples or migration instructions.
