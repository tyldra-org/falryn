# Parent delivery

Parent delivery requires authenticated private Roadmap access. A parent is an outcome tracker, never a branch or mega-pull request. Apply [efficient execution](deliver.md#efficient-execution) to both parent selectors without changing child or parent completion criteria.

## One-child selector

`Deliver - Target: Parent issue #N` selects the first ordered, unblocked, incomplete child from the current [Roadmap audit](governance-audits.md). If that child Needs Planning, the controller plans that same child before implementation. If it Needs Decision, delivery stops at the named decision owner. It never skips ahead to a later Ready sibling.

Run one child's full delivery cycle, including required private docs companions, application merge, issue and Project reconciliation, and safe checkout synchronization. Stop when another child remains and report that exact child.

## Chain selector

`Deliver - Target: Parent chain #N` uses the same controller but continues through remaining ordered children. It recomputes the private sequence after each settled child. It never parallelizes siblings, emits a next-sibling prompt while CI or merge is pending, or turns the parent into an implementation branch.

Carry the same controller's revision-bound working record across children. Reuse unchanged repository guidance and documentation knowledge, inspect the intervening source and contract changes, and resolve each next child's complete handoff against the new baseline. A previous child's tests, readiness, or merge authorization do not prove the next child. Recompute authoritative ordering after every settled child as required; evidence reuse never freezes the sequence.

Do not start the next child's implementation before the current child's required checks, companion/application merges, reconciliation, and safe checkout synchronization settle. Independent work within the current child may overlap under the shared efficiency rules; sibling delivery remains serial. Report per-child elapsed time, the phase bottleneck, and observed repeated overhead without creating another parent status document.

Stop the chain on missing private authority, awaiting user input, changed merge preconditions, an uncertain effect, or three repair passes without progress. Report the exact child and resume selector.

## Parent completion

Keep the parent In Progress while required work remains. After the last required child, run integrated parent verification across behavior, failure, recovery, resource, security, documentation, and product projection criteria. Close and mark Done only when every parent criterion passes. An integration code gap becomes one dedicated native child.

Without private Roadmap access, report parent routing unavailable. Do not reconstruct child order from issue numbering or public recency.
