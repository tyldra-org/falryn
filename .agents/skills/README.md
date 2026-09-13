# Vendored agent skills

The checkout distributes five portable skills and two Falryn skills. Public
work can use them without a personal installation or private documentation.

| Responsibility | Skill |
| --- | --- |
| Git state and mutations | `git-workflow` |
| GitHub operations | `gh-cli` |
| Evidence-backed change assessment | `change-review` |
| TypeScript engineering | `typescript-best-practices` |
| Terminal UI engineering | `opentui-best-practices` |
| Selected Falryn work and manual command boundaries | [falryn-workflow](falryn-workflow/SKILL.md) |
| Next, parent ordering and private Project governance | [falryn-roadmap](falryn-roadmap/SKILL.md) |

The portable skills contain no Falryn strategy or repository policy. The Falryn
pair coordinates their use without duplicating their procedures. Load only the
owner needed for the request. A local question or walkthrough is not a Roadmap
operation. The global-only `software-engineering-discipline` supplies engineering
judgment and is not vendored or required of human contributors.

## Resolve and maintain

Repository and user guidance precede skill defaults. These bundles are the
checkout's authoritative copies. Falryn Docs resolves them from its verified
sibling Falryn checkout, with installed global copies only as fallback. Keep the
two Falryn skills at matching revisions when distributing them.

`falryn-workflow` owns the existing Plan, Implement, Review, Verify, Merge and
Deliver command meanings. `falryn-roadmap` owns Next and uses the repository's
canonical auditors. Private access is required only for the facts and operations
that depend on it. No skill or successful check grants additional authority.

Validate the Falryn pair with:

```sh
python3 -B .agents/skills/falryn-workflow/scripts/validate_skill.py
python3 -B .agents/skills/falryn-workflow/scripts/test_validate_skill.py
python3 -B .agents/skills/falryn-roadmap/scripts/test_select_next.py --falryn-root .
```

The selector tests use synthetic private-format records and the real repository
auditor without querying GitHub. Structure checks prove packaging and links;
independent scenario evaluation checks command behavior and authority boundaries.
