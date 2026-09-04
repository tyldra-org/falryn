# Parent delivery

Parent delivery requires authenticated private Roadmap access. A parent is an outcome tracker, never a branch or mega-pull request.

## One-child selector

`Deliver - Target: Parent issue #N` selects the first ordered, unblocked, incomplete child from the current [Roadmap audit](governance-audits.md). If that child is Not Ready, the controller plans that same child before implementation. It never skips ahead to a later Ready sibling.

Run one child's full delivery cycle, including required private docs companions, application merge, issue and Project reconciliation, and safe checkout synchronization. Stop when another child remains and report that exact child.

## Chain selector

`Deliver - Target: Parent chain #N` uses the same controller but continues through remaining ordered children. It recomputes the private sequence after each settled child. It never parallelizes siblings, emits a next-sibling prompt while CI or merge is pending, or turns the parent into an implementation branch.

Stop the chain on missing private authority, awaiting user input, changed merge preconditions, an uncertain effect, or three repair passes without progress. Report the exact child and resume selector.

## Parent completion

Keep the parent In Progress while required work remains. After the last required child, run integrated parent verification across behavior, failure, recovery, resource, security, documentation, and product projection criteria. Close and mark Done only when every parent criterion passes. An integration code gap becomes one dedicated native child.

Without private Roadmap access, report parent routing unavailable. Do not reconstruct child order from issue numbering or public recency.
