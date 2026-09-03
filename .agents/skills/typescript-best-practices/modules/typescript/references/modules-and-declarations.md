# Modules and declarations

Align TypeScript's view with the runtime, package manager, bundler, and published package contract.

## Diagnose resolution

Inspect:

- package `type`, `exports`, `imports`, and workspace links;
- `module`, `moduleResolution`, `verbatimModuleSyntax`, and file extensions;
- runtime/bundler resolution rules;
- generated declarations and consumer configuration.

Use `--traceResolution` only for the failing import and retain the decisive lines. TypeScript `paths` guide the compiler; they do not rewrite emitted or runtime specifiers by themselves.

## Boundaries

- Use `import type` where compiler settings preserve the distinction.
- Avoid import-time I/O or hidden registration.
- Treat barrels as intentional public surfaces, not mandatory folder furniture. Evaluate cycles, side effects, tree shaking, and build behavior in the actual toolchain.
- Break cycles by moving stable contracts or inverting dependencies, not by hiding the cycle behind a dynamic import.
- Use dynamic imports for a measured loading boundary or real optional dependency, not as a default style.

## Published packages

Validate:

- every exported path resolves in the built package;
- declarations reference reachable types and compatible module specifiers;
- ESM/CJS conditions match real artifacts;
- internal aliases do not leak into declarations;
- source maps and declaration maps point to shipped sources when promised.

Test at least one consumer-shaped import rather than relying only on the producer typecheck.
