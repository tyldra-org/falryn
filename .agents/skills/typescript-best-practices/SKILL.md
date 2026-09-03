---
name: typescript-best-practices
description: TypeScript, JavaScript, and TSX engineering for implementation, review, debugging, compiler configuration, type-system design, async work, React and Next.js, package boundaries, migrations, testing, and documentation. Use for code or configuration whose correctness depends on TypeScript or its runtime ecosystem.
---

# TypeScript best practices

Use this bundle to make TypeScript code correct at both compile time and runtime.
It contains original guidance and examples, not copied or pinned vendor docs.
Resolve version-sensitive details against the packages installed in the target
repository.

## Start here

1. Inspect repository guidance, `package.json`, the lockfile, `tsconfig*`, the
   runtime, framework versions, and validation scripts.
2. Identify the trust boundary, domain contract, state owner, side effects,
   cancellation path, and package boundary touched by the task.
3. Load the one reference that owns the main risk. Load another only for a
   distinct compiler, framework, packaging, or verification concern.
4. Make the smallest change at the owning boundary. Preserve strictness unless
   changing it is the explicit task.
5. Prove compile-time behavior and runtime behavior separately.

## Non-negotiable rules

- Keep external data `unknown` until runtime validation establishes its shape.
- Make invalid states hard to represent, but keep types proportional and
  readable.
- Fix the source of a diagnostic. Do not reach first for `any`, assertions,
  ignored errors, skipped tests, or weaker compiler options.
- Treat cancellation, cleanup, ordering, concurrency limits, and partial effects
  as API behavior.
- Align TypeScript resolution, emitted JavaScript, declarations, package exports,
  the runtime, and the bundler.
- Verify current framework APIs and compiler flags against maintained
  documentation for the installed version.
- Use the repository's package manager and scripts. Do not invoke a command that
  may install an absent tool merely to inspect the project.

## Reference map

| Primary concern | Read |
| --- | --- |
| Runtime validation, domain states, public functions, errors | [Language and boundaries](references/language-and-boundaries.md) |
| Promises, cancellation, bounded concurrency, cleanup, runtime performance | [Async and runtime](references/async-and-runtime.md) |
| Generics, inference, brands, guards, mapped and conditional types | [Type-system design](references/type-system-design.md) |
| `tsconfig`, diagnostics, checker performance, project references, JS migration | [Compiler, projects, and migrations](references/compiler-projects-and-migrations.md) |
| Module resolution, declarations, exports, ESM/CJS, package consumers | [Modules and packages](references/modules-and-packages.md) |
| React components, hooks, effects, state, identity, and performance | [React](references/react.md) |
| Next.js App Router, Server Components, route handlers, caching, and mutations | [Next.js](references/nextjs.md) |
| Runtime tests, type tests, review evidence, and failure-path proof | [Testing and review](references/testing-and-review.md) |
| JSDoc, API contracts, examples, ADRs, and documentation maintenance | [Documentation](references/documentation.md) |

## Validation ladder

Run only the levels relevant to the changed surface, in this order:

1. focused compiler diagnostics or a type test;
2. focused runtime tests, including rejection and failure paths;
3. repository typecheck, lint, and formatting checks;
4. build or declaration generation for configuration, exports, or packaging;
5. consumer-shaped install or import tests for published contracts.

Report exact commands and outcomes. If a level is unavailable or skipped, state
that directly.

## Completion gate

- External values are validated before domain use.
- Types exclude the intended invalid states without concealing uncertainty.
- Async work defines ownership, ordering, capacity, cancellation, and cleanup.
- Runtime behavior, compiler behavior, and framework behavior were not confused.
- Resolution, emitted files, declarations, and exports agree.
- Tests cover success plus relevant rejection, failure, cancellation, and
  migration paths.
