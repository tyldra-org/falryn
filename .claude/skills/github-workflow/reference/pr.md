# pr

Open, update, and land pull requests. A PR is outward-facing — show the title and body before it goes out.

## Tooling

Prefer `gh`:

```bash
gh auth status
```

If `gh` is unavailable or unauthenticated, say so and ask whether to install/authenticate. Do **not** fall back to raw `curl` with a token pulled from the environment or `.git-credentials` — that path reads secrets into the transcript and into shell history. The user runs `gh auth login` themselves.

## Before opening

```bash
git fetch origin
git log origin/<default-branch>..<branch> --oneline    # the commits
git diff origin/<default-branch>...<branch> --stat     # three dots: the branch's own changes
```

Three dots, not two. `git diff A..B` shows the difference between two tips including whatever landed on A; `A...B` shows only what B added since the fork point. Reviewers see the three-dot diff.

Check:

- Branch is pushed and current with the base.
- Every commit is one the user would want in the permanent record. If the branch has `checkpoint` or fixup commits, offer to clean them up first ([rewrite.md](rewrite.md)) — it's their call.
- No secrets in the diff. Re-check; the pre-commit scan may have missed a file added later.
- CI config exists and will actually run on this base.

## Base branch

Confirm the base explicitly. Getting this wrong is the most common PR error and it produces a diff full of unrelated commits.

```bash
gh pr create --base <default-branch> --head <branch>
```

For **stacked PRs**, the base is the parent branch, and the description must say so — otherwise the reviewer reviews the parent's changes too.

## Title and body

**Title** follows the same rules as a commit subject ([conventions.md](conventions.md#pr-titles)): `type(scope): summary`, imperative, ≤72 chars. For a squash-merge repo the title *becomes* the commit subject — it matters more, not less.

**Body** is where prose is allowed. Structure:

```markdown
## What
One paragraph. What changed and what it enables.

## Why
The problem or the ticket. Link it: Refs #123.

## How
Only when the approach is non-obvious. Name the tradeoff you took and the one you rejected.

## Verification
What you ran and what it showed. Commands and results, not "tested locally".

## Risk
Blast radius, migration steps, rollback plan. "None" is a valid answer — write it, don't omit the section.
```

Omit sections that are genuinely empty rather than filling them with filler. Never include AI attribution, generated-by footers, or emoji headers.

The PR body is separate from the commit and merge messages. It remains the
durable place for validation, risks, rationale, delivery details, and issue
links; the resulting commit or merge is always subject-only with no body.

If `.github/PULL_REQUEST_TEMPLATE.md` exists, it wins — fill it, don't replace it.

## Size

A PR over ~400 changed lines gets reviewed worse than two PRs of 200. If the branch is large and separable, say so and offer to split before opening. If it's large and genuinely atomic (a rename, a generated file, a vendored dependency), say that in the body so the reviewer knows not to read line by line.

## Draft PRs

```bash
gh pr create --draft
```

Use when CI needs to run on incomplete work or when soliciting direction early. A draft PR is not a protected-operation exemption — still ask.

## After opening

```bash
gh pr view <n>            # confirm it created what you intended
gh pr checks <n>          # CI state — see ci.md
```

Report the URL. Never enable auto-merge — landing is always a human decision.

## Updating

Push follow-up commits; do not force-push a PR under review unless asked. Force-pushing invalidates in-progress review comments and hides what changed since the last look. When the user does want a clean history, do it once, at the end, after approval.

```bash
gh pr diff <n>            # what the reviewer currently sees
```

When editing a PR body, retain the current body, render and validate the full replacement before writing, and re-read it afterward. Never pipe an unchecked transform into `gh pr edit --body-file -`; follow [Remote body and metadata safety](../SKILL.md#remote-body-and-metadata-safety).

## Correcting work before and after merge

Choose the continuation from the PR's actual state:

- **Open PR:** continue on its existing branch and PR. Push focused follow-up
  commits, then repeat review and validation against the new `headRefOid`; an
  earlier Verify or approval does not apply to the new revision. Do not create
  a duplicate branch or PR for the same correction.
- **Closed without merge:** inspect why it closed, whether the head branch still
  exists, whether the base and scope remain valid, and whether repository
  policy permits reopening. Reopen the same PR only when those facts still
  hold; otherwise create a fresh branch and PR.
- **Merged:** the PR is an immutable delivery record and cannot be reopened or
  merged again. Reopen the owning issue when its original acceptance remains
  incomplete, or create a focused follow-up issue when the correction is a new
  outcome. Branch from the current target branch and open a new PR.

Do not reuse a squash- or rebase-merged branch for post-merge correction. Its
commit ancestry differs from the landed history and can produce a confusing
range; a fresh branch from the updated target gives the correction an exact
base. A rollback is a separate revert workflow, not ordinary follow-up work.

## Landing

**Merging is irreversible in practice** — confirm before, every time, even after approval.

Re-read the PR immediately before confirmation, record its exact head SHA, and follow [merge.md](merge.md#merge-a-github-pull-request). Use `--match-head-commit` so a new push invalidates the merge rather than silently landing unreviewed code.

Match repository policy and topology. Do not add `--admin`, `--auto`, or `--delete-branch` silently. After landing, verify that the PR is truly merged and synchronize safe local checkouts; do not assume the command switched local branches.

For a change delivered through multiple repositories or dependent PRs, use [delivery.md](delivery.md).

## Reviewing someone else's PR

See [review.md](review.md).
