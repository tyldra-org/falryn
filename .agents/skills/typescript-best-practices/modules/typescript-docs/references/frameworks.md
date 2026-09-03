# Framework-facing documentation

Framework docs should describe the boundary users actually depend on, not reproduce a tutorial for the whole framework.

## React and Next.js

Document server/client ownership, serializable boundaries, loading/error behavior, and required route conventions. Do not copy current framework APIs from memory; verify the installed version and maintained documentation.

## Service frameworks

Document request validation, authentication/authorization boundary, stable error responses, side effects, and lifecycle ownership. Keep decorators or generated route metadata synchronized through the repository's own tooling.

## Libraries

Document exported entrypoints, runtime and module-system support, peer dependencies, declaration behavior, and migration from deprecated exports. Verify examples against a consumer-shaped compile or test.

## Validation

Prefer executable examples or focused tests where they add value. Generated API docs must be reproducible from committed source and configuration; inspect the output diff before publication.
