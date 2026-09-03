# Compiler and TypeScript projects

Use for compiler configuration, performance, module resolution, declarations, project references, migrations, and workspace layout. Diagnose before changing flags or tools.

## Workflow

1. Read the repository's runtime, package manager, TypeScript version, `tsconfig*`, package exports, workspace files, and existing scripts.
2. Reproduce through the repository typecheck before invoking `tsc` directly.
3. Classify the problem: configuration, resolution, declaration emit, type complexity, project graph, migration, or runtime/tool mismatch.
4. Gather focused evidence such as `--showConfig`, `--extendedDiagnostics`, `--generateTrace`, or `--traceResolution` only when relevant.
5. Change the smallest owning boundary and rerun the same measurement plus repository validation.

## Route one reference

| Concern | Reference |
| --- | --- |
| strictness, include/exclude, incremental, emit, runtime type stripping | [Compiler configuration](references/compiler-configuration.md) |
| slow checker, deep instantiation, large unions, mapped/conditional types | [Type performance](references/type-performance.md) |
| ESM/CJS, package exports, path aliases, declarations, module resolution | [Modules and declarations](references/modules-and-declarations.md) |
| compiler traces, reproducible timing, error diagnosis | [Diagnostics](references/diagnostics.md) |
| JS→TS, project references, monorepos, package-boundary migration | [Migrations and workspaces](references/migrations-and-workspaces.md) |
| runtime hot paths or async throughput | [Runtime performance](references/runtime-performance.md) |

## Guardrails

- Compiler flags describe contracts, not universal best settings. Match runtime and build ownership.
- `skipLibCheck`, `isolatedModules`, `isolatedDeclarations`, incremental state, and project references have specific trade-offs; do not present uncited speed percentages as universal results.
- TypeScript path aliases do not rewrite runtime imports by themselves.
- Do not clear caches until evidence suggests stale cache state; preserve a before/after measurement.
- Do not replace repository tooling merely because another tool is generally faster.
- A clean typecheck does not prove lint, tests, runtime behavior, declarations, or package exports.
