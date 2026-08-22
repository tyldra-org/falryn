---
name: change-review
description: >-
  Review a local diff, branch, or GitHub pull request for behavior, correctness,
  design, and blast radius. Use for code review, PR review, change walkthrough,
  "what changed?", or "what could this break?". Read-only by default.
---

# Change review

Review the exact revision, not an assumption about the change. This skill owns
review reasoning and the evidence-backed report. It does not own GitHub PR
commands or posting a review (`gh-cli`), Git porcelain (`git-workflow`), or
stack-specific correctness (`typescript-best-practices`, `opentui`, and the
relevant project guidance).

## Safety and scope

Review is read-only by default: do not edit files, create a branch, comment,
approve, request changes, merge, or change issue/PR metadata. Submitting a
GitHub review is an explicit outward-facing action handled by `gh-cli` only
after the user has seen and approved the exact text.

Resolve one target before reviewing:

- **Local worktree:** staged, unstaged, and untracked changes relative to the
  current `HEAD`.
- **Branch:** its merge-base diff against the repository's resolved default
  branch.
- **GitHub PR:** the repository-qualified PR, its base SHA, current head SHA,
  body, commits, changed files, checks, and linked work. Load `gh-cli`.

Never call a local branch a PR revision without checking the exact head SHA.
Do not check out or execute an untrusted PR head in a maintainer environment
just to review it. Inspect API/diff data first; use observed CI as execution
evidence. Run a focused reproduction only when the user explicitly authorizes
it in a suitable isolated environment.

## Review procedure

1. **State intent and revision.** Read the issue/PR description, commit list,
   and complete diff. State what the change is meant to accomplish and record
   the base/head revisions. If intent is genuinely unclear, say what you can
   infer and constrain findings to observed behavior.
2. **Inventory the full change.** List every added, modified, deleted, and
   renamed file, grouped as core behavior, wiring/integration, tests,
   configuration/generated artifacts, and documentation/mechanical work. Lead
   with the group that carries behavior, not tree or alphabetical order.
3. **Read context, not just hunks.** Read tests before the implementation when
   present. Then trace affected symbols through real callers, data models,
   configuration, persistence or wire formats, lifecycle/cleanup, public
   surfaces, and documentation. Use the relevant stack skill for changed code.
4. **Find the key safety condition.** Identify the one factual condition most
   important to the change's safety. Follow its failure path beyond the diff
   and test the condition against actual source and observed check evidence.
   Mark it **proven** only with direct execution evidence; otherwise say which
   evidence level was reached: source line, failure-path trace, or unproven.
5. **Assess real risks.** Check correctness, security/privacy, data loss,
   compatibility, concurrency/order, error handling, resource cleanup,
   performance, migration/rollout, documentation, and test coverage only where
   the diff makes each relevant. Also challenge added complexity: unnecessary
   layers, weak type boundaries, scattered special cases, duplicate helpers,
   and logic in the wrong owner. Prefer a simpler existing shape when one is
   concrete; do not invent stylistic concerns.
6. **Report high-signal findings.** A finding must identify an exact changed or
   affected `path:line`, trigger, consequence, and focused correction. Separate
   verified findings from risks examined and cleared. Do not praise-pad, repeat
   the diff, or manufacture nits.

## Report format

Report, in this order:

1. target, repository, base/head revision, and review scope;
2. concise changed-file inventory grouped by reviewer value;
3. changed behavior and contract surface;
4. the key safety condition, evidence level, and any unproven gap;
5. findings ordered **Blocking**, **Should fix**, **Consider**;
6. cleared risks, observed checks, documentation impact, and the cheapest
   pre-merge validation.

For a clean review, say **No findings** and still retain the revision and
evidence boundaries. A review is valid only for the recorded head revision;
any new commit requires a fresh review.
