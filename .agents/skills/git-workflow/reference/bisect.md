# bisect

Find the commit that introduced a regression. Non-destructive — bisect only moves HEAD, and `git bisect reset` always returns you home.

## Preconditions

- A **reliable** reproduction. Bisect on a flaky signal produces a confidently wrong answer. Run the check three times on the known-bad commit before starting.
- A known-good commit. A tag, a release, "it worked last Friday" (`git log --before=<date> -1 --format=%H`).
- A clean working tree. Stash or commit first ([commit.md](commit.md#moving-uncommitted-work)).

## Manual

```bash
git bisect start
git bisect bad <bad-sha>          # or omit for HEAD
git bisect good <good-sha>
# git checks out a midpoint; test it, then:
git bisect good      # or: git bisect bad
# repeat until git names the first bad commit
git bisect reset
```

`log2(N)` steps: 1000 commits is 10 tests.

## Automated — prefer this

```bash
git bisect start <bad-sha> <good-sha>
git bisect run <command>
git bisect reset
```

The command's exit code is the verdict: **0 = good, 1–124 = bad, 125 = skip (untestable), 126/127 = abort.**

```bash
git bisect run npm test -- path/to/failing.test.js
git bisect run cargo test --test regression
git bisect run ./scripts/repro.sh
```

Write a purpose-built repro script rather than running the whole suite — it's faster, and it can't be confused by an unrelated test that was also broken in that range.

Make the script robust to commits where the build itself fails:

```bash
#!/bin/sh
npm ci --silent || exit 125      # untestable commit: skip, don't call it bad
npm test -- path/to/test || exit 1
exit 0
```

Without the `125`, every unbuildable commit in the range is scored as "bad" and the result is meaningless.

## Reading the result

Git prints the first bad commit with its full diff summary. Then:

1. **Verify it.** Check out the parent, confirm good; check out the commit, confirm bad. Bisect is only as correct as the test.
2. **Understand the mechanism** before proposing a fix. "This commit is where it broke" is not "this line is why it broke" — the commit may have exposed a latent bug rather than introduced one.
3. **Merge commits** as the culprit mean the bug is in the interaction, not in either branch. Bisect within each parent if you need more resolution.

## Narrowing the range

```bash
git bisect start -- <path>            # only commits touching this path
git bisect skip                       # current commit is untestable
git bisect log                        # replayable record of the session
git bisect replay <file>              # resume a saved session
```

`git bisect log` is worth saving before `reset` — it's the audit trail for how you reached the conclusion, and it lets you resume if you made a wrong call.

## When bisect is the wrong tool

- **The regression is in dependencies, not commits** — check the lockfile diff first.
- **The range is small (under ~10 commits)** — read them; it's faster.
- **The bad behavior is environmental** (a config change, an expired cert, a data change) — no commit introduced it, and bisect will blame something innocent.
- **History is a squash-merge chain** — the culprit is a whole PR, which may be too coarse. Bisect finds the PR, then read it.

## Always finish

```bash
git bisect reset
```

Leaving a bisect session open leaves you in detached HEAD, and the next person to look at `git status` will think something is broken. If you were on a branch, `reset` returns you to it.
