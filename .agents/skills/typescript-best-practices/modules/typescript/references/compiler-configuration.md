# Compiler configuration

Start from the repository's effective configuration:

```bash
<project-typecheck-command>
<typescript-binary> --showConfig
```

Use the project-local compiler binary and package-manager convention. Never invoke a package runner that may download TypeScript merely to inspect a checkout.

## Decision points

- **`strict` and related checks:** preserve existing strictness. Introduce stricter flags deliberately, one coherent group at a time, with migration evidence.
- **`include`, `files`, `exclude`:** bound the program to intended source. Remember imports can pull files into the program even when an exclude pattern names them.
- **`incremental`:** choose a stable ignored build-info path, verify cold and warm behavior, and do not commit machine cache unless repository policy explicitly does.
- **`skipLibCheck`:** can reduce checking of declaration files, but may hide conflicts in dependency types. Do not use it to silence application errors.
- **`isolatedModules`:** checks compatibility with single-file transpilation; it does not itself select or accelerate a transpiler.
- **`isolatedDeclarations`:** use only when the installed compiler and declaration pipeline support it; exported declarations may need explicit annotations.
- **`noEmit` versus emit:** align with whether TypeScript, a bundler, or another compiler owns output.
- **runtime type stripping:** use only syntax supported by the target runtime and the installed TypeScript version.

## Validation

Verify effective config, typecheck, declaration or build output when applicable, and the runtime entrypoint. Measure compiler changes on the actual repository; do not import benchmark percentages from unrelated projects.
