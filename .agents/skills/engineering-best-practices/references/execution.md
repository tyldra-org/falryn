# Execution

Optimize for a verified end state while keeping each delivered unit coherent.

## Sequence proof, not activity

Split work at boundaries where a concrete check can pass. Establish the
baseline, make one meaningful change, run its cheapest decisive check, and only
then advance. Order commits or pull requests so a reviewer can reconstruct the
argument: reproduction before fix, removal before reshape, scaffold before the
work it unlocks.

Temporary instability belongs only inside an isolated experiment or unshared
worktree. A published commit or completed task must meet its declared contract.
Follow repository Git policy when updating the base; do not treat rebasing as a
universal prerequisite.

## Build leverage deliberately

Use a codemod, generator, script, query, or reusable test when it makes a
non-trivial operation repeatable and reviewable. Learn the transformation on a
small sample, make the lever safe to rerun, and compare its output with the
known sample before broad application.

Do not build a framework for two obvious edits. The lever should be smaller and
easier to audit than the manual work and should remain in the repository only
when future reruns or review justify its maintenance.

Prefer one deterministic transformation to many agents repeating instructions.
When delegation is justified, give every worker the same immutable scope,
recipe, evidence contract, and do-not-touch boundaries.

## Protect attention and context

Read what the current decision needs. Use outlines, targeted symbols, bounded
logs, and summarized evidence instead of loading entire trees or raw output.
Keep frequently used short rules in the skill entrypoint; route specialized
detail to references. Bound fan-out and bring conclusions, not payloads, back to
the controller.

Context reduction must preserve the facts needed to verify the outcome:
requirements, decisions, unresolved risks, source identities, test results, and
recovery handles.

## Continue without unsafe guessing

When intent and authority are clear, proceed with reversible local work and
present the result for asynchronous review. Ask only when plausible choices
produce materially different product outcomes or authority is missing.

Do not turn autonomy into permission. Confirmation remains mandatory when the
action is destructive, irreversible, privileged, externally visible, costly,
or explicitly confirmation-gated. If blocked, complete independent safe work,
record the exact dependency, and stop rather than inventing consent.
