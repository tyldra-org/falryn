# Deliver

Deliver is explicit authorization to complete one resolved delivery owner
through a fresh passing Verify and its authorized merge sequence. Read the
Deliver section of the canonical Development contract first.

For a standalone issue or native child:

1. Confirm the authenticated GitHub account is the target's sole assignee.
   Stop and route to the owner when it is not; do not take over the delivery.
2. Resolve readiness. Plan only when readiness is genuinely unresolved; split
   only when the existing contract makes boundaries unambiguous.
3. Run implementation, then a new read-only Verify against the current head.
4. If Verify finds a gap, use [Corrections](corrections.md), then Verify the
   changed head again. A repair pass must show observable progress; after three
   non-progressing passes, stop and ask for a changed strategy.
5. After a fresh passing Verify, merge the delivery PR. Reconcile GitHub, the
   Project, docs, state, and safe local checkouts before treating the child as
   complete.
6. A completed standalone runs Next routing and reports the next target without
   starting it. A directly delivered child continues its parent order or runs
   parent integration when it was last.

Never merge a changed head, failed or missing required check, unresolved review,
unavailable squash setting, or a different delivery owner.

Read [Parent delivery](parent-delivery.md) for either parent selector and
[Next](next.md) after a standalone completion.
