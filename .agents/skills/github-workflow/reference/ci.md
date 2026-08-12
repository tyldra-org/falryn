# ci

Watch checks, diagnose failures, fix within a bounded loop.

## Check status

```bash
gh pr checks <n>
gh run list --branch <branch> --limit 5
gh run view <run-id> --log-failed
```

`--log-failed` over `--log`: the full log is mostly noise and the failing step is what matters.

Without `gh`, ask the user for the run URL or the failing output. Do not construct API calls with a token from the environment.

## While checks are running

**Default: watch in the background.** Do not block the conversation turn on
multi-minute foreground `sleep` / poll loops for PR checks, Actions runs, or
merge readiness.

- Start a background watcher (Shell `block_until_ms: 0`, or an equivalent async
  job) that logs progress to a file. When merge is already authorized (for
  example by an active `Deliver` run), the watcher may squash-merge only after a
  fresh re-read of head SHA, **required** checks, reviews, mergeability, and
  method — never merge a changed head without that re-read.
- Tell the user the PR URL, the head SHA being watched, and that the wait is
  backgrounded. Keep useful work going, or end the turn so completion
  notifications can fire.
- Do not poll in a tight foreground loop. A one-shot `gh pr checks` / status
  read is fine when you only need a snapshot.
- Match any poll interval to real job duration (a ~10-minute build is not thirty
  twenty-second polls).

Block the turn on CI only when the user explicitly asks to wait in-chat, or when
the very next step cannot proceed without the result and no background path
exists.

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
