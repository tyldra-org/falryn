# Execution efficiency

Apply these defaults to named modes and parent chains without an extra flag.
Ordinary tasks may reuse the same techniques within their existing authority.
The selected [mode boundary](targets-and-transitions.md#mode-boundaries),
required validation, CI, documentation, and completion criteria still apply.

## Reuse evidence with its inputs

Keep a compact working record in the current context or an existing private
execution artifact: target and criteria, source/docs/base/head revisions,
affected owners, applicable instructions, completed checks and their inputs,
blockers, and next action. Do not create another repository status document or
execution runtime.

Read each required owner once per unchanged revision. On a handoff, retain
identities and limitations, not merely a prior conclusion. Bind check evidence
to revision, dependencies, configuration, toolchain, environment, and scope.
Missing or uncertain evidence requires a new read or check. A new phase or
prompt alone does not invalidate unchanged evidence.

Apply [invalidation](targets-and-transitions.md#invalidation) when inputs change.
A new head or base requires fresh review of the complete current diff and fresh
verification. Reuse unaffected test results only when their validity is proven.
Cached evidence never replaces required live issue, Project, PR, check, review,
authority, or pre-merge reads.

## Batch independent work

Keep one controller. Delegate only a bounded task with a clear benefit and only
when the host and current instructions allow it. Do not spawn agents for each
workflow phase; preserve any required independent review.

Batch independent read-only queries. After reading the full target contract,
request only fields a subsequent check needs unless it requires a full reread.
Parallelize reads, read-only review, CI observation, and checks only with stable
inputs and noninterfering processes, files, outputs, and resource budgets. Keep
one writer per checkout, dependent mutations sequential, and parent children
serial under [parent delivery](parent-delivery.md).

Run every required [audit scope and refresh](governance-audits.md). Relevant
governance mutations need fresh live audits. Replay proves the captured
generation only; a partial hand-built query cannot replace an audit. Ordinary
public work outside the Roadmap does not trigger private audits.

Use the `gh-cli` native CI waiter. Do independent useful work while checks run,
then wait for settlement. Do not busy-poll, invent work, or push changes merely
to stay active. Re-read merge conditions after the waiter completes.

## Validate at the affected boundary

During authorized implementation, run focused checks while iterating, then the
complete validation required by `DEVELOPMENT.md` before review. Include compiled,
platform, security, and recovery checks when applicable. Required CI is separate;
changed-file tests cannot replace a required full suite. Read-only routing and
planning need no implementation-sized test cycle without a relevant proof need.

Review remains read-only. Verify permits only its explicitly authorized
governance reconciliation. Inspect the complete revision; execute checks within the
mode's trust and authorization boundaries. Rerun invalidated, untrustworthy,
missing, or explicitly required checks. Do not repeat an identical successful
check solely because the stage changed.

For an authorized repair, identify the failed criterion, fix its owner, run
focused proof, refresh affected broader validation, then review and verify.
Follow [corrections](corrections.md) and Deliver's no-progress stop condition.
Do not restart unrelated discovery or enter repair from a manual read-only mode.

Resolve documentation owners once per applicable revision and reclassify when
scope or owner content changes. Follow [documentation delivery](documentation-delivery.md)
for authorized updates, verified-unaffected results, joint verification, and
docs-first merge.

## Report measured overhead

For named modes, record observed elapsed time for phases that ran and the
largest bottleneck. Identify overlap rather than adding parallel durations.
Mark missing timing unavailable. Do not claim a speedup without comparable
measurements or add work just to populate a report. Keep timing in the existing
report or private temporary artifacts; parent chains also report per-child time.
