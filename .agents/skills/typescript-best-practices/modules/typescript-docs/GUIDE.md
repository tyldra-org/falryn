# TypeScript documentation

Document public contracts, behavior, failure, and decisions without duplicating the implementation.

## Choose the owner

| Need | Owner |
| --- | --- |
| exported symbol contract and non-obvious invariant | source JSDoc/TSDoc |
| generated API navigation | TypeDoc or repository-selected generator |
| durable architectural decision and trade-offs | ADR |
| user task or operational flow | repository documentation |
| implementation evidence | tests, issue, or pull-request record—not prose claims |

## Workflow

1. Inspect the current public exports, docs tooling, repository conventions, and installed versions.
2. Document why, constraints, failure, examples, and migration—not restated syntax.
3. Keep examples minimal, typed, secret-free, and runnable when practical.
4. Use the repository's existing generator and lint rules. Consult maintained documentation matching the installed TypeDoc, JSDoc plugin, framework, and CI versions before adding configuration.
5. Generate or validate docs with repository commands and inspect the rendered result or output diff.

## Public API comments

```ts
/**
 * Parses one external account payload.
 *
 * @param input - Untrusted value from the transport boundary.
 * @returns A validated account or a typed rejection.
 * @remarks Does not persist or authorize the account.
 */
export function parseAccount(input: unknown): ParseResult<Account> {
  // implementation
}
```

Document thrown errors only when throwing is part of the contract. Use `@deprecated` with a replacement and removal/migration expectation. Avoid comments for obvious getters or parameter names.

## References

- [JSDoc and API comments](references/jsdoc.md)
- [Architecture decisions](references/adrs.md)
- [Framework-facing documentation](references/frameworks.md)

## Guardrails

- Never invent performance, security, adoption, or maintenance measurements.
- Never copy stale CI action versions or removed generator options into reusable guidance.
- Keep secrets, live tokens, private URLs, and personal data out of examples.
- Public docs ship with behavior changes when they are part of the same delivery outcome; repository-specific cross-repository ordering belongs to that repository's workflow.
