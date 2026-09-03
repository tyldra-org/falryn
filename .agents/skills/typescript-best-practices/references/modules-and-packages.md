# Modules and packages

TypeScript success does not prove that a runtime or consumer can load a package.
Align source imports, emitted JavaScript, declarations, package metadata, and the
actual loader.

## Resolve the whole chain

Inspect together:

- source extensions and import specifiers;
- package `type`, `exports`, and `imports`;
- compiler `module`, `moduleResolution`, and syntax-preservation options;
- runtime, bundler, and test-runner resolution rules;
- declaration output and source maps;
- workspace links and the packed or published artifact.

Avoid changing extensions or aliases until the failing layer is identified.
Compiler `paths` do not transform emitted imports unless another tool performs
that step.

## Keep boundaries explicit

- Use type-only imports where the effective config preserves their meaning.
- Avoid hidden import-time effects and registration.
- Treat a barrel as a deliberate API surface. Check cycles, side effects,
  tree-shaking behavior, and accidental exposure.
- Break cycles by relocating stable contracts or inverting dependencies. A
  dynamic import that only hides the cycle is not a structural fix.
- Use dynamic imports for a real loading boundary or optional dependency.
- Keep runtime-specific imports on the correct server, browser, worker, or edge
  side.

## Validate declarations as consumer contracts

Check that:

- every exported path resolves to an existing runtime artifact;
- declarations refer only to reachable types and valid specifiers;
- internal aliases do not leak into public declarations;
- ESM and CommonJS conditions match files that are actually produced;
- source and declaration maps point to shipped sources when promised;
- public types do not expose private dependency instances accidentally.

An ESM-only library can intentionally pair one type entry with one runtime
entry:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

This is an example shape, not a default. Add `require`, browser, development, or
platform conditions only when matching artifacts and consumer tests exist.
Condition order can affect which entry a tool selects.

## Test the artifact, not just the source

A producer typecheck can miss absent files, bad export conditions, source-only
aliases, and undeclared runtime dependencies. For a published boundary:

1. build from a clean state;
2. create the same archive or package that users receive;
3. inspect its file list and metadata;
4. install it into a clean temporary consumer;
5. import every promised entry point;
6. run both the consumer typecheck and representative runtime execution.

Use more than one consumer module mode only when the package claims to support
them.

## Review checks

- The compiler and runtime resolve each changed specifier the same way.
- Export conditions point to real files with matching formats.
- Declarations contain no private paths or inaccessible types.
- Runtime dependencies are declared in the correct package section.
- The packed artifact contains everything the public contract promises.
- A clean consumer validates both types and execution.
