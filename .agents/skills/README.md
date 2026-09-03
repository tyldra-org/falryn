# Vendored agent skills

Falryn ships six skill bundles so a public checkout can resolve its normal repository guidance without private documentation, private Roadmap access, or a personal skill installation.

## Inventory

| Tier | Skills | Content |
| --- | --- | --- |
| Portable universal | `git-workflow`, `gh-cli`, `change-review` | General Git, GitHub, and change-review guidance reusable across repositories |
| Portable stack | `typescript-best-practices`, `opentui-best-practices` | Version-aware TypeScript and terminal-UI guidance without Falryn policy |
| Falryn workflow | `falryn-workflow` | Complete Falryn-specific public workflow plus explicit authenticated-maintainer gates for private docs and Roadmap operations |

The five portable skills must remain useful outside Falryn and must not contain Falryn, organization, maintainer-home, or repository-local policy. `falryn-workflow` is the sole project-specific exception.

`engineering-best-practices` is intentionally global-only. Falryn may use it when installed in a maintainer environment, but the public checkout neither vendors nor requires it.

Each bundle has one compact `SKILL.md` router. Deep references remain only when they own a distinct concern. The TypeScript bundle has six focused modules. The OpenTUI bundle keeps the complete version-pinned upstream MDX snapshot plus three non-duplicating practice guides.

## Resolution

In this checkout, apply system and user instructions first, then repository `AGENTS.md` and `CONTRIBUTING.md`, then the relevant vendored skill. A personal or global skill may add guidance only when it does not replace repository policy.

The Falryn workflow resolves public source, issue, and pull-request work locally. Private Falryn Docs and Roadmap information is used only after exact authenticated maintainer access is proven. Missing private authority produces an explicit unavailable result for private-only operations; it never causes a guessed fallback.

## Load gates

| Skill | Load before |
| --- | --- |
| `typescript-best-practices` | TypeScript, TSX, JavaScript, tests, build scripts, or `tsconfig` work |
| `opentui-best-practices` | Terminal UI, renderer, layout, input, keymaps, or packaging work |
| `git-workflow` | Mutating Git work: commit, branch, rebase, push, or recovery |
| `gh-cli` | GitHub issues, pull requests, Actions, Projects, merge, or exact flags |
| `change-review` | Reviewing a local diff, branch, or pull request; pair with `gh-cli` for GitHub state and a stack skill for changed code |
| `falryn-workflow` | Falryn Plan, Implement, Review, Verify, Merge, Deliver, or Next modes; greetings, walkthroughs, status questions, and next-step routing |

`git-workflow` owns Git. `gh-cli` owns GitHub. `change-review` owns evidence-backed review reasoning. Never substitute one CLI for another.

Optional global-only skills such as `engineering-best-practices` and `find-docs` remain personal maintainer resources unless separately admitted into the public distribution.

## Maintainer synchronization

Run from this directory:

```bash
./validate-bundles.py
./validate-bundles.test.py
./validate-bundles.py --source ~/.agents/skills
./sync-from-global.sh
./sync-from-global.test.sh
./sync-from-global.sh --apply
./sync-from-global.sh --check
```

The helper preflights all six distributed source bundles, their declared identities, and the complete visible and hidden destination bundle inventory before any destination mutation. Source-root, destination-root, and nested skill symlinks; source or destination paths containing parent (`..`) segments; non-regular source or vendored entries; destination Finder metadata; source- or destination-contained temporary storage; and incomplete shell or Python scans fail closed. Path operands are option-terminated before canonicalization, so leading-hyphen names cannot redirect traversal. It removes the retired vendored `engineering-best-practices` path only after complete preflight; only a symlink at that exact top-level retired destination may proceed to safe unlinking, while a nested symlink fails. It never reads, changes, or deletes the global-only source bundle. `--apply` uses checksum-based `rsync --delete`, excludes source Finder metadata from transfer, and finishes with a fresh recursive inventory and file/directory parity verification. `--check` fails on distributed drift, unknown bundle identities, symlinks, Finder residue, a retired destination bundle, or incomplete traversal.

With `--source`, the validator proves exact parity only for the six distributed bundles. The committed copy is canonical for people using this repository.
