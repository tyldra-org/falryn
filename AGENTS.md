# Falryn agent guidance

Falryn is a Bun and TypeScript terminal product. Keep changes small, explicit,
and supported by evidence.

## Scope

This file configures agents acting in the public Falryn repository. It is not a
requirement for human contributors or forks.

Public documentation belongs under docs/ and covers released or source-verified
behavior only. Do not introduce product roadmaps, detailed future designs,
unannounced capabilities, or private research into this repository.

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
| TypeScript, TSX, JavaScript, tests, build scripts, or tsconfig | typescript-best-practices |
| OpenTUI behavior, layout, input, rendering, or packaging | opentui |
| Mutating Git work | git-workflow |
| GitHub issues, pull requests, Actions, Projects, or merge state | gh-cli |
| Local diff, branch, or pull-request review | change-review plus the relevant stack skill |

Use the installed or vendored skill appropriate to the checkout. Portable skills
must remain portable and must not acquire Falryn product strategy.

## Validation

- Run bun run check for ordinary source changes.
- Run bun run build for packaging, entrypoint, or compiled-output changes.
- Add focused validation with the behavior it protects.
- Treat automatically delivered diagnostics after an edit as actionable.
- Never bypass a failing hook.

