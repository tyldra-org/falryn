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

`git-workflow` owns **git**. `gh-cli` owns **GitHub**. `origin-cli` (global at
`~/.agents/skills/origin-cli/`) owns **Cursor Origin** — generic; not Falryn-specific.
Never substitute one CLI for another. `git remote origin` is a remote name, not the Origin CLI.

**Global only (not vendored here):** `origin-cli` — Origin CLI syntax, mirror concepts, ruleset tier script. Install/login repair: Cursor built-in `origin` skill.

**Repo overlay:** [`.agents/ORIGIN-LAYOUT.md`](../ORIGIN-LAYOUT.md) — Falryn GitHub/Origin slugs, remotes, inbound mirror, active ruleset tier.

None of this is a contributor requirement. It configures an agent working here on the maintainer’s behalf; see “Who this file is for” in [`AGENTS.md`](../../AGENTS.md).
