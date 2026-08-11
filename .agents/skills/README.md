# Vendored agent skills

These are the skills an agent is expected to load when working on Falryn.
`AGENTS.md` names them; vendoring them here is what makes those references
resolve for anyone, rather than only on the maintainer's machine.

| Skill | Loaded before |
| --- | --- |
| `typescript-best-practices` | any TypeScript, TSX, test, build-script, or `tsconfig` change |
| `opentui` | any terminal UI, renderer, layout, input, or packaging change |
| `github-workflow` | any Git or GitHub change |
| `falryn-delivery-loop` | a `Deliver` or `Next` prompt |

None of this is a requirement for a contributor. It configures an agent working
here on the maintainer's behalf; see the "Who this file is for" note in
[`AGENTS.md`](../../AGENTS.md).
