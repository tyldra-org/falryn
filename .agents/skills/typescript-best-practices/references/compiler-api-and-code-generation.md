# Compiler API and code generation

Use this reference for compiler API consumers, AST transforms, codemods,
language-service plugins, declaration tooling, and generated TypeScript.

## Resolve the API provider first

The `tsc` binary, editor language server, and importable compiler API can come
from different packages or major versions. Before reading an example or writing
tooling, inspect:

- the executable used for project checks;
- the package actually imported by the tool;
- the supported TypeScript range of lint, framework, and editor integrations;
- whether the tool uses public compiler APIs or internal module paths;
- the syntax and declaration versions the generated output must support.

TypeScript 7.0's native `typescript` package does not expose the established
TypeScript 6 compiler API. Tools that require that API may need the official
TypeScript 6 compatibility package or a documented tool-specific arrangement.
Verify current release notes because this boundary is expected to change after
7.0. Never assume CLI success proves API compatibility.

## Prefer the narrowest tool

Use syntax-aware search or the repository's established codemod tool for a
focused source migration. Reach for the compiler API when semantic information,
TypeScript parsing, declaration emit, or integration with the checker is the
actual requirement.

Do not depend on `typescript/lib` files, private node fields, internal symbols,
or undocumented enum values. Keep the imported API behind one small adapter so
a compiler upgrade has one migration point.

## Separate generation from checking

Generated code needs one authoritative input and deterministic output. Sort
unstable collections, normalize paths and line endings, and avoid timestamps or
machine-specific values unless the contract requires them.

Use the selected compiler's node factories and printer for generated syntax.
Do not expect the printer to preserve hand formatting or comments like a
source-preserving codemod. If preservation matters, use a tool designed for
source edits or keep generated files fully owned by the generator.

Generated declarations and source files should not become independent sources
of truth. Mark ownership, prevent hand edits, and regenerate them in the same
check that detects drift.

## Make transforms safe to rerun

- Parse with the script kind and language level that match the input.
- Preserve shebangs, directives, imports, comments, and file extensions when
  they are part of runtime behavior.
- Match nodes by meaning and local context, not raw text alone.
- Refuse ambiguous rewrites and report the file and reason.
- Run the transform twice and require the second run to produce no change.
- Typecheck and execute representative output under the target toolchain.

## Test integration boundaries

Use small fixtures for accepted syntax, rejected syntax, diagnostics, emit,
source maps, declarations, and module resolution. Add a real-project smoke test
when the tool depends on project references, plugins, framework-generated files,
or editor protocol behavior.

When an embedded-language framework or language-service plugin has not adopted
the native compiler API, keep its supported TypeScript version explicit. Do not
silence the mismatch or claim editor parity from command-line results.

## Review checks

- The API package and compiler binary are identified separately.
- All compiler imports use documented public entry points.
- Generated output is deterministic and has one source of truth.
- A second transform run is empty.
- Tests cover diagnostics and produced artifacts, not only AST shapes.
- Compiler upgrades include the linter, framework, editor, and generator
  compatibility matrix.
