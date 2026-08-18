---
name: github-workflow
description: >-
  Git and GitHub **process and safety**: when to commit, branch, push, open/merge
  PRs, delivery order, confirmations, recovery, issues, Projects, CI, releases,
  and repo admin. Does **not** teach gh or origin CLI flag syntax — pair with
  gh-cli and/or origin-cli for command recall.
---

# GitHub Workflow

Clean, recoverable, auditable Git/GitHub work. Every commit reviewable; every platform mutation target-specific; every irreversible or outward-facing action deliberate.

## Skill boundaries (read first)

This skill owns **procedure and safety**, not CLI cheat sheets.

| | **github-workflow** (this) | **gh-cli** | **origin-cli** |
| --- | --- | --- | --- |
| **Answers** | Should we? In what order? Confirm? | How do I spell `gh …`? | How do I spell `origin …`? |
| **Tool** | `git` + `gh` (as part of workflows) | `gh` only → **github.com** | `origin` only → **origin.cursor.com** |
| **Owns** | Commit policy, merge gates, delivery, recovery, issue/PR *process*, GitHub admin *procedure* | Flags, subcommands, `--json`/`--jq`, `gh api` paths | Flags, `-R`, Origin RPC, mirror/ruleset *syntax* |
| **Does not own** | Exact `gh`/`origin` flags | Whether to merge; git history rules | GitHub issues/Actions; `git` porcelain |
| **Load when** | Any mutating git/GitHub work | Need `gh` flag/JSON recall | Need `origin` flag/RPC recall |
| **Typical pair** | Always first for GitHub mutations | + **gh-cli** for non-trivial `gh` | + **origin-cli** when also touching Cursor forge |

**Disambiguation**

