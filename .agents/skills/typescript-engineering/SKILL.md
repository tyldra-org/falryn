---
name: typescript-engineering
description: Implement and assess TypeScript, JavaScript and TSX contracts across types, runtime behavior, compiler tooling and package boundaries. Load framework references only when that framework is involved.
---

# TypeScript engineering

Own language, type-system, compiler, module and runtime compatibility decisions.
General engineering guidance owns architecture, ownership and change strategy;
`change-review` owns review method and reporting. Use this skill for the parts
whose correctness depends on TypeScript or its runtime ecosystem.

## Locate the changed contract

Inspect the repository's package manager, scripts, compiler, runtime, relevant
`tsconfig` and package exports. Read the lockfile or installed package when exact
versions matter. Refresh only facts affected by dependency or configuration changes.
Do not install a missing tool merely to inspect the project.

Choose the main risk: static type design, runtime validation, async behavior,
resolution, declarations, compiler integration or framework behavior. Load its
reference, adding another only for a distinct boundary. Framework guidance is
conditional; a Bun CLI task does not need browser or Next.js instructions.

Keep external values `unknown` until runtime evidence establishes their shape.
Types preserve that evidence; they cannot validate input or prove a side effect.
Do not silence a diagnostic through assertions or weakened options without
resolving its cause. Keep types readable and proportional to the contract.

## Choose the owning reference

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

## Prove the affected contract

Choose checks by what could break. Type fixtures test inference and rejected
programs; runtime tests exercise values and effects. Resolution, exports and
emission changes need an actual importing consumer. Compiler-API work needs that
integration exercised, not just a successful `tsc` invocation. Framework behavior
needs the owning framework's evidence.

Use the repository's required final checks. Reuse unaffected results only when
inputs and environment still match. Report the proof and material gaps through
the task's existing reporting format, without adding another completion checklist.

Exact APIs and version support come from installed exports and maintained
version-matched documentation. Examples explain a contract; validate them in the
chosen compiler/runtime before using them as implementation.
