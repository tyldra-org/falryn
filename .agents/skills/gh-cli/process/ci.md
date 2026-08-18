# ci

Watch checks, diagnose failures, fix within a bounded loop.

## Check status

```bash
gh pr checks <n>
gh run list --branch <branch> --limit 5
gh run view <run-id> --json status,conclusion,url,headSha
gh run view <run-id> --log-failed
```

`gh run view` is a one-shot snapshot. It does not wait for the run.

`--log-failed` over `--log`: the full log is mostly noise and the failing step is what matters.

Without `gh`, ask the user for the run URL or the failing output. Do not construct API calls with a token from the environment.

## While checks are running

**Always watch in the background.** Do not block the conversation turn on
multi-minute waits.

`gh run view` and `gh pr checks` (without `--watch`) are snapshots. The
native waiter for a workflow run is:

```bash
gh run watch RUN_ID --repo OWNER/REPO --exit-status
```

Prefer that over a custom poll loop. `gh pr checks --watch` waits on
PR-attached checks; for a GitHub Actions run, use `gh run watch`.

1. One snapshot is fine when you only need current state.
2. Start `gh run watch` in the background. Do not wait in the chat turn.
3. Tell the user the PR or run URL and the head SHA being watched. Keep
   useful work going, or end the turn so the wait can complete.
4. If merge is already authorized: when the watcher finishes, **re-read**
   head SHA, **required** checks, reviews, mergeability, and method, then
   merge per [merge.md](merge.md). Never merge a changed head without that
   re-read. Do not hold the turn “because merge is next.”
5. If you must poll, match the interval to real job duration. Prefer
   `gh run watch` over polling.

**Foreground wait only** when the user explicitly says to wait in-chat
(e.g. “wait here until green”). “Land this PR” / “merge when green” is **not**
that — use background `gh run watch`, then merge after the re-read.

## The bounded fix loop

**Three attempts, then escalate.** Non-negotiable.

Each attempt:

1. **Read the actual error.** The shortest decisive line, not the surrounding 200 lines of log. Quote it exactly.
2. **Reproduce locally** when possible. A fix you cannot verify locally is a guess, and pushing guesses to CI is how a 3-attempt budget becomes 15.
3. **Form one hypothesis** and state it. "The test fails because X" — if you cannot state it, you're pattern-matching, not diagnosing.
4. **Make the minimal change** that tests the hypothesis.
5. **Commit and push.** A standing "fix CI" instruction covers the loop; without one, follow the user's push policy.

After three failed attempts, **stop**. Report:

- The exact error, unchanged across attempts or changing how.
- Each hypothesis and why it was wrong.
- What you'd need (a log, an env var, a permission, a decision) to go further.

Do not attempt a fourth. Do not switch to a broader "just make it pass" approach — that's where `continue-on-error`, skipped tests, and relaxed assertions get introduced.

## Never do to make CI pass

- Delete, skip, or `xfail` a failing test without the user's explicit decision.
- Add `continue-on-error: true` or `|| true` to a failing step.
- Loosen an assertion so it stops catching the bug.
- `--no-verify` past a hook.
- Retry the identical job hoping for a different result more than once. One retry for a suspected flake is fair; two is denial.

If the honest answer is "this test is wrong", say that, show why, and let the user decide. That's a legitimate finding — it just isn't yours to act on unilaterally.

## Flaky tests

Suspect flake when the same job passes on retry with no code change. Report it as a finding — a flaky test in CI is a real defect that costs everyone time, and silently retrying past it hides the cost. Note the test name, how often it failed, and whether the failure mode is consistent.

## Failures that are not yours

- **Infrastructure** (runner OOM, registry timeout, expired token) — report, don't fix. Retry once.
- **Pre-existing failure on the base branch** — verify with `gh run list --branch <default-branch>`. If the base is red, say so; your PR isn't the cause and shouldn't carry the fix unless asked.
- **Permissions / secrets missing on a fork PR** — expected behavior, not a bug. Explain it.

## Local pre-flight

Cheaper than the loop. Before pushing, run whatever CI runs, scoped to the change:

```bash
# read the workflow to find out what CI actually does
cat .github/workflows/*.yml
```

Match the versions where it matters (Node, Python, toolchain). "Works on my machine with a different minor version" is most of the gap.