- **`git remote origin`** — your default remote *name* (often `origin.cursor.com` or `github.com`). Not the Origin CLI. Not this skill's "fork `origin`".
- **`gh pr …`** — GitHub pull requests on **github.com** (CI, public visibility, full rulesets).
- **`origin pr …`** — Cursor **changes** on **origin.cursor.com** (sync to GitHub when mirrored).
- **Mirrored repos (inbound)** — `git remote origin` may be `origin.cursor.com`, but **`origin pr` is unavailable** (`mirrorStatus: inbound`). Push via Origin; **open/merge PRs with `gh`** on the GitHub source repo (`github-org/repo` from project overlay). CI and full rulesets stay on GitHub. Optional Origin ruleset tiers: **origin-cli** → [ruleset.md](~/.agents/skills/origin-cli/reference/ruleset.md).
- **Native / detached Origin repos** — use **`origin pr`** for create/view/checks/merge ([merge.md](reference/merge.md#merge-on-native-origin-repos)).

**Load order:** `github-workflow` → then `gh-cli` and/or `origin-cli` for syntax. If both hosts apply, say which command targets which host in the report.

## How to use

Four steps. Steps 1–2 are cheap and always worth it; step 3 owns the procedure.

### 1. Resolve context

```bash
git status --short --branch
git log --oneline -10
git remote -v
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef,url 2>/dev/null
```

Never act on an assumed branch, worktree, remote, or default branch. For GitHub-only work, resolve hostname, owner, repo, object number, and authenticated account—local checkout optional.

- `not a git repository` → do not `git init` uninvited; continue only for explicit remote-only work with an independently identified repo.
- Mid-rebase, mid-merge, or detached HEAD you didn't create → stop and report first.

### 2. Route to a reference

Match the request and **read that reference before acting**.

| Request sounds like | Command | Reference |
|---|---|---|
| "commit this", "save this", "check it in" | `commit` | [commit.md](reference/commit.md) |
| "start a branch", "switch to", "delete that branch" | `branch` | [branch.md](reference/branch.md) |
| "catch up with main", "push this", "I'm behind" | `sync` | [sync.md](reference/sync.md) |
| "merge it", "land this branch" | `merge` | [merge.md](reference/merge.md) |
| "open a PR", "get this reviewed", "ship it" | `pr` | [pr.md](reference/pr.md) |
| "look at PR #N", "is this safe to merge" | `review` | [review.md](reference/review.md) |
| "coordinate these PRs/repos", "land docs then code", "delivery bundle" | `delivery` | [delivery.md](reference/delivery.md) |
| "CI is red", "why is the build failing" | `ci` | [ci.md](reference/ci.md) |
| "authenticate gh", "which repo/account/host is this" | `context` | [context-and-auth.md](reference/context-and-auth.md) |
| "create/update/triage issues, labels, milestones, subissues, dependencies" | `issues` | [issues.md](reference/issues.md) |
| "build or maintain a roadmap/project/board/fields/views" | `projects` | [projects.md](reference/projects.md) |
| "configure a repo, ruleset, collaborator, webhook, key, or environment" | `admin` | [repository-admin.md](reference/repository-admin.md) |
| "dispatch/rerun/cancel a workflow; manage artifacts, caches, secrets, variables" | `actions` | [actions.md](reference/actions.md) |
| "Dependabot, code scanning, secret scanning, advisories, attestations" | `security` | [security.md](reference/security.md) |
| "use gh api/GraphQL, paginate, or change many GitHub objects safely" | `api` | [api-and-bulk.md](reference/api-and-bulk.md) |
| "Discussion, Codespace, package, gist, organization, search, notification" | `surfaces` | [github-surfaces.md](reference/github-surfaces.md) |
| "any secrets in here", "why is the repo so big" | `audit` | [audit.md](reference/audit.md) |
| "what broke this", "it worked last week" | `bisect` | [bisect.md](reference/bisect.md) |
| "I lost my work", "undo that", "get it back" | `recover` | [recover.md](reference/recover.md) |
| "clean up these commits", "squash", "rebase" | `rewrite` | [rewrite.md](reference/rewrite.md) |
| "cut a release", "tag it", "write release notes" | `release` | [release.md](reference/release.md) |

Writing a subject, branch name, PR title, tag, issue taxonomy, or roadmap hierarchy → also [conventions.md](reference/conventions.md). Mixed workflows: load every needed reference in dependency order (e.g. `context` → `issues` → `projects`; `commit` → `sync` → `pr`).

Ask only when two routes imply different outcomes or authority. Vague destructive intent → resolve the desired outcome first. One-off status questions need no reference.

### 3. Gather only what the task needs

**Touching remote / default branch** — resolve it; do not assume `main`:

```bash
git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null \
  || git remote show origin | sed -n '/HEAD branch/s/.*: //p'
```

**Writing subjects / branch / PR titles** — match the repo:

```bash
git log --pretty=%s -n 30
git branch -a
git log --graph --oneline -20
```

Also honor `CONTRIBUTING.md`, `AGENTS.md`, `commitlint.config.*`, `.gitmessage`, `.github/PULL_REQUEST_TEMPLATE.md` when present.

**Merging / branching / releasing** — detect the workflow model ([below](#workflow-models)).

**GitHub objects** — inspect before write (`gh issue/pr/project view … --json …`). Use `--repo` / `--owner` / `--hostname` and explicit numbers in scripts; do not let cwd inference pick a write target.

### 4. Act, then report

Follow the reference. Re-read after writes. Exit zero means GitHub accepted the request—not that relationships, fields, or UI state are correct.

## Ownership

| Concern | Home |
|---|---|
| Stage / commit / amend / stash | [commit.md](reference/commit.md) |
| Subjects, branches, PR titles, tags | [conventions.md](reference/conventions.md) |
| History rewrite, force-push lease | [rewrite.md](reference/rewrite.md) |
| Multi-repo / stacked landing | [delivery.md](reference/delivery.md) |
| Non-negotiable safety (this file) | sections below |

## Precedence

Safety rules never bend. Everything else loses to anything more specific:

1. User's explicit instruction this session
2. Repo-local rules (`CONTRIBUTING.md`, `AGENTS.md`, commitlint, PR templates)
3. Observed repo convention (`git log`, `git branch -a`)
4. Defaults in this skill

Follow higher layers silently. No convention authorizes committing a secret or bare `--force`.

## Safety rules

### Secrets

Never stage credentials, API keys, tokens, private keys, `.env`, service-account JSON, or connection strings with passwords. Ambiguous path → stop and ask. "Already tracked" is not consent to add more.

Already committed → treat as leaked. **Rotate first**, rewrite second — [audit.md](reference/audit.md#secret-leak-response).

Never read tokens from the environment or `.git-credentials` onto a command line. Use `gh auth`. Never print secret values from Actions, Codespaces, Dependabot, environments, or credential helpers.

### Confirm before

Show the concrete command and get explicit confirmation for:

- force push; history rewrite (`filter-repo` / `filter-branch` / squash-reword of pushed commits)
- `reset --hard`, `clean -fdx`, restoring over uncommitted work
- deleting branches/tags (local or remote); moving or re-pushing tags
- publishing a release; submitting/approving a PR review; merging a PR
- work on a branch that isn't yours
- deleting/transferring/archiving/renaming a repo or changing visibility
- deleting Projects, issues, Discussions, releases, packages, Codespaces, workflow runs, caches, environments, secrets, variables, deploy keys, webhooks, rulesets, or org resources
- granting/escalating access; changing branch protection or bypass actors
- publishing packages, advisories, Discussion announcements, Pages, gists, or other public artifacts
- bulk close/move/retaxonomize where rollback is not exact

Ordinary issues, labels, milestones, project items, comments, draft PRs, and metadata are authorized when the user asked and scope is clear. Preview first when the mutation is broad, cross-repo, public, permission-changing, or hard to reverse.

Routine local work—commit (when autocommit is on or the user asked), branch, stash, fetch, push **your** branch—proceeds normally. See [Autocommit](#autocommit).

### Remote-write discipline

- Resolve targets read-only before mutation.
- Prefer dedicated `gh` commands; `gh api` only when CLI lacks the capability.
- Treat IDs/cursors/node IDs as opaque—read and reuse; never invent.
- Bulk ops: repeat-safe identity; separate create / relate / update / delete passes; report counts and exceptions; never call a partial batch complete.
- Bound concurrency; back off on rate limits.
- No web UI automation when `gh`/API can do it.
- State-sensitive writes: bind to reviewed state (PR merge: `--match-head-commit <sha>`).

### Remote body and metadata safety

Never pipe an unchecked transform into `gh issue/pr edit --body-file -` (empty stdin can wipe a body).

1. Retain the exact pre-image  
2. Render the full proposed body  
3. Validate producer exit, non-empty output, markers, target, diff  
4. Write from a validated artifact  
5. Re-read and compare  

On damage: restore pre-image when authorized; report failure and restoration.

### Back up before destroying

Before rewrite, force push, hard reset, or branch deletion that could drop commits:

```bash
git branch backup/<what>-$(date +%Y-%m-%d)
git rev-parse 'backup/<what>^{tree}' '<newref>^{tree}'
```

Compare **tree hashes**, not subjects. Keep the backup until confirmed.

### Force push

Pinned lease only — details in [rewrite.md](reference/rewrite.md):

```bash
git push --force-with-lease=<branch>:<expected-old-sha> origin <branch>
```

Never bare `--force` or bare `--force-with-lease`. Afterward: say SHAs changed; other clones need fetch + reset or a fresh clone.

### Stop, don't improvise

Stop and report (no silent abort, no `--no-verify`, no unchanged retry):

- merge/rebase conflict; failing hook; rejected push
- detached HEAD or dirty tree you didn't create
- host/account mismatch; missing scopes/permissions
- ambiguous repo/project/environment/package/branch/issue target
- API/CLI semantic mismatch; bulk counts that diverge from plan

Transient API: retry only failed idempotent ops whose post-state can be checked. Implementation/CI you own: **three attempts, then escalate**. Never green CI by skipping tests, loosening asserts, or `continue-on-error`.

### Multiple repositories

Cross-repo change → [delivery.md](reference/delivery.md). Sequential, not atomic. Stop at first failure; report partial state. Keep issues in the owning repo; use Projects for aggregate planning.

## GitHub operating model

| Object | Owns |
|---|---|
| Repository | Code, settings, permissions, automation, security boundary |
| Milestone | Repo-scoped release or outcome |
| Parent issue | Cohesive independently understandable outcome |
| Native subissue | Independently reviewable implementation slice |
| Issue checklist | Steps below PR size |
| Blocking relationship | Real dependency |
| Pull request | Proposed change + validation record |
| Project | Cross-repo planning, fields, views |
| Discussion | Open-ended conversation, not committed work |
| Release | Published version + immutable artifact narrative |

Do not duplicate native relationships as manual checklists. Do not use labels as a second hierarchy when milestones, parents, subissues, dependencies, and Project fields already own the dimension.

## Command and output standards

- Prefer `--json` + `--jq` / `--template` over scraping human output.
- `gh help <command>` before unfamiliar flags.
- `--repo HOST/OWNER/REPO` for nonlocal/scripted work.
- Paginate unless truncation is intentional.
- Validated temp file / stdin artifact for multiline bodies—no shell interpolation of Markdown, secrets, backticks, `$()`.
- Never connect an unchecked producer to a mutating `gh` command.
- Inspect exit status **and** body (GraphQL may 200 with `errors`).

## Commit and merge messages

One subject line only. Never create, preserve, copy, or infer a commit/merge body—ordinary commits, amend/reword, squash, rewrite, and GitHub merges. Details live in the issue or PR body. If the repo/platform requires a non-empty body, stop and report; do not invent one. Form: [conventions.md](reference/conventions.md).

## Autocommit

**On by default.** When a unit of work reaches a clean boundary ([commit.md](reference/commit.md)), commit it rather than leaving unrelated changes piled in the tree.

- `autocommit on` (default) — commit at clean boundaries; may stage in-scope generated output (docs, fixtures, lockfiles) with the change that produced them.
- `autocommit off` — at a boundary, name it and suggest a subject; stage/commit only when asked.

Session-scoped only. Never authorizes **Confirm before** actions. Subject-only rule still applies.

## Workflow models

Read when merging, branching, or releasing:

| Model | Tell | Implications |
|---|---|---|
| **GitHub flow** | Short branches → one default | Branch, PR, land |
| **Trunk-based** | Direct default-branch commits, flags | Small commits; CI is the gate |
| **Git flow** | `develop` + `release/*` + `hotfix/*` | Features → `develop`; hotfixes from tags |
| **Release train** | Long-lived version lanes, `--no-ff` | Never rebase/delete lane branches |
| **Fork-based** | `origin` fork remote, `upstream` canonical | Never push `upstream`; sync from it (`origin` here = **git remote name**, not Cursor Origin) |

Detect via `git branch -a`, `git log --graph`, `CONTRIBUTING.md`. If ambiguous, ask once.

## Reporting back

After ref moves: what moved with SHAs; what you skipped and why; undo path for anything destructive (backup ref or `git reset --hard <sha>`).

After GitHub mutations: exact repo/project and object URLs/numbers; created/updated/linked/closed/deleted/skipped/failed counts; verified relationships/fields; remaining permission/UI gaps; whether local checkouts changed; after merge, each checkout's branch/upstream/cleanliness/sync; branch deletion separately from merge.

## Escalation

Outside these rules → one sentence and stop. A wrong permitted git op on a shared branch costs more than a question.
