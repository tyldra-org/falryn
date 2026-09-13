# Next

Next selects one next action from the private Falryn Roadmap. It is read-only:
no issue or Project mutation, branch, source edit, PR or automatic delivery.
For orientation, answer the user's project question from relevant evidence and
apply these rules before suggesting new Roadmap work.

## Establish the generation and scope

Use the exact [governance audits](governance-audits.md) with authenticated access
to the private Roadmap and both repositories. Any diagnostic suppresses routing.
Without required access, report `Next unavailable: authenticated maintainer
Roadmap access is required.` Explicit public issue and PR inspection remains
available. Never approximate private order from labels, recency or issue numbers.

Broad `Next - Target: Falryn Roadmap` and an unqualified Roadmap "what next?"
select across the generated list. Previous discussion of a blocked issue does
not silently restrict that request to its prerequisites. Explicit issue, parent
or target release requests retain that scope. Identify an out-of-scope
prerequisite without silently expanding the target.

Resume a valid active delivery or interrupted chain only when the user is
continuing that work in this task. Assignment, In Progress and parent-continuation
status alone do not establish that intent. Several active candidates in broad
Next still use the generated order.

## Select one issue

Resolve "my issues" to the authenticated maintainer. Walk `deliverySequence`
in its existing order, joining entries to the same generation's issue and Project
facts. Retain original positions when filtering. Do not sort again.

1. Keep open leaf issues within the requested scope whose sole assignee is the
   maintainer. Skip another owner's independent work.
2. Skip an issue while any native prerequisite remains open. A topological
   delivery order includes future work; earlier entries have not thereby finished.
3. Select the first owned, unblocked entry. Ready and Needs Planning both use
   Deliver. Do not skip Needs Planning for a later Ready issue. Needs Decision
   stops at its named human owner, with no delivery prompt.
4. Recheck that issue's live state, owner, blockers and closing PRs. Changed
   routing facts require a fresh audit before selecting again. A verified open
   delivery PR uses its PR selector; otherwise use the issue selector. Use `Docs`
   for docs-owned objects.

Return one recommendation with its original position and reason. A broad Next
or parent filter selects one leaf, without starting a new parent chain. Suggest
chain delivery only when the user asks for that scope. If no owned entry can
proceed, report the blocking owner, decision or scope constraint and
`Suggested next prompt: none`.

## Report

Include the generation, repository and issue, original sequence position,
readiness, owner, blockers and relevant active PR evidence. End with the one
copy-ready prompt under [continuation routing](targets-and-transitions.md#suggest-the-next-action).
Keep private selection facts in the maintainer conversation, not public artifacts.

For example, given another owner's issue, an owned blocked issue, an owned
unblocked Needs Planning issue and a later owned Ready issue, select the third
entry with Deliver. Preserve its original position. Several assignments or
active parents do not require a menu or a separate choice from the user.
