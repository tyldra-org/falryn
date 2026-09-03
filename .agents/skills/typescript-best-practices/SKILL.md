---
name: typescript-best-practices
description: TypeScript, JavaScript, and TSX engineering for implementation, review, debugging, compiler configuration, advanced types, migrations, React/Next.js typing, and public API documentation. Use repository scripts and installed-version documentation rather than generic tool defaults.
---

# TypeScript best practices

This is one skill with focused modules. Choose one primary module from the actual task and changed surface; load a second only for a distinct concern.

## Invariants

1. Inspect `package.json`, lockfile, `tsconfig*`, runtime, framework versions, repository guidance, and existing scripts before recommending syntax or tools.
2. Prefer the repository's package manager and validation commands. Do not run a package manager that may install missing tools merely to inspect a project.
3. Validate untrusted data at runtime; static types do not establish runtime truth.
4. Preserve strictness. Fix causes rather than adding broad assertions, `any`, ignored diagnostics, skipped tests, or weaker compiler options.
5. Keep types proportional to the problem. Prefer readable domain states and narrow boundaries over clever type-level machinery.
6. Distinguish compiler errors, lint findings, runtime behavior, framework contracts, and performance measurements; one does not prove another.
7. For current library, framework, or tool APIs, consult maintained documentation matching the installed version before changing code.

## Routing

| Task | Primary module |
| --- | --- |
| Ordinary TypeScript/JavaScript implementation, boundary validation, state, errors, or async work | [TypeScript core](modules/typescript-best-practices/GUIDE.md) |
| `tsconfig`, compiler performance, module resolution, declarations, project references, JS→TS migration, or monorepo diagnosis | [Compiler and projects](modules/typescript/GUIDE.md) |
| Generics, conditional/mapped/template-literal types, inference, brands, guards, or reusable type utilities | [Advanced types](modules/typescript-advanced-types/GUIDE.md) |
| JSDoc, TypeDoc, ADRs, or TypeScript public API documentation | [TypeScript documentation](modules/typescript-docs/GUIDE.md) |
| React + TypeScript defect review or hooks/state analysis | [React review](modules/typescript-react-reviewer/GUIDE.md) |
| Next.js App Router + TypeScript implementation or review | [Next.js](modules/nextjs-react-typescript/GUIDE.md) |

## Composition

- Pair core with compiler only when implementation changes compiler or package boundaries.
- Pair React or Next.js with core for a concrete language/runtime issue; do not load the compiler catalog for every component review.
- Pair advanced types with compiler only when compile cost or declaration behavior is part of the problem.
- Pair this skill with `change-review` when reviewing a diff; this skill owns stack correctness, while `change-review` owns evidence and severity.
- Pair with `engineering-best-practices` for non-trivial architecture, concurrency, migration, reliability, or verification design.

## Validation order

1. Run focused diagnostics for touched files when available.
2. Run the repository's typecheck.
3. Run focused tests and lint/format checks.
4. Run the build only when configuration, package boundaries, exports, framework compilation, or generated output may change.

Report exact commands and outcomes. If validation is unavailable or skipped, say so rather than implying success.
