# Vendored agent skills

Skills shipped in this repository so every checkout — contributor, fork, or
agent without a personal `~/.agents/skills` install — resolves the same portable
guidance. `AGENTS.md` points here first.

## Tiers

| Tier | Skills | Content | Where users get them |
| --- | --- | --- | --- |
| **Universal** | `git-workflow`, `gh-cli`, `change-review`, `engineering-best-practices` | No product or repo names; reusable in any repository | Vendored in `falryn/.agents/skills/` |
| **Stack** | `typescript-best-practices`, `opentui-best-practices` | TypeScript and terminal-UI guidance | Vendored in this repository |
| **Falryn workflow** | `falryn-workflow` | Maintainer modes, issue ownership, project orientation, and next-step routing | Vendored here and synchronized with the maintainer-global copy |

Universal skills must not mention Falryn, its organization, or local process.
Stack skills may describe their technology, but must remain useful outside this
repository. `falryn-workflow` is the deliberate project-specific exception.
Keep repository-local rules outside the portable skills.

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
./sync-from-global.sh          # preview content changes (ignores Finder metadata)
# Review the itemized diff, then apply it deliberately:
./sync-from-global.sh --apply
```

`--apply` uses `rsync --delete`; review the preview before applying it. The
helper syncs the six portable skills and the project-specific
`falryn-workflow` package. Do not add Falryn text to the portable skills.

The committed copy is canonical for people using this repository.
