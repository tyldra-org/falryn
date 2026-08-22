---
name: git-workflow
description: >-
  Git process and safety: commit, branch, fetch/push/rebase, local merge,
  rewrite, recover, bisect, tags, autocommit. Use when mutating a local git
  repo. Does not cover GitHub platform work (gh-cli) or other forge workflows.
---

# Git workflow

Git porcelain and git history safety. Every commit should be reviewable. Every history rewrite should be deliberate.

## Skill boundaries

This skill owns `git`. It does not own hosting-platform workflows.

| | git-workflow (this) | gh-cli |
| --- | --- | --- |
| Answers | How do we commit, branch, sync, rewrite, recover? | How do we use `gh` on github.com? |
| Tool | `git` | `gh` |
| Owns | Stage, commit, branch, fetch/push/rebase, local merge, rewrite, recover, bisect, tags, autocommit | GitHub issues, PRs, Actions, Projects, `gh` flags |
| Does not own | `gh` commands; GitHub objects | `git` porcelain |
| Load when | Any mutating git work | GitHub platform work |

`git remote origin` is a conventional remote name. It does not identify a hosting platform.

Opening or merging a pull request is not git. Load `gh-cli` for GitHub; use the approved integration for another hosting platform.

After GitHub merges land: `gh-cli` → [issue-lifecycle.md](../gh-cli/process/issue-lifecycle.md) for issue/Project reconcile; then [delivery-checkout.md](reference/delivery-checkout.md) for local default-branch sync.

Load `git-workflow` whenever git history changes. Add `gh-cli` when the host is GitHub.

Repositories may vendor this skill under `.agents/skills/` for checkout-local resolution; skill content stays host-agnostic.

## How to use

### 1. Resolve context

```bash
git status --short --branch
git log --oneline -10
git remote -v
```

Never act on an assumed branch, worktree, remote, or default branch.

- `not a git repository` → do not `git init` uninvited.
- Mid-rebase, mid-merge, or detached HEAD you didn't create → stop and report first.

### 2. Route to a reference

| Request sounds like | Command | Reference |
|---|---|---|
| "commit this", "save this", "check it in" | `commit` | [commit.md](reference/commit.md) |
| "start a branch", "switch to", "delete that branch" | `branch` | [branch.md](reference/branch.md) |
| "catch up with main", "push this", "I'm behind" | `sync` | [sync.md](reference/sync.md) |
| "sync local main after PR merged", "fast-forward after delivery" | `delivery-checkout` | [delivery-checkout.md](reference/delivery-checkout.md) |
| "merge these branches locally" | `merge` | [merge.md](reference/merge.md) |
| "clean up these commits", "squash", "rebase" | `rewrite` | [rewrite.md](reference/rewrite.md) |
| "I lost my work", "undo that", "get it back" | `recover` | [recover.md](reference/recover.md) |
| "what broke this", "it worked last week" | `bisect` | [bisect.md](reference/bisect.md) |
| "any secrets in here", "why is the repo so big" | `audit` | [audit.md](reference/audit.md) |
| "tag it", "cut a git tag" | `release` | [release.md](reference/release.md) |
| commit subject, branch name, tag name | `conventions` | [conventions.md](reference/conventions.md) |

GitHub PR / issue / Actions / merge-on-GitHub → `gh-cli`. Other hosting-platform operations need their approved workflow.

Ask only when two routes imply different outcomes or authority. Vague destructive intent → resolve the desired outcome first. One-off `status` / `log` / `diff` / `show` / `blame` needs no skill.

### 3. Gather only what the task needs

**Touching remote / default branch.** Resolve it. Do not assume `main`:

```bash
git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null \
  || git remote show origin | sed -n '/HEAD branch/s/.*: //p'
```

**Writing subjects / branch names.** Match the repo:

```bash
git log --pretty=%s -n 30
git branch -a
git log --graph --oneline -20
```

Honor `CONTRIBUTING.md`, `AGENTS.md`, `commitlint.config.*`, `.gitmessage` when present.

