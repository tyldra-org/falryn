# Write issue contracts

Use this guide whenever Plan, a re-plan during delivery, a follow-up or an
explicit request creates or changes an issue. The issue is the implementation
handoff: an implementer should never have to guess what is expected.

## Size the work once

Decide sizing while establishing the contract, before any code. Keep one issue
when its acceptance follows one owner path to its consumers and can land as one
reviewable pull request, even when it is substantial. Split into native
children only when parts have independent outcomes or consumers, different
blockers or owners, or cannot be reviewed together as one pull request. Line
count alone is not a reason to split. A parent keeps the integrated acceptance;
each child gets its own complete contract and moves its requirements out of the
parent rather than copying them.

## Review the impact first

- Trace the change through Falryn's architecture: the owning capability and
  layer, shared services, tools, engines, agents, workflows and every consumer
  that depends on it. Extend existing owners instead of adding parallel ones.
- Review open issues in both repositories for missing requirements,
  contradictions, duplicate ownership and integration gaps. Run
  `python3 <skill-root>/scripts/review_open_issues.py` with a `--term` for each
  affected owner, source path and contract term and an `--issue` for each
  related issue. It searches every open issue in both repositories and reports
  how many each had; read every relevant match in full.
- Check the consumers beyond the direct owner that reach the same behavior:
  other runtimes and providers, delegated agents, workflows, schedules,
  configuration and settings owners, extensions and external hosts. Each one
  either gets its integration written down or is named as unaffected, with the
  reason.
- Change only the issues the evidence shows are affected. Do not add
  repetitive boilerplate to unrelated work.

## Make the handoff complete

Write each section that applies; a scoped defect needs less than a new
capability, but nothing an implementer needs may be left implicit.

- **Behavior:** the current behavior at a verified source baseline and the
  expected user experience.
- **Boundaries:** scope, non-goals, source owners and native dependencies.
- **Contracts:** inputs and results, configuration, storage, lifecycle, limits,
  failure handling and recovery.
- **Path to use:** registration, discovery, runtime composition, execution and
  results in each applicable CLI, TUI, headless, model and extension interface.
  A working library or adapter alone does not complete a user-facing feature;
  name any interface that intentionally stays out.
- **Acceptance:** concrete scenarios, each with its entry point, input,
  observable result and the test that proves it. Cover success and the failure
  classes that apply: partial failure, cancellation, stale state or generation,
  concurrency and restart or replay. Leave out a class only when it cannot occur.
- **Proof:** validation commands and the documentation-impact classification
  from [documentation](documentation.md).

## Preserve what exists

Keep existing decisions, delivered behavior and unrelated work. State a moved
requirement in one place and link to it. Before editing a body, keep its exact
preimage privately, then re-read the result. Public issues stay self-contained
and never contain private text, planning-field values or local paths. Label
proposed behavior as proposed; describe behavior as current only with source
evidence.

## Name what is unresolved

Resolve every gap the evidence supports. A human choice, an undecided
dependency or an unverifiable fact is named with its owner and question, and it
keeps the issue out of Ready. Never guess, and never check a readiness checklist
to make work look deliverable.

## Prove coverage before applying

Run this check before any issue or Docs change is applied. That includes a draft
the user approved with "apply": a draft written before this check ran is
completed first, not applied as written.

1. The open-issue review above ran at the current state of both repositories.
   Keep its searched counts and the matches read.
2. Every affected issue is checked against each item of
   [the complete handoff](#make-the-handoff-complete). Each interface (CLI, TUI,
   headless, model, extension) and each failure class (partial failure,
   cancellation, stale state, concurrency, restart) is either covered by a named
   behavior and acceptance scenario, or stated as not applicable with the reason.
   Every new entry point, setting or stored value names its source owner.
3. The canonical Docs owner of the proposed behavior is updated and labeled as a
   design target.
4. A material change the check finds in an approved draft is shown before it is
   applied.

Report the searched counts, the issues changed and the issues reviewed but left
unchanged, and any requirement still open with its owner.
