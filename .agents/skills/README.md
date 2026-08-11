# Vendored agent skills

Skills an agent should load when working on Falryn. `AGENTS.md` points here so
references resolve for anyone with this checkout—not only the maintainer’s
personal `~/.agents/skills`.

| Skill | Load before |
| --- | --- |
| `typescript-best-practices` | TypeScript, TSX, JS, tests, build scripts, or `tsconfig` work |
| `opentui` | Terminal UI, renderer, layout, input, keymaps, packaging |
| `github-workflow` | Git or GitHub mutations and delivery process |
| `gh-cli` | Exact `gh` subcommand / flag / JSON output recall |
| `falryn-delivery-loop` | `Deliver — Target: …`, `Next — Target: Falryn Roadmap`, or “what next?” (maintainer delivery modes; optional for others) |

`github-workflow` owns process and safety. `gh-cli` owns CLI syntax. Prefer both when composing non-trivial `gh` operations.

None of this is a contributor requirement. It configures an agent working here on the maintainer’s behalf; see “Who this file is for” in [`AGENTS.md`](../../AGENTS.md).
