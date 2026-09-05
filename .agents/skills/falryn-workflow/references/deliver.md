# Deliver

Deliver is one maintainer controller for one resolved PR-sized issue at a time. It serially performs readiness, implementation, fresh verification, bounded correction, merge, and reconciliation. It never creates planner, implementer, verifier, goal-wrapper, or parent-branch machinery.

## Authority

Upstream Deliver requires authenticated private Roadmap access because it changes Status and Readiness, resolves exact sequence and ownership, and reconciles completion through [governance audits](governance-audits.md). A required docs companion also requires private Falryn Docs access and [documentation delivery](documentation-delivery.md). Without either required authority, return `unavailable` before state mutation and name the explicit public preparation or maintainer action that can proceed.

The originating Deliver request authorizes merge only for the exact issue's freshly verified application PR and explicitly verified companions. It does not authorize changed revisions, missing checks, unresolved reviews, a different owner, or unrelated pull requests.

## Efficient execution

Use these defaults for every Deliver selector. Preserve scope, acceptance criteria, required review, validation, CI, documentation, confirmation, exact-revision verification, merge order, reconciliation, and stop conditions. Efficiency never grants an exception to another workflow rule.

### Reuse evidence, not authority

Keep one compact working record in the current controller context or an existing private execution artifact. Record the exact target and acceptance criteria, source/docs/base/head revisions, affected owners, applicable instructions, completed checks with commands and input identities, blockers, and next action. Do not create a repository status document or another execution runtime.

Read each applicable instruction and owner before relying on it. Reuse its contents while the exact revision remains unchanged; inspect relevant changes rather than repeating full repository orientation. A context handoff must retain the evidence identities and limitations. Missing identities, uncertain freshness, or lost evidence require a new read or check.

Apply [target invalidation](targets-and-transitions.md#invalidation) after every relevant change. Bind validation evidence to the tested revision, dependencies, configuration, toolchain, environment, and check scope. A phase transition alone does not invalidate unchanged evidence, but a new head or base requires fresh review and verification. Evidence reuse never substitutes for required live issue, Project, PR, check, review, authority, or pre-merge reads.

### Keep coordination bounded

- Keep one controller across readiness, implementation, verification, repair, merge, and reconciliation. Do not spawn agents merely to repeat those phases. Delegate only a bounded task with a clear benefit, exact scope, and concise required result; preserve any required independent review and the host's delegation protocol.
- Batch independent read-only queries without dropping required fields or relationships. After reading the complete target contract, fetch only the fields needed for a later check when that check does not require the full contract again.
- Parallelize independent reads, read-only review, CI observation, and checks only when their inputs remain stable and their processes, files, output directories, and resource budgets do not interfere. Keep one writer per checkout and keep dependent mutations and merges sequential.
- Run every scope and refresh required by [governance audits](governance-audits.md). Reuse a completed audit of the same demonstrably unchanged generation only where that contract permits. Relevant governance mutations require fresh live audits; snapshot replay proves deterministic analysis, not current readiness. Do not replace an audit with a hand-built partial query.
- Follow the `gh-cli` CI watch procedure. Observe required checks in the background while doing independent useful work, then wait for settlement without polling. Do not push or change the reviewed candidate merely to stay busy.

### Validate and repair at the affected boundary

Use focused checks while iterating, then run the complete validation required by `DEVELOPMENT.md` before requesting review, including applicable compiled, platform, security, and recovery checks. Required CI remains separate. Do not raise concurrency merely to shorten a run or substitute changed-file tests for a required full suite.

During Verify, inspect the complete exact-revision evidence and rerun checks when their inputs changed, evidence is missing or untrustworthy, or the governing contract requires another execution. Do not repeat an identical successful check solely because the controller changed phases. Unknown validity means rerun, not assume a pass.

For each repair, identify the failed criterion, correct its owning code or contract in the implementation phase, run focused proof, refresh invalidated broader validation, and verify the new revision without source mutation. Do not restart unrelated discovery or weaken the existing three-pass no-progress stop rule.

Resolve documentation owners once per applicable revision under [documentation delivery](documentation-delivery.md). Reclassify when scope or owner content changes. Update only affected canonical owners; verified-unaffected documentation does not need a companion PR. Required companions still receive joint verification and docs-first merge.

### Measure without adding bureaucracy

Use observed start/end times for preparation, implementation, validation, CI waiting, documentation, and reconciliation. Report a compact phase breakdown and the largest observed bottleneck at completion or a stop. Identify overlapping work so phase durations are not falsely added into elapsed time. Mark missing timings unavailable; do not reconstruct them from guesses or claim a speedup without comparable measurements. Keep timing in the existing execution report or private temporary artifacts, never a new repository process document or public private-state dump.

## Controller loop

1. Resolve the exact public issue, private Project state, assignee, hierarchy, blockers, and current delivery work.
2. Plan only when readiness is unresolved, keeping the issue Todo.
3. Set In Progress immediately before implementation after all preconditions pass.
4. Implement one complete PR-sized slice and any required private companion.
5. Verify the exact bundle without source mutation.
6. Return actionable gaps to the same issue and branch, require observable progress, then verify the new revision.
7. After three repair passes without changed evidence, stop for a different strategy.
8. Merge private docs first and the application last under [Merge](merge.md).
9. Reconcile issue, private Project, parent, `CURRENT-STATE.md`, and safe local checkouts.

Do not create duplicate branches or pull requests. A merged but incomplete delivery reopens its owner and uses a fresh branch. A distinct outcome receives one focused follow-up issue.

After a standalone issue completes, run Next and report the next target without starting it. A child continues only within its parent rules. For parent selectors, also read [parent delivery](parent-delivery.md).
