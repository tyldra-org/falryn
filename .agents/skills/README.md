# Vendored agent skills

The checkout distributes five portable skills and two Falryn skills. Public
work can use them without a personal installation or private documentation.

| Responsibility | Skill |
| --- | --- |
| Git state and mutations | `git-operations` |
| GitHub operations | `github-operations` |
| Evidence-backed change assessment | `change-review` |
| TypeScript engineering | `typescript-engineering` |
| Terminal UI engineering | `opentui-engineering` |
| Selected Falryn work and manual command boundaries | [falryn-work](falryn-work/SKILL.md) |
| Next, parent ordering and private Project governance | [falryn-roadmap](falryn-roadmap/SKILL.md) |

The portable skills contain no Falryn strategy or repository policy. Git and
GitHub skills own state changes and evidence; `change-review` owns assessment.
TypeScript and OpenTUI add language and terminal contracts. General engineering
judgment comes from the global-only `software-engineering-discipline`, which is
not vendored or required of human contributors. The Falryn pair coordinates these
owners without duplicating their procedures. Load only what the request needs.
A local question or walkthrough is not a Roadmap operation.

## Resolve and maintain

Repository and user guidance precede skill defaults. These bundles are the
checkout's authoritative copies. Falryn Docs resolves them from its verified
sibling Falryn checkout, with installed global copies only as fallback. Keep the
two Falryn skills at matching revisions when distributing them.

Synchronize changed portable bundles with installed copies only after inspecting
their preimages. Preserve unrelated installed files and verify byte parity after
copying. The OpenTUI React reference uses the TypeScript React guide, so distribute
those compatible bundles together. Keep command names stable when ownership
changes; a skill update must not grant new publication or merge authority.

`falryn-work` owns the existing Plan, Implement, Review, Verify, Merge and
Deliver command meanings. `falryn-roadmap` owns Next and uses the repository's
canonical auditors. Private access is required only for the facts and operations
that depend on it. No skill or successful check grants additional authority.

Validate the Falryn pair with:

```sh
python3 -B .agents/skills/falryn-work/scripts/validate_skill.py
python3 -B .agents/skills/falryn-work/scripts/test_validate_skill.py
python3 -B .agents/skills/falryn-roadmap/scripts/test_select_next.py --falryn-root .
```

For portable skill maintenance, run the Git and GitHub bundle validators, check
all changed reference links, and forward-test relevant requests in temporary
fixtures. Validate changed code examples with their actual compiler or renderer.
Packaging checks do not prove behavior, and scenario evaluation does not prove
live GitHub effects.

The selector tests use synthetic private-format records and the real repository
auditor without querying GitHub. Structure checks prove packaging and links;
independent scenario evaluation checks command behavior and authority boundaries.
