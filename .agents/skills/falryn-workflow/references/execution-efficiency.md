# Execution efficiency

These defaults apply to Plan, Implement, Review, Verify, Merge, Next, and Deliver, including parent selectors. No extra prompt, mode, or flag is needed. Preserve the selected mode's scope, acceptance criteria, required review, validation, CI, documentation, confirmation, exact-revision verification, reconciliation, and stop conditions. Efficiency never grants an exception to another workflow rule.

Ordinary unprefixed requests may use the same safe evidence reuse and batching within their existing authority. This does not activate a maintainer mode or add Project audits, delivery steps, or mode-specific reporting to an ordinary task.

## Reuse evidence, not authority

Keep one compact working record in the current agent context or an existing private execution artifact. Record the exact target and criteria, source/docs/base/head revisions, affected owners, applicable instructions, completed checks with commands and input identities, blockers, and next action. Include only facts the selected task needs; do not create a repository status document or another execution runtime.

Read each applicable instruction and owner before relying on it. Reuse its contents while the exact revision remains unchanged; inspect relevant changes rather than repeating full repository orientation. A handoff between manual prompts must retain evidence identities and limitations, not just a prior agent's conclusion. Missing identities, uncertain freshness, or lost evidence require a new read or check.

Apply [target invalidation](targets-and-transitions.md#invalidation) after every relevant change. Bind validation evidence to the tested revision, dependencies, configuration, toolchain, environment, and check scope. A new phase or prompt alone does not invalidate unchanged evidence, but a new head or base requires fresh review and verification. Required complete-diff inspection still covers the full current diff, not only the latest increment. Evidence reuse never substitutes for required live issue, Project, PR, check, review, authority, or pre-merge reads.

## Keep coordination bounded

- Keep one controlling agent for the selected task. Do not spawn agents merely to repeat workflow phases. Delegate only a bounded task with a clear benefit, exact scope, and concise required result; preserve any required independent review and the host's delegation protocol.
- Batch independent read-only queries without dropping required fields or relationships. After reading the complete target contract, fetch only the fields needed for a later check when that check does not require the full contract again.
- Parallelize independent reads, read-only review, CI observation, and checks only when their inputs remain stable and their processes, files, output directories, and resource budgets do not interfere. Keep one writer per checkout and keep dependent mutations and merges sequential.
- Run every scope and refresh required by [governance audits](governance-audits.md) when the selected mode requires an audit. Reuse a completed audit of the same demonstrably unchanged generation only where that contract permits. Relevant governance mutations require fresh live audits; snapshot replay proves deterministic analysis, not current readiness. Do not replace an audit with a hand-built partial query.
- Follow the `gh-cli` CI watch procedure when check settlement is required. Observe checks in the background while doing independent useful work permitted by the selected mode, then wait for settlement without polling. Do not push or change the reviewed candidate merely to stay busy.

## Match work to the selected mode

| Mode | Avoid repeated work | Preserve the boundary |
| --- | --- | --- |
| Plan | Resolve missing or changed contract facts without rewriting already complete, current requirements. Batch independent owner and dependency reads. | Read all required evidence and complete the handoff. Do not write product code, create an implementation branch, set In Progress, or make a human-owned decision. |
| Implement | Use the current complete handoff rather than restarting Plan. Run focused checks while iterating and reuse valid evidence during targeted repairs. | Stop on incomplete or conflicting requirements. Complete required validation before review; do not merge or start another issue. |
| Review | Reuse revision-bound observations and test evidence while inspecting the complete current diff and its affected behavior. | Remain read-only. Do not run untrusted code in a privileged checkout, post a review, approve, repair source, or infer bundle merge readiness. |
| Verify | Reuse trustworthy check results for unchanged inputs and inspect the complete exact-revision bundle. Rerun invalidated or required checks. | Do not repair source, PR contents, or private docs, and do not merge. Governance mutation still requires explicit authorization. |
| Merge | Reuse the exact reviewed source evidence instead of repeating unchanged implementation discovery. Batch independent mandatory preflight reads. | Re-read every required merge precondition immediately before mutation. Changed facts return to Verify; authorization, docs-first order, and reconciliation remain mandatory. |
| Next | Use the required auditor's generated sequence and necessary target evidence without preparing implementation or running unrelated builds. | Remain read-only; require private authority and current routing evidence. Diagnostics suppress routing. A suggested prompt never starts work. |
| Deliver | Keep one controller across the full loop and reuse valid evidence across phases. | Deliver alone composes modes. Preserve bounded repairs, docs-first merge, and [serial parent delivery](parent-delivery.md). |

Manual modes stop at their declared result. A successful Plan, Implement, Review, Verify, Merge, or Next prompt does not start the next mode. Preserve the access distinctions and exact permissions in [targets and transitions](targets-and-transitions.md); optimization is not new authority.

## Validate and repair at the affected boundary

For authorized implementation, use focused checks while iterating, then run the complete validation required by `DEVELOPMENT.md` before requesting review, including applicable compiled, platform, security, and recovery checks. Required CI remains separate. Keep checks within configured concurrency and resource limits; never substitute changed-file tests for a required full suite. Do not add an implementation-sized validation cycle to a read-only routing or planning task without a relevant proof requirement.

During review or verification, inspect the complete exact-revision evidence and rerun checks when their inputs changed, evidence is missing or untrustworthy, or the governing contract requires another execution. Execute only where the selected mode, trust boundary, and user authority permit it. Otherwise report the missing proof. Do not repeat an identical successful check solely because the prompt or phase changed. Unknown validity means new proof, not an assumed pass.

For each authorized repair, identify the failed criterion, correct its owning code or contract, run focused proof, refresh invalidated broader validation, and verify the new revision without source mutation. Manual Review or Verify reports the gap and next authorized action rather than entering repair itself. Deliver returns to its implementation phase under its existing three-pass no-progress stop rule. Do not restart unrelated discovery.

Resolve documentation owners once per applicable revision under [documentation delivery](documentation-delivery.md). Reclassify when scope or owner content changes. Only an authorized mutation mode updates affected canonical owners; verified-unaffected documentation does not need a companion PR. Required companions still receive joint verification and docs-first merge.

## Measure without adding bureaucracy

For named modes, use observed start/end times for the applicable phases: preparation, planning or implementation, review or verification, validation, CI waiting, documentation, merge, and reconciliation. Report a compact breakdown and the largest observed bottleneck at completion or a stop. Omit phases that did not run; do not add work just to populate timings. Identify overlapping work so durations are not falsely added into elapsed time.

Mark missing timings unavailable; do not reconstruct them from guesses or claim a speedup without comparable measurements. Keep timing in the existing execution report or private temporary artifacts, never a new repository process document or public private-state dump. Deliver chains also report the per-child timing required by [parent delivery](parent-delivery.md).
