# CI and checks

Inspect GitHub checks and Actions, diagnose failures, and repair within an explicit bounded loop.

## Snapshot

```bash
gh pr checks <n> --repo <owner/repo>
gh run list --repo <owner/repo> --branch <branch> --limit 5
gh run view <run-id> --repo <owner/repo> --json status,conclusion,url,headSha
gh run view <run-id> --repo <owner/repo> --log-failed
```

Prefer failed-step logs over full logs. Record the head SHA: a passing run on another revision is not evidence for the target.

## Wait without polling

For a GitHub Actions run, use its native waiter rather than a custom polling loop:

```bash
gh run watch <run-id> --repo <owner/repo> --exit-status
```

For PR-attached checks, inspect `gh pr checks --help` for the installed watch options. Whether the host runs a waiter in the foreground or background belongs to the host, not this GitHub skill.

A completed waiter is only a wake signal. Before any merge, re-read exact head SHA, required checks, reviews, rulesets, mergeability, and method. Never merge using stale pre-wait state.

## Bounded repair

Use an explicit task or repository repair budget when provided. Each attempt should:

1. quote the decisive error;
2. reproduce locally when feasible;
3. state one falsifiable hypothesis;
4. make the smallest relevant correction;
5. validate before any authorized push.

Respect an explicit budget. Without one, continue while new evidence supports
a concrete repair; stop repeating an unsuccessful approach when no new evidence
justifies it. Report the remaining blocker or changed strategy. Do not broaden
scope merely to obtain green status.

Never:

- skip or weaken a failing test without an explicit decision;
- add `continue-on-error`, `|| true`, or `--no-verify` to conceal failure;
- retry an unchanged failure repeatedly;
- treat missing fork secrets, runner outages, or a red base as a product defect without evidence.

One unchanged retry may test a credible flake or infrastructure failure. If it passes, report the flake rather than hiding it.

## Local preflight

Read the exact workflow and use repository commands, versions, and matrices. Do not infer CI from filenames or training memory. Match only the checks relevant to the change, then preserve canonical validation when repository policy requires it.