**Merging / branching / tagging.** Detect the workflow model ([below](#workflow-models)).

### 4. Act, then report

Follow the reference. Re-read after writes.

## Ownership

| Concern | Home |
|---|---|
| Stage / commit / amend / stash | [commit.md](reference/commit.md) |
| Subjects, branches, tags | [conventions.md](reference/conventions.md) |
| History rewrite, force-push lease | [rewrite.md](reference/rewrite.md) |
| Post-merge default-branch sync | [delivery-checkout.md](reference/delivery-checkout.md) |
| Non-negotiable git safety (this file) | sections below |

## Precedence

Safety rules never bend. Everything else loses to anything more specific:

1. User's explicit instruction this session
2. Repo-local rules (`CONTRIBUTING.md`, `AGENTS.md`, commitlint)
3. Observed repo convention (`git log`, `git branch -a`)
4. Defaults in this skill

Follow higher layers silently. No convention authorizes committing a secret or bare `--force`.

## Safety rules

### Secrets

Never stage credentials, API keys, tokens, private keys, `.env`, service-account JSON, or connection strings with passwords. Ambiguous path → stop and ask. "Already tracked" is not consent to add more.

Already committed → treat as leaked. Rotate first, rewrite second. [audit.md](reference/audit.md#secret-leak-response).

Never read tokens from the environment or `.git-credentials` onto a command line.

### Confirm before

Show the concrete command and get explicit confirmation for:

- force push; history rewrite (`filter-repo` / `filter-branch` / squash-reword of pushed commits)
- `reset --hard`, `clean -fdx`, restoring over uncommitted work
- deleting branches/tags (local or remote); moving or re-pushing tags
- work on a branch that isn't yours

Routine local work proceeds normally: commit (when autocommit is on or the user asked), branch, stash, fetch, push **your** branch. See [Autocommit](#autocommit).

Hosting-platform confirmations (merge a PR, publish a release, delete a repo) live in that platform's approved workflow.

### Back up before destroying

Before rewrite, force push, hard reset, or branch deletion that could drop commits:

```bash
git branch backup/<what>-$(date +%Y-%m-%d)
git rev-parse 'backup/<what>^{tree}' '<newref>^{tree}'
```

Compare tree hashes, not subjects. Keep the backup until confirmed.

### Force push

Pinned lease only. Details in [rewrite.md](reference/rewrite.md):

```bash
git push --force-with-lease=<branch>:<expected-old-sha> origin <branch>
```

Never bare `--force` or bare `--force-with-lease`. Afterward: say SHAs changed; other clones need fetch + reset or a fresh clone.

### Stop, don't improvise

Stop and report. No silent abort, no `--no-verify`, no unchanged retry:

- merge/rebase conflict; failing hook; rejected push
- detached HEAD or dirty tree you didn't create
- ambiguous branch/remote/target

## Commit and merge messages

One subject line only. Never create, preserve, copy, or infer a commit/merge body. That covers ordinary commits, amend/reword, squash, rewrite, and merge commits. If the repo requires a non-empty body, stop and report. Do not invent one. Form: [conventions.md](reference/conventions.md).

## Autocommit

On by default. When a unit of work reaches a clean boundary ([commit.md](reference/commit.md)), commit it rather than leaving unrelated changes piled in the tree.

- `autocommit on` (default). Commit at clean boundaries. May stage in-scope generated output (docs, fixtures, lockfiles) with the change that produced them.
- `autocommit off`. At a boundary, name it and suggest a subject. Stage/commit only when asked.

Session-scoped only. Never authorizes Confirm before actions. Subject-only rule still applies.

## Workflow models

Read when merging, branching, or tagging:

| Model | Tell | Implications |
|---|---|---|
| GitHub flow | Short branches → one default | Branch, PR via `gh-cli`, land |
| Trunk-based | Direct default-branch commits, flags | Small commits |
| Git flow | `develop` + `release/*` + `hotfix/*` | Features → `develop`; hotfixes from tags |
| Release train | Long-lived version lanes, `--no-ff` | Never rebase/delete lane branches |
| Fork-based | `origin` fork remote, `upstream` canonical | Never push `upstream`; sync from it (`origin` here = git remote name) |

Detect via `git branch -a`, `git log --graph`, `CONTRIBUTING.md`. If ambiguous, ask once.

## Reporting back

After ref moves: what moved with SHAs; what you skipped and why; undo path for anything destructive (backup ref or `git reset --hard <sha>`).

## Escalation

Outside these rules → one sentence and stop. A wrong permitted git op on a shared branch costs more than a question.
