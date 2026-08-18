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

`github-workflow` owns process and safety. `gh-cli` owns **GitHub `gh` syntax only**.
`origin-cli` (global at `~/.agents/skills/origin-cli/`) owns **Cursor `origin` syntax only**.
Load **github-workflow** first for any mutating git/GitHub work; add **gh-cli** or
**origin-cli** when you need flag/RPC recall — never substitute one CLI for the other.

**Global only (not vendored here):** `origin-cli` — Origin CLI syntax, ruleset tiers (Tier 2 active, Tier 3 gated), mirror setup. Install/login repair: Cursor built-in `origin` skill.

None of this is a contributor requirement. It configures an agent working here on the maintainer’s behalf; see “Who this file is for” in [`AGENTS.md`](../../AGENTS.md).
