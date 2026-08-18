# Vendored agent skills

Skills an agent should load when working on Falryn. `AGENTS.md` points here so
references resolve for anyone with this checkout—not only the maintainer’s
personal `~/.agents/skills`.

| Skill | Load before |
| --- | --- |
| `typescript-best-practices` | TypeScript, TSX, JS, tests, build scripts, or `tsconfig` work |
| `opentui` | Terminal UI, renderer, layout, input, keymaps, packaging |
| `git-workflow` | Mutating git work (commit, branch, rebase, push, recover) |
| `gh-cli` | GitHub `gh` — issues, PRs, Actions, merge, flags |
| `falryn-delivery-loop` | `Deliver — Target: …`, `Next — Target: Falryn Roadmap`, or “what next?” (maintainer delivery modes; optional for others) |

`git-workflow` owns **git**. `gh-cli` owns **GitHub**. Never substitute one CLI
for another. `git remote origin` is a remote name, not a product.

Falryn is GitHub-only (`tyldra-org/falryn`). Do not add Cursor Origin remotes.
The global **`origin-cli`** skill stays installed for other projects; it is not
vendored here and is not part of Falryn work.

None of this is a contributor requirement. It configures an agent working here on the maintainer’s behalf; see “Who this file is for” in [`AGENTS.md`](../../AGENTS.md).
