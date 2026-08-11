# Vendored agent skills

Only `falryn-delivery-loop` lives here. It is Falryn-specific — it encodes this
repository's delivery contract and exists nowhere else — so vendoring it is what
makes `Deliver` and `Next` behave the same for anyone working on Falryn.

The other skills `AGENTS.md` requires (`typescript-best-practices`, `opentui`,
`github-workflow`) are **not** vendored. They are general-purpose and
third-party, and copying them here would have meant redistributing work this
repository does not own under its own licence, as well as making agent tooling
larger than `src/`. An agent supplies them from its own environment.

`.claude/skills/` holds a byte-identical copy, because the two tools read
different directories. `bun run verify:skills` fails if they diverge.

None of this is a requirement for a contributor. It configures an agent working
here on the maintainer's behalf; see the "Who this file is for" note in
[`AGENTS.md`](../../AGENTS.md).
