# Vendored agent skills

Skills shipped in this repository so every checkout — contributor, fork, or
agent without a personal `~/.agents/skills` install — resolves the same portable
guidance. `AGENTS.md` points here first.

## Tiers

| Tier | Skills | Content | Where users get them |
| --- | --- | --- | --- |
| **Portable universal** | `git-workflow`, `gh-cli`, `change-review`, `engineering-best-practices` | No product or repository policy; reusable across projects | Vendored in `.agents/skills/` |
| **Portable stack** | `typescript-best-practices`, `opentui-best-practices` | Version-aware TypeScript and terminal-UI guidance without Falryn policy | Vendored in `.agents/skills/` |
| **Falryn workflow** | `falryn-workflow` | Maintainer modes, issue ownership, project orientation, and next-step routing | Vendored here and synchronized with the maintainer-global copy |

All six portable skills must remain useful outside Falryn and must not contain
Falryn, organization, maintainer-home, or repository-local policy. Stack skills
may describe their technology. `falryn-workflow` is the sole deliberate
project-specific exception.

Each bundle has one compact `SKILL.md` router. Deep references are retained only
when they own a distinct concern. The TypeScript bundle consolidates overlapping
source material into six focused modules; the OpenTUI bundle keeps the complete
version-pinned upstream MDX snapshot plus three non-duplicating practice guides.

**Precedence in this checkout:** system and user instructions → repository-local
`AGENTS.md` / `CONTRIBUTING.md` → relevant vendored skill → personal or global
guidance as a fallback. Do not rely on `~/.agents/skills` being installed.

## Load gates

| Skill | Load before |
| --- | --- |
| `engineering-best-practices` | Non-trivial design, debugging, refactoring, migrations, concurrency, reliability, maintainability, or verification |
| `typescript-best-practices` | TypeScript, TSX, JS, tests, build scripts, or `tsconfig` work |
| `opentui-best-practices` | Terminal UI, renderer, layout, input, keymaps, or packaging work |
| `git-workflow` | Mutating git work: commit, branch, rebase, push, or recovery |
| `gh-cli` | GitHub `gh`: issues, pull requests, Actions, Projects, merge, or flags |
| `change-review` | Reviewing a local diff, branch, or pull request; pair with `gh-cli` for GitHub state and a stack skill for changed code |
| `falryn-workflow` | Falryn Plan, Implement, Review, Verify, Merge, Deliver, or Next modes; greetings, walkthroughs, status questions, and next-step routing |

`git-workflow` owns git. `gh-cli` owns GitHub. `change-review` owns
evidence-backed review reasoning. Never substitute one CLI for another.

Optional global-only: `find-docs` may remain in personal `~/.agents/skills/`
until it becomes part of the default contributor path.

## Maintainer sync

When maintaining a synchronized skill in personal `~/.agents/skills/` and
shipping it to users, run from this directory:

```bash
./validate-bundles.py              # validate committed structure and routes
./validate-bundles.test.py         # run focused positive and negative cases
./validate-bundles.py --source ~/.agents/skills  # include exact source parity
./sync-from-global.sh              # preview itemized content changes
./sync-from-global.test.sh         # isolated missing/preview/apply/check tests
./sync-from-global.sh --apply      # synchronize, then verify exact parity
./sync-from-global.sh --check      # verify parity without mutation
```

The helper preflights all seven source bundles and their declared identities
before any destination mutation. `--apply` uses `rsync --delete`, excludes
Finder metadata, and finishes with a recursive parity check. It fails rather
than silently skipping a missing bundle. Review the preview before applying.

The committed copy is canonical for people using this repository.
