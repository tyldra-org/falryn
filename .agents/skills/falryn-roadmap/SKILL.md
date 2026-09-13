---
name: falryn-roadmap
description: Select one next Falryn Roadmap issue or maintain authenticated Project readiness, dependencies, ordering and state. Use for Next, Roadmap selection, parent sequencing or Project governance, not ordinary questions or public work outside the Project.
---

# Falryn Roadmap

This skill owns work selection and private planning state. The repository auditors
own deterministic validity and order. [falryn-work](../falryn-work/SKILL.md)
owns delivery of the selected outcome. An audit or recommendation never starts it.

## Select work with Next

Accept `Next - Target: Falryn Roadmap`, scoped Next targets and unambiguous
requests to choose the next work. Keep Next read-only. A greeting, explanation,
PR status question or request to continue known work does not select new work.

1. Establish authenticated access to Project 1 and both canonical repositories
   under [audits](references/audits.md). Resolve the current gh account.
2. Obtain the required clean audit generation. Broad Next uses the whole generated
   list. Explicit issue, parent or release scope filters that list. Conversation
   history never silently changes a broad request into a prerequisite chain.
3. Run the selector below. It replays the canonical Roadmap auditor, then keeps
   generated order while filtering ownership, scope and open blockers. It never
   reimplements priority or dependency sorting.
4. Recheck the candidate's live owner, issue state, native blockers and delivery
   PRs. If routing facts changed, capture a new generation and select again.
5. Report one issue, its original position, why it is actionable and its next
   prompt. Prefer an existing verified delivery PR, qualified with `Docs` when
   appropriate. Never choose among competing PRs without resolving ownership.

```bash
python3 <skill-root>/scripts/select_next.py \
  --falryn-root <verified-falryn-checkout> \
  --snapshot <private-roadmap-snapshot> \
  --owner <authenticated-login>
```

For explicit scope, add `--scope tyldra-org/falryn#N` for an issue or parent tree,
with the actual repository identity, or `--target-release <exact-private-name>`.
Both filters may apply. For an exact range, use `--target-release <first>` with
`--through-release <last>`. Bounds are inclusive in the audited option order;
unknown or reversed bounds are rejected. This filters one sequence, not several
independently ranked runs. Verify of a range assesses every required issue in
that catalog interval; it does not deliver the selector's single recommendation.

The selector returns `candidate`, `decision-required`, `none` or `audit-failed`.
Ready and Needs Planning candidates both enter Deliver. Needs Decision stops at
its named human owner; do not bypass it for later Ready work. No owned unblocked
candidate means no recommendation. Explain the returned skipped counts or scoped
blockers without dumping the backlog. Out-of-scope prerequisites need explicit
resolution, not a silently expanded target.

Keep the snapshot generation in the private report. End with one copy-ready
`Suggested next prompt: Deliver - Target: ...`, or `Suggested next prompt: none`
and the actual prerequisite. The selector proves captured state only, never live
readiness, permission to act or completed acceptance.

## Continue known work

A user continuing a known delivery keeps that target through falryn-work.
In Progress status and parent activity alone do not establish continuation intent.
Several assigned or active issues in broad Next still use the generated order.

Parent selection uses the same audited order within the parent. A parent outcome
is not a branch. A one-child request does not become a chain. An explicitly
requested chain settles each child before selecting again. Follow
[delivery's parent rules](../falryn-work/references/work.md#parent-outcomes).

## Maintain the Roadmap

Use [governance](references/governance.md) for adoption, readiness and transitions,
and [audits](references/audits.md) for exact commands and refresh scopes. Read
field implementation only when changing its contract. An explicit maintenance
request may repair records within scope; Next reports diagnostics without editing.

Keep private Project values, issue bodies and snapshots out of public artifacts.
Missing authority makes only the dependent operation unavailable. Do not guess
private order or impose Project fields on ordinary contributions.

For skill maintenance, validate this pair with the sibling falryn-work
validator and run `python3 -B scripts/test_select_next.py --falryn-root
<verified-falryn-checkout>`. Install both Falryn skills together; the delivery
skill owns the distribution procedure.
