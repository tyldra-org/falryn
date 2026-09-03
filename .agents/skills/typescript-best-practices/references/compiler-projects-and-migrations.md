# Compiler, projects, and migrations

Treat `tsconfig` as executable build configuration. Read the effective
configuration before changing an option because inheritance, command-line
flags, framework tooling, and referenced projects can alter the result.

## Establish the toolchain

Inspect:

- the installed TypeScript version and the binary invoked by repository scripts;
- runtime and bundler versions;
- all `tsconfig*` files and their `extends` chains;
- package `type`, exports, workspace links, and generated files;
- typecheck, build, test, lint, and declaration commands.

Use the project-local compiler. `--showConfig` can reveal the resolved
configuration, but it does not prove runtime resolution or build output.

## Choose options from runtime behavior

- Match `module` and `moduleResolution` to the loader or bundler.
- Choose `target` and `lib` from supported runtime capabilities.
- Use `verbatimModuleSyntax` and type-only imports consistently with the module
  strategy.
- Include only required global type packages. Uncontrolled ambient types can
  silently change every source file.
- Keep `include`, `exclude`, `rootDir`, and output ownership intentional.
- Remember that `paths` guides TypeScript resolution. It does not rewrite
  emitted specifiers by itself.

A library may separate checking, declarations, and runtime bundling, but each
output still needs one owner:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

This is an example, not a universal base config. Confirm that the installed
compiler and downstream tools support every option and output shape.

## Diagnose one layer at a time

Classify the failure before changing configuration:

1. syntax or static assignability;
2. ambient or declaration ownership;
3. compiler module resolution;
4. emitted JavaScript shape;
5. runtime or bundler resolution;
6. framework-generated contract;
7. lint or formatter policy.

Use focused compiler evidence only when it answers a concrete question:

- `--showConfig` for inherited configuration;
- `--traceResolution` for a failing import;
- `--listFiles` or `--explainFiles` for unexpected program membership;
- `--extendedDiagnostics` for checker and program-size counters;
- `--generateTrace` for a bounded deep performance investigation.

Preserve the command's exit status and decisive diagnostics. Trace output can be
large or sensitive, so use a temporary location and retain only needed evidence.

## Control checker cost

Measure before simplifying a useful contract. Common costs include huge
generated unions, deeply recursive conditional types, repeatedly expanded
anonymous intersections, duplicated library graphs, and accidental program
inclusion.

- Name reusable complex types.
- Cap recursion and generated combinations.
- Reduce the included program before weakening `strict` behavior.
- Fix duplicate dependency versions or ambient packages at their owner.
- Compare diagnostics under the same compiler version and program inputs.

## Use project references for real boundaries

Project references fit package ownership, build order, declaration ownership,
or incremental isolation. Several folders alone do not justify them.

Each referenced project needs coherent source and output ownership plus
compatible `composite`, declaration, root, and package-export settings. No two
projects should write the same output file.

## Migrate JavaScript in verifiable slices

1. Capture the runtime and build baseline.
2. Introduce TypeScript through the existing toolchain.
3. Enable JavaScript inclusion or checking only where needed.
4. Type external input and public boundaries before internals.
5. Rename modules in slices that preserve runtime resolution.
6. Tighten strictness with explicit diagnostics and tests.
7. Delete temporary declarations and adapters after their last caller migrates.

Keep temporary compatibility at one tested boundary:

```ts
type LegacyUser = {
  readonly user_id: string;
  readonly display_name?: string;
};

type User = {
  readonly id: string;
  readonly name: string | null;
};

export function migrateLegacyUser(value: LegacyUser): User {
  return {
    id: value.user_id,
    name: value.display_name ?? null,
  };
}
```

New callers consume `User`, not the legacy shape. Delete the adapter only after
the last legacy reader and persisted value have migrated. Avoid broad ambient
declarations that turn an unknown package into `any`.

## Review checks

- The effective config supports the intended behavior.
- Runtime, bundler, test runner, and compiler agree on module semantics.
- Strictness changes follow a contract instead of avoiding diagnostics.
- Every output file has one project owner.
- Performance claims include comparable compiler evidence.
- Migration shims have named callers, tests, and a removal condition.
