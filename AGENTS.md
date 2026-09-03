# Falryn agent guidance

Falryn is a Bun and TypeScript terminal product. Keep changes small, explicit,
and supported by evidence.

## Scope

This file configures agents acting in the public Falryn repository. It is not a
requirement for human contributors or forks.

Full product, architecture, and contributor documentation is maintained in the
private companion `falryn-docs` repository. The public application repository
owns code-adjacent `CURRENT-STATE.md`, public issue handoffs, contributor
controls, source comments, fixtures, and everything required to build and
validate the product. Public source, issue, and pull-request work must not
require private documentation or Roadmap access. Do not copy private roadmaps,
detailed future designs, unannounced capabilities, or research here.

## Before acting

1. Read applicable higher-priority instructions and this file.
2. Load the applicable vendored skill from `.agents/skills/`.
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

## Skill routing

| Work | Skill |
| --- | --- |
| TypeScript, TSX, JavaScript, tests, build scripts, or tsconfig | typescript-best-practices |
| OpenTUI behavior, layout, input, rendering, or packaging | opentui-best-practices |
| Mutating Git work | git-workflow |
| GitHub issues, pull requests, Actions, Projects, or merge state | gh-cli |
| Local diff, branch, or pull-request review | change-review plus the relevant stack skill |
| Falryn Plan, Implement, Review, Verify, Merge, Deliver, Next, greetings, walkthroughs, or project-status routing | falryn-workflow |

Use the vendored skill appropriate to the checkout. Each `SKILL.md` is a compact
router; load only the deep reference that owns the task. The five portable
vendored skills must not acquire Falryn product strategy. `falryn-workflow` is
the sole repository-specific exception and contains the complete public-checkout
workflow. Private Falryn Docs and Roadmap authority is an authenticated
maintainer addition, never a prerequisite for ordinary public work. This
checkout is authoritative for its vendored bundles. A global installation is an
optional convenience and must not become a public-checkout dependency.

## Validation

- Run bun run check for ordinary source changes.
- Run bun run build for packaging, entrypoint, or compiled-output changes.
- Add focused validation with the behavior it protects.
- Treat automatically delivered diagnostics after an edit as actionable.
- Never bypass a failing hook.
