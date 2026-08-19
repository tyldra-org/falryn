# Vendored agent skills

Skills shipped **in this repository** so every checkout — contributor, fork, or
agent without a personal `~/.agents/skills` install — resolves the same guidance.
`AGENTS.md` points here first.

## Tiers

| Tier | Skills | Content | Where users get them |
| --- | --- | --- | --- |
| **Universal** | `git-workflow`, `gh-cli` | No project names; reusable on any repo | Vendored in `falryn/.agents/skills/` |
| **Stack** | `typescript-best-practices`, `opentui` | Tool/framework guidance | Vendored in repo |
| **Project loop** | `falryn-loop` | Falryn selectors; delegates to universal | Vendored in repo |

**Content rules:** universal skills never import Falryn product names. `falryn-loop` owns Falryn delivery selectors and **delegates** git/GitHub mechanics to the universal tier — it does not duplicate them.

**Distribution rule:** what lives under `.agents/skills/` in git is what users get.
Edit here (or sync into here before merge) when changing skills contributors should see.

**Precedence in a Falryn checkout:** repo vendored skills → this repo's `AGENTS.md`
→ personal/global agent guidance. Do not rely on `~/.agents/skills` being installed.

## Load gates

| Skill | Load before |
| --- | --- |
| `typescript-best-practices` | TypeScript, TSX, JS, tests, build scripts, or `tsconfig` work |
| `opentui` | Terminal UI, renderer, layout, input, keymaps, packaging |
| `git-workflow` | Mutating git work (commit, branch, rebase, push, recover) |
| `gh-cli` | GitHub `gh`: issues, PRs, Actions, Projects, merge, flags |
| `falryn-loop` | `Deliver — Target: …`, `Next — Target: Falryn Roadmap`, or "what next?" (maintainer delivery modes; optional for others) |

`git-workflow` owns git. `gh-cli` owns GitHub. Never substitute one CLI for
another. `git remote origin` is a remote name, not a product.

Falryn is GitHub-only (`tyldra-org/falryn`). Do not add Cursor Origin remotes.
`origin-cli` is not vendored here.

Optional global-only: `find-docs` (library API lookup) may live in personal
`~/.agents/skills/` until vendored. Prefer vendoring when a skill becomes part
of the default contributor path.

## Maintainer sync

When you maintain the same skill in personal `~/.agents/skills/` and ship it to
users, run from this directory:

```bash
./sync-from-global.sh          # pull universal + stack + falryn-loop from ~/.agents/skills
./sync-from-global.sh --dry-run
```

Or edit directly in `.agents/skills/` and commit — **the repo copy is canonical
for users.**

Delivery modes and `falryn-loop` are optional for contributors; see "Who this
file is for" in [`AGENTS.md`](../../AGENTS.md).
