# Runtime platforms and type stripping

Use this reference when TypeScript runs through Node.js, Bun, Deno, a browser,
a worker, a test runner, or another syntax-removal pipeline.

## Name the runtime contract

TypeScript checks a program. It does not decide which JavaScript features,
globals, module specifiers, files, permissions, or loaders exist at execution
time. Record these owners before changing code or configuration:

- the process or browser that executes the result;
- the tool that removes TypeScript syntax;
- the tool that resolves and possibly rewrites modules;
- the source of global declarations and web or host libraries;
- the owner of source maps, coverage, and stack traces.

Do not infer runtime support from a successful typecheck. Run the same entry
point, module mode, flags, permissions, and environment that production uses.

## Distinguish transform modes

A compiler or transpiler may emit JavaScript. A strip-only runtime removes type
syntax but does not lower TypeScript-only runtime constructs. When direct
execution matters, inspect the exact runtime version and enable
`erasableSyntaxOnly` when the project wants the compiler to reject syntax that a
strip-only path cannot execute.

Check these before choosing direct TypeScript execution:

- enums, parameter properties, value namespaces, and other syntax that requires
  runtime transformation;
- `.ts`, `.tsx`, `.mts`, and `.cts` entry and import rules;
- whether relative extensions need rewriting during emit;
- JSX transformation and the selected JSX runtime;
- decorators and any required metadata or helper emit;
- path aliases that the runtime does not understand;
- test-runner and production-loader differences.

Keep development and production on the same syntax contract. A dev loader that
accepts more than the release runtime creates failures after deployment.

## Partition host globals

Choose `lib` and `types` from the real execution environments. Avoid combining
DOM, Node.js, Bun, test-framework, and worker globals in one program merely to
silence missing names. Conflicting globals can make impossible code appear
valid.

Split projects or configuration when code targets different hosts. Keep shared
modules dependent on passed capabilities or standard APIs supported by every
claimed target. Put host-specific imports behind the host boundary that owns
them.

## Preserve runtime semantics

- Validate environment variables and configuration before domain use.
- Treat filesystem paths, URLs, streams, buffers, blobs, and request objects as
  host-specific contracts even when their TypeScript shapes look similar.
- Keep process signals, worker termination, unload events, and request
  cancellation tied to the resource owner.
- Confirm timer handle types against the selected libraries instead of forcing
  one host's handle type into shared code.
- Verify stack traces and source maps from the produced artifact, not only from
  the source runner.

## Review checks

- One named tool removes TypeScript syntax on every executed path.
- The compiler rejects syntax that the chosen strip-only runtime cannot run.
- Module specifiers resolve the same way in tests, development, and production.
- `lib` and ambient `types` describe the claimed host without unrelated globals.
- Host-specific capabilities stop at a boundary instead of leaking into shared
  domain code.
- The produced artifact reports usable source locations on failure.
