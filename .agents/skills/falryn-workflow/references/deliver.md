# Deliver

Deliver is explicit authorization to complete one resolved delivery owner
through a fresh passing Verify and its authorized merge sequence. Read the
Deliver section of the canonical Development contract first.

For a standalone issue or native child:

1. Resolve readiness. Plan only when readiness is genuinely unresolved; split
   only when the existing contract makes boundaries unambiguous.
2. Run implementation, then a new read-only Verify against the current head.
3. If Verify finds a gap, use [Corrections](corrections.md), then Verify the
   changed head again. A repair pass must show observable progress; after three
   non-progressing passes, stop and ask for a changed strategy.
4. After a fresh passing Verify, merge the complete bundle docs-first and the
   application last. Reconcile GitHub, the Project, docs, state, and safe local
   checkouts before treating the child as complete.
5. A completed standalone runs Next routing and reports the next target without
   starting it. A directly delivered child continues its parent order or runs
   parent integration when it was last.

Never merge a changed head, failed or missing required check, unresolved review,
unavailable squash setting, incomplete companion set, or a different delivery
owner.

Read [Parent delivery](parent-delivery.md) for either parent selector and
[Next](next.md) after a standalone completion.
