---
name: typescript-compiler
description: TypeScript compiler performance, tsconfig, type errors, async/module/memory rules. Use when optimizing tsc, fixing TS2322/TS2339 assignability errors, configuring tsconfig, or improving async and module organization. Not for language basics, React review, or docs.
---

# Compiler & Performance

Impact-ordered rule catalog for TypeScript performance, safety, and structure. Open only the reference files that match the task.

## When to apply

- Configuring or tuning `tsconfig.json`
- Slow `tsc` / language service
- Complex generics causing instantiation depth or assignability noise
- Async, imports, memory, or hot-path runtime issues

## Categories by priority

| Priority | Category | Impact | Prefix |
| --- | --- | --- | --- |
| 1 | Type system performance | CRITICAL | `type-` |
| 2 | Compiler configuration | CRITICAL | `tscfg-` |
| 3 | Async patterns | HIGH | `async-` |
| 4 | Module organization | HIGH | `module-` |
| 5 | Type safety patterns | MEDIUM-HIGH | `safety-` |
| 6 | Memory management | MEDIUM | `mem-` |
| 7 | Runtime optimization | LOW-MEDIUM | `runtime-` |
| 8 | Advanced patterns | LOW | `advanced-` |

## Table of contents

1. [Type System Performance](references/_sections.md#1-type-system-performance) — **CRITICAL**
   - 1.1 [Explicit return types on exports](references/type-explicit-return-types.md) — CRITICAL
   - 1.2 [Avoid deeply nested generics](references/type-avoid-deep-generics.md) — CRITICAL
   - 1.3 [Avoid large unions](references/type-avoid-large-unions.md) — CRITICAL
   - 1.4 [Extract conditional types to aliases](references/type-extract-conditional-types.md) — CRITICAL
   - 1.5 [Limit type recursion depth](references/type-limit-recursion-depth.md) — HIGH
   - 1.6 [Prefer interfaces over intersections](references/type-interfaces-over-intersections.md) — CRITICAL
   - 1.7 [Simplify complex mapped types](references/type-simplify-mapped-types.md) — HIGH
2. [Compiler Configuration](references/_sections.md#2-compiler-configuration) — **CRITICAL**
   - 2.1 [Include / exclude](references/tscfg-exclude-properly.md) — CRITICAL
   - 2.2 [Incremental compilation](references/tscfg-enable-incremental.md) — CRITICAL
   - 2.3 [isolatedDeclarations](references/tscfg-isolated-declarations.md) — CRITICAL
   - 2.4 [skipLibCheck](references/tscfg-skip-lib-check.md) — CRITICAL
   - 2.5 [strictFunctionTypes](references/tscfg-strict-function-types.md) — CRITICAL
   - 2.6 [erasableSyntaxOnly](references/tscfg-erasable-syntax-only.md) — HIGH
   - 2.7 [isolatedModules](references/tscfg-isolate-modules.md) — CRITICAL
   - 2.8 [Project references](references/tscfg-project-references.md) — CRITICAL
3. [Async Patterns](references/_sections.md#3-async-patterns) — **HIGH**
   - 3.1 [Annotate async return types](references/async-explicit-return-types.md) — HIGH
   - 3.2 [Avoid await in loops](references/async-avoid-loop-await.md) — HIGH
   - 3.3 [Avoid unnecessary async](references/async-avoid-unnecessary-async.md) — HIGH
   - 3.4 [Defer await](references/async-defer-await.md) — HIGH
   - 3.5 [Promise.all for independent work](references/async-parallel-promises.md) — HIGH
4. [Module Organization](references/_sections.md#4-module-organization) — **HIGH**
   - 4.1 [Avoid barrel imports](references/module-avoid-barrel-imports.md) — HIGH
   - 4.2 [Avoid circular dependencies](references/module-avoid-circular-dependencies.md) — HIGH
   - 4.3 [Control @types inclusion](references/module-control-types-inclusion.md) — HIGH
   - 4.4 [Dynamic imports](references/module-dynamic-imports.md) — HIGH
   - 4.5 [Type-only imports](references/module-use-type-imports.md) — HIGH
5. [Type Safety](references/_sections.md#5-type-safety-patterns) — **MEDIUM-HIGH**
   - 5.1 [noUncheckedIndexedAccess](references/safety-no-unchecked-indexed-access.md)
   - 5.2 [strictNullChecks](references/safety-strict-null-checks.md)
   - 5.3 [Prefer unknown over any](references/safety-prefer-unknown-over-any.md)
   - 5.4 [Assertion functions](references/safety-assertion-functions.md)
   - 5.5 [Const assertions](references/safety-const-assertions.md)
   - 5.6 [Exhaustive checks](references/safety-exhaustive-checks.md)
   - 5.7 [Type guards](references/safety-use-type-guards.md)
6. [Memory](references/_sections.md#6-memory-management) — **MEDIUM**
   - 6.1–6.5 under `references/mem-*.md`
7. [Runtime](references/_sections.md#7-runtime-optimization) — **LOW-MEDIUM**
   - 7.1–7.6 under `references/runtime-*.md`
8. [Advanced](references/_sections.md#8-advanced-patterns) — **LOW**
   - [Branded types](references/advanced-branded-types.md)
   - [satisfies](references/advanced-satisfies-operator.md)
   - [Template literal types](references/advanced-template-literal-types.md)

For migrations / monorepo diagnosis beyond these rules → `modules/typescript-expert/GUIDE.md`.

## External references

- [TypeScript Wiki — Performance](https://github.com/microsoft/TypeScript/wiki/Performance)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
