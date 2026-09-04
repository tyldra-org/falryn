---
name: typescript-best-practices
description: TypeScript, JavaScript, and TSX engineering for implementation, review, debugging, compiler configuration, type-system design, runtime platforms, compiler tooling, async work, React and Next.js, package boundaries, migrations, testing, and documentation. Use for code or configuration whose correctness depends on TypeScript or its runtime ecosystem.
---

# TypeScript best practices

Use this bundle to make TypeScript code correct at both compile time and runtime.
It contains original guidance and examples, not copied or pinned vendor docs.
Resolve version-sensitive details against the packages installed in the target
repository.

This bundle was last audited on 2026-09-03 against TypeScript 7.0.2. That is a
maintenance marker, not a compatibility promise. The project-selected compiler,
runtime, and tool integrations remain authoritative.

## Start here

1. Inspect repository guidance, `package.json`, the lockfile, `tsconfig*`, the
   actual compiler binary, runtime, framework versions, and validation scripts.
   Check separately whether tools import the `typescript` package as an API.
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
- Do not treat `tsc` command compatibility as proof that compiler-API,
  language-service, linter, framework, or editor integrations are compatible.
- Choose who removes TypeScript syntax. The runtime, compiler, transpiler, and
  test runner must agree on accepted syntax and module specifiers.
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
| Node.js, Bun, Deno, browsers, workers, direct TypeScript execution, globals, or source maps | [Runtime platforms and type stripping](references/runtime-platforms-and-type-stripping.md) |
| Compiler API, AST transforms, codemods, language-service plugins, generated code, or TypeScript 6/7 tooling compatibility | [Compiler API and code generation](references/compiler-api-and-code-generation.md) |
| Module resolution, declarations, exports, ESM/CJS, package consumers | [Modules and packages](references/modules-and-packages.md) |
| Handwritten `.d.ts` files, untyped dependencies, global declarations, module augmentation, or JavaScript interop | [Declaration authoring and interop](references/declaration-authoring-and-interop.md) |
| React components, hooks, effects, state, identity, and performance | [React](references/react.md) |
| Next.js App Router, Server Components, route handlers, caching, and mutations | [Next.js](references/nextjs.md) |
| Runtime tests, type tests, review evidence, and failure-path proof | [Testing and review](references/testing-and-review.md) |
| JSDoc, API contracts, examples, ADRs, and documentation maintenance | [Documentation](references/documentation.md) |

## Validation ladder

Run only the levels relevant to the changed contract, in this order:

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
- Handwritten declarations match runtime behavior and do not hide unknown code
  behind broad ambient types.
- The chosen runtime or transform owns TypeScript syntax removal, and its syntax
  limits are tested.
- Tools that import TypeScript's programmatic API use a compatible package and
  do not depend on private compiler internals.
- Tests cover success plus relevant rejection, failure, cancellation, and
  migration paths.
