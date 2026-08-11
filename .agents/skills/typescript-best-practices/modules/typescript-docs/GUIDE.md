---
name: typescript-docs
description: Generate TypeScript documentation with JSDoc, TypeDoc, and ADRs. Use when documenting public APIs, setting up docs CI, writing architectural decision records, or applying framework-specific doc patterns (NestJS, Express, React, Angular, Vue).
---

# TypeScript Documentation

Layered docs: JSDoc in source → TypeDoc for API reference → ADRs for decisions.

## Quick reference

| Tool | Purpose | Command |
| --- | --- | --- |
| TypeDoc | API docs | `npx typedoc` |
| ESLint JSDoc | Validate comments | project eslint / `eslint --ext .ts src/` |
| Compodoc | Angular docs | `npx compodoc -p tsconfig.json` |

Useful tags: `@param`, `@returns`, `@throws`, `@example`, `@remarks`, `@see`, `@deprecated`.

## Workflow

### 1. TypeDoc

```bash
npm install --save-dev typedoc typedoc-plugin-markdown
```

```json
{
  "entryPoints": ["src/index.ts"],
  "out": "docs/api",
  "plugin": ["typedoc-plugin-markdown"],
  "excludePrivate": true,
  "readme": "README.md"
}
```

### 2. JSDoc on public surface

```ts
/**
 * Authenticates a user and returns access tokens.
 *
 * @param credentials - Login credentials
 * @returns Authentication result with tokens
 * @throws {InvalidCredentialsError} When credentials are invalid
 *
 * @example
 * ```ts
 * const token = await authService.login(email, password);
 * ```
 */
export async function login(
  credentials: LoginCredentials
): Promise<AuthResult> {
  // ...
}
```

Document **why**, generics constraints, and errors—not obvious getters.

### 3. ADR

```markdown
# ADR-001: Title

## Status
Accepted

## Context
What forces the decision?

## Decision
What we will do.

## Consequences
What gets easier / harder.
```

### 4. CI

Generate + validate docs on `src/**` and `docs/**` changes. Prefer existing project workflows over inventing new ones.

### 5. Validate

Enable JSDoc ESLint rules the repo already uses (or add minimal `jsdoc/require-*` rules). Fix until clean before shipping.

## Examples

See [references/examples.md](references/examples.md) for React hooks, utilities, and NestJS controllers.

## Practices

1. Public APIs only (exclude private via TypeDoc / `@internal`)
2. Runnable `@example` blocks for non-trivial APIs
3. `@throws` + `@deprecated` with migration notes
4. Never put secrets in docs
5. Keep docs in the same PR as behavior changes

## References

- [jsdoc-patterns.md](references/jsdoc-patterns.md)
- [framework-patterns.md](references/framework-patterns.md)
- [adr-patterns.md](references/adr-patterns.md)
- [pipeline-setup.md](references/pipeline-setup.md)
- [validation.md](references/validation.md)
- [typedoc-configuration.md](references/typedoc-configuration.md)
- [examples.md](references/examples.md)
