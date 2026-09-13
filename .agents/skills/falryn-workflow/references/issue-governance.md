# Issue governance

An issue owns a reviewable outcome. Native GitHub relationships own its blockers
and hierarchy. The private Roadmap governs only issues deliberately adopted by
a maintainer. A formatting label or public work type does not prove adoption.

## Complete the handoff

Use the repository's issue format and preserve every issue-specific fact needed
to implement the slice:

- observed baseline, exact remaining outcome, scope and non-goals;
- one PR-sized owner or native children for independent deliveries;
- dependencies, neighboring owners, contracts and composition points;
- applicable failure, partial, unavailable, cancellation, recovery and cleanup
  behavior, plus explicit resource and safety limits;
- validation through the real consumer and relevant user-facing projections;
- documentation impact; and
- a non-empty current checklist for the selected format.

Public PR checks accept the Contribution checklist for a public form, including
one retained after adoption. The maintainer `roadmap` format uses Outcome,
Completion proof, classification and a Ready checklist. It does not need a
duplicate Contribution checklist. Do not infer completeness from headings alone.
The label is maintainer-applied routing for public automation, not an audit.

Roadmap admission has an additional evidence requirement: the Roadmap auditor
requires a non-empty, fully checked Ready checklist even when the adopted
issue retains its public form. A passing public PR check cannot replace that
audit. Keep ordinary issues outside the Project on their public checklist.

A public Falryn issue must contain its complete implementation handoff without
private access. Private links add context but cannot fill missing requirements.
Docs-only contracts remain private. Resolve [documentation impact](documentation-delivery.md)
without copying private designs into public handoffs.

## Admit implementation

Require a complete, current contract, a fully checked applicable checklist, one
open PR-sized leaf, no open native blockers and an authorized checkout or fork.
Recheck baseline, relationships and existing delivery PRs immediately before
starting. Green checks or board position cannot override missing acceptance.
Resolve conflicting public and private contracts at their owning records before
Ready or implementation; do not choose whichever version makes delivery easier.

For an issue outside the Roadmap, these public conditions are sufficient; do not
require private fields or adopt it merely to enable work. For Roadmap-owned work,
add verified membership, complete metadata, Ready, the authenticated account as
sole assignee, and the required [governance audits](governance-audits.md). Private
access loss cannot be used to reclassify known Roadmap work as public-only.

An incomplete handoff needs Plan. Open blockers prevent implementation even
when the contract is Ready. A named human choice needs a decision; blocking alone
does not mean Needs Decision. Apply [Roadmap fields](roadmap-fields.md) when those
states or their transitions are needed.

## Change records safely

Plan and authorized delivery can repair the owning contract and relationships.
Review cannot mutate them. Verify reconciles only what the user explicitly
authorized. Use [execution's mutation rules](execution.md#mutate-and-recover-deliberately)
for preimages, live rechecks and verified results, then run affected audits.

Done means closed with complete delivery proof. A closed PR is not a merged PR,
child completion is not integrated parent proof, and a checked box does not
prove runtime behavior. Use [recovery](deliver.md#recover-from-observed-state)
when previously completed work lacks its original acceptance.
