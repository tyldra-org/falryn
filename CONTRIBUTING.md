# Contributing to Falryn

## Workflow

1. Use a GitHub issue for each meaningful feature, bug, or refactor.
2. Move an issue to Ready when its goal, scope, acceptance checks, and any
   dependency are clear.
3. Create a short-lived branch such as `feat/123-chat-composer`.
4. Open one focused pull request and include `Closes #123` in its description.
5. Record the checks actually run, merge, and let GitHub close the issue.

Use an issue checklist for small steps. Create sub-issues only when a child
item needs its own branch and pull request. Keep the hierarchy to one level.

## Documentation

User-facing or developer-facing documentation belongs in the companion
`falryn-docs` repository. Link any related docs pull request from the product
pull request; land both before calling a user-facing change complete.

## Checks

Run `bun run check` before submitting ordinary changes. It runs Biome,
TypeScript type-checking, and the Bun test suite. Run `bun run build` as well
when changing packaging, entry points, embedded assets, or runtime dependencies.
Use `bun run format` and `bun run lint:fix` for local automatic fixes.

## Keep it simple

Do not add roadmaps, phases, gates, evidence records, or duplicate status
documents. The GitHub Project tracks work; the code and its checks show what
works.
