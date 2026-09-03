# Falryn agent guidance

Falryn is a Bun and TypeScript terminal product. Keep changes small, explicit,
and supported by evidence.

## Scope

This file configures agents acting in the public Falryn repository. It is not a
requirement for human contributors or forks.

Canonical public and contributor documentation belongs in the companion
`falryn-docs` repository. This application repository owns code-adjacent
`CURRENT-STATE.md`, contributor controls, source comments, fixtures, and files
required to build or validate the product. Do not introduce product roadmaps,
detailed future designs, unannounced capabilities, or private research here.

## Before acting

1. Read applicable higher-priority instructions and this file.
2. Load the vendored skill required by the work from .agents/skills/.
3. Treat repository source, tests, and public current-state documentation as the
   evidence for a public claim.
4. Do not infer future product behavior from source names, open issues, or
   internal planning material.

## Stack

- TypeScript and TSX for product code.
- Bun for package management, scripts, tests, bundling, and compiled output.
- Biome for formatting and linting; TypeScript for type checking.
- React and OpenTUI for terminal UI.
- bun:sqlite with versioned SQL migrations for local state.
- One normal Bun process; external commands stay behind narrow, typed boundaries.

## Required skills

| Work | Skill |
| --- | --- |
| Non-trivial architecture, debugging, refactoring, migrations, concurrency, reliability, maintainability, or verification | engineering-best-practices |
| TypeScript, TSX, JavaScript, tests, build scripts, or tsconfig | typescript-best-practices |
| OpenTUI behavior, layout, input, rendering, or packaging | opentui-best-practices |
| Mutating Git work | git-workflow |
| GitHub issues, pull requests, Actions, Projects, or merge state | gh-cli |
| Local diff, branch, or pull-request review | change-review plus the relevant stack skill |
| Falryn Plan, Implement, Review, Verify, Merge, Deliver, Next, greetings, walkthroughs, or project-status routing | falryn-workflow |

Use the vendored skill appropriate to the checkout. Each `SKILL.md` is a compact
router; load only the deep reference that owns the task. The six portable skills
must not acquire Falryn product strategy. `falryn-workflow` is the sole
repository-specific exception. Keep all seven vendored bundles synchronized
with the maintainer-global copies through `.agents/skills/sync-from-global.sh`.

## Validation

- Run bun run check for ordinary source changes.
- Run bun run build for packaging, entrypoint, or compiled-output changes.
- Add focused validation with the behavior it protects.
- Treat automatically delivered diagnostics after an edit as actionable.
- Never bypass a failing hook.
