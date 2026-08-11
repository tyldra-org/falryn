---
name: github-workflow
description: Comprehensive Git and GitHub operating workflow. Use whenever work touches repositories, commits, branches, worktrees, remotes, pull requests, reviews, issues, labels, milestones, native subissues and dependencies, GitHub Projects, Discussions, Actions, releases, repository administration, rulesets, security alerts, secrets and variables, Codespaces, packages, gists, search, organizations, authenticated REST/GraphQL automation, multi-repository delivery, or post-merge checkout synchronization through git or gh. Also use for recovery, history rewriting, audits, bulk roadmap maintenance, and any request that will end in a commit or outward-facing GitHub change. Provides safety, confirmation, idempotency, provenance, and verification rules; not for application-code quality review by itself.
---

Operate Git and GitHub with clean, recoverable, auditable history and explicit remote state. Make every commit reviewable, every platform mutation target-specific, and every irreversible or socially consequential action deliberate.

## How to use this skill

Four steps, in order. Steps 1 and 2 are cheap and always worth it; step 3 is where the actual procedure lives.

### 1. Resolve context and read state

```bash
git status --short --branch
git log --oneline -10
git remote -v
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef,url 2>/dev/null
```

For local Git work, never act on an assumed branch, worktree, remote, or default branch. For GitHub-only work, a local checkout is optional: resolve the exact hostname, owner, repository, issue/PR/project number, and authenticated account instead.

If Git errors with `not a git repository`, do not initialize one uninvited. Continue only when the task is explicitly remote-only and the repository is independently identified.

If the tree is mid-rebase, mid-merge, or on a detached HEAD you didn't create, stop and report that before anything else. Acting inside a half-finished operation compounds it.

### 2. Route to a reference

Match the request to one command below and **read that reference before acting**. The reference owns the flow; skipping it produces plausible-looking git that misses the step that mattered.

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

Writing any commit subject, branch name, PR title, release tag, issue taxonomy, or roadmap hierarchy? Also read [conventions.md](reference/conventions.md); for issue hierarchy and Projects, the dedicated references control.

Read every reference needed for a mixed workflow, in dependency order. Example: creating milestone-backed subissues in a Project requires `context`, `issues`, then `projects`; publishing code requires `commit`, `sync`, then `pr`; landing a coordinated code-and-docs bundle requires `review`, `delivery`, then `merge`.

Ask only when two routes imply materially different outcomes or authority. Do not ask merely because several references apply. When destructive intent is vague, resolve the desired outcome before choosing a command.

**When nothing fits** — a one-off query like `git status` or "what's on this branch" — just answer it. Not every git question needs a reference loaded.

### 3. Gather only the context that task needs

Reading convention costs tokens, so pay for it when it changes the answer:

**Touching the remote or the default branch** — resolve which branch that actually is. Do not assume `main`:

```bash
git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null \
  || git remote show origin | sed -n '/HEAD branch/s/.*: //p'
```

**Writing a subject, branch name, or PR title** — the repo already answered how these should look:

```bash
git log --pretty=%s -n 30      # subject style, types, scopes
git branch -a                  # branch naming
git log --graph --oneline -20  # merge topology
```

**Merging, branching, or releasing** — identify the workflow model, since the same advice is wrong in the others. See [Workflow models](#workflow-models).

Also check `CONTRIBUTING.md`, `AGENTS.md`, `commitlint.config.*`, `.gitmessage`, `.github/PULL_REQUEST_TEMPLATE.md`. A repo that states its rules outranks anything inferred.

For GitHub objects, inspect before writing:

```bash
gh issue view <n> --repo <owner/repo> --json number,title,state,labels,milestone,parent,subIssues
gh pr view <n> --repo <owner/repo> --json number,title,state,baseRefName,headRefName,statusCheckRollup
gh project view <n> --owner <owner> --format json
gh project field-list <n> --owner <owner> --format json
```

Use `--repo`, `--owner`, `--hostname`, issue/PR number, and project number explicitly in scripts and bulk work. Do not let current-directory inference select a write target.

### 4. Act, then report

Follow the reference. Re-read the affected object after each write class, audit the final set, and describe what moved. A command returning exit zero proves only that GitHub accepted the request, not that relationships, fields, permissions, automation, or UI-visible state are correct.

### Worked example

> **User:** "been hacking on this for a couple hours, can you get everything committed"

1. `git status --short --branch` → four modified files across `src/auth/`, `src/billing/`, `README.md`, plus an untracked `.env`.
2. Routes to `commit` → read `commit.md`.
3. Task writes subjects → `git log --pretty=%s -n 30` shows `feat:`/`fix:` with no scopes. Match that. Read `conventions.md`.
4. Follow `commit.md`: read the actual diffs → the changes are three unrelated things, so three commits, staged by explicit path. `.env` holds live credentials — **stop and flag it**, add to `.gitignore`, never stage it.
5. Report: three commits with SHAs, the `.env` decision, and that no test runner exists so validation was skipped.

The shape to notice: state first, one reference, convention only because subjects were being written, and the safety rule interrupting the happy path.

## Precedence

**Safety rules never bend.** Everything else here is a default that loses to anything more specific:

1. The user's explicit instruction, this session.
2. Repo-local rules — `CONTRIBUTING.md`, `AGENTS.md`, `commitlint.config.*`, PR templates.
3. The repo's observed convention — what `git log` and `git branch -a` actually show.
4. The defaults in this skill.

When a lower layer conflicts with a higher one, the higher one wins silently — don't announce the override, just follow it. But no repo convention authorizes committing a secret or a bare `--force`.

## Safety rules

Non-negotiable. These aren't preferences; each one prevents an unrecoverable or externally-visible mistake.

### Secrets

Never stage or commit credentials, API keys, tokens, private keys, `.env` files, service-account JSON, or connection strings with embedded passwords. If a path could contain one, stop and ask — "already tracked" is not consent to add more.

If a secret is already committed, treat it as leaked. **Rotation comes first, history rewriting second** — see [reference/audit.md](reference/audit.md#secret-leak-response).

Never read a token out of the environment or `.git-credentials` into a command line. Use `gh auth`.

Never print secret values from Actions, Codespaces, Dependabot, environments, variables intended to be confidential, encrypted files, or credential helpers. Secret APIs are write-only by design; verify names and scopes, not values.

### Confirm before

Anything **irreversible** or **outward-facing** gets an explicit confirmation, with the concrete command shown:

- force push, in any form
- history rewrite: `filter-repo`, `filter-branch`, squash/reword of pushed commits
- `reset --hard`, `clean -fdx`, `checkout .` / `restore` over uncommitted work
- deleting a branch or tag, locally or remotely
- moving or re-pushing an existing tag
- publishing a release
- submitting or approving a PR review, merging a PR
- anything on a branch that isn't yours
- deleting, transferring, archiving, changing visibility of, or renaming a repository
- deleting Projects, issues, Discussions, releases, packages, Codespaces, workflow runs, caches, environments, secrets, variables, deploy keys, webhooks, rulesets, or organization resources
- granting or escalating collaborator/team/app access; changing branch protection or bypass actors
- publishing a package, advisory, Discussion announcement, Pages deployment, gist, or other public artifact
- bulk-closing, bulk-moving, or bulk-retaxonomizing work where rollback is not exact

Creating or editing ordinary issues, labels, milestones, project items, comments, draft PRs, workflow drafts, and metadata is authorized when the user asks for that workflow and the exact scope is clear. Show a preview first when the mutation is broad, cross-repository, public-facing, permission-changing, or difficult to reverse.

Routine local work—committing, branching, stashing, fetching, and pushing your own branch—proceeds normally.

### Remote-write discipline

- Resolve exact targets read-only before mutation.
- Prefer dedicated `gh` commands; use `gh api` only when the CLI or connected GitHub tooling lacks the capability.
- Treat IDs, cursors, field IDs, option IDs, node IDs, and installation IDs as opaque. Read and reuse them; never derive or invent them.
- Make bulk operations repeat-safe using stable identity such as repository plus issue number, exact title within a constrained parent, or immutable node ID.
- Separate create, relationship, field-update, and close/delete passes so a partial failure is observable and recoverable.
- Capture before/after counts and exceptions. Never call a partial batch “complete.”
- Respect rate limits and abuse controls; paginate, bound concurrency, and back off rather than retrying in a tight loop.
- Do not use web UI automation when `gh`, a GitHub connector, REST, or GraphQL can make the operation explicit and auditable.
- Bind state-sensitive writes to the exact state that was reviewed when the command supports it. For PR merges, prefer `--match-head-commit <verified-head-sha>`.

### Remote body and metadata safety

Never pipe an unchecked transform directly into a mutating command such as `gh issue edit --body-file -` or `gh pr edit --body-file -`. A failed producer can still supply empty stdin and erase a valid body.

For issue, PR, release, Discussion, or repository text:

1. Read and retain the exact pre-image.
2. Render the complete proposed body before any write.
3. Validate producer exit status, non-empty output, required markers, target identity, and the intended diff.
4. Write from a validated temporary file or in-memory artifact, not a live transformation pipeline.
5. Re-read the object after mutation and compare it with the proposal.

If a pipeline is unavoidable, enable pipeline-failure propagation and still materialize and validate its output before mutation. If verification finds damaged or empty metadata, restore the retained pre-image immediately when authorized and report both the failure and restoration.

### Back up before destroying

Before a history rewrite, force push, hard reset, or branch deletion that could drop commits:

```bash
git branch backup/<what>-$(date +%Y-%m-%d)
```

Verify by **comparing tree hashes**, never by reading commit subjects — subjects survive rewrites that lose content:

```bash
git rev-parse 'backup/<what>^{tree}' '<newref>^{tree}'
```

Keep the backup ref until the outcome is confirmed.

### Force push

`--force-with-lease` pinned to the exact expected old SHA. Never bare `--force`; never bare `--force-with-lease` either — if anything ran `git fetch` in between, the lease checks a refreshed remote-tracking ref and passes when it should fail.

```bash
git push --force-with-lease=<branch>:<expected-old-sha> origin <branch>
```

Afterward: state that SHAs changed and that other clones need `git fetch && git reset --hard origin/<branch>` or a fresh clone.

### Stop, don't improvise

Stop and report — no auto-resolve, no retry unchanged, no silent abort:

- a merge or rebase conflict
- a failing pre-commit hook (never `--no-verify` past one)
- a rejected push
- a detached HEAD or dirty tree you didn't create
- an authenticated host/account mismatch
- missing scopes or insufficient repository/organization/project permission
- ambiguous repository, project, environment, package, branch, or issue target
- an API schema, preview, or CLI-version mismatch that changes the requested semantics
- a bulk mutation whose observed counts diverge from the planned set

For transient API failures, retry only failed idempotent reads or writes whose post-state can be checked. For implementation/CI failures that are yours to fix: **three attempts, then escalate**. Never make CI pass by skipping a test, loosening an assertion, or adding `continue-on-error`.

### Multiple repositories

When a change spans repos (service + schema, app + infra, code + docs), treat it as an explicit delivery bundle and follow [delivery.md](reference/delivery.md). Commit each repository separately with its own subject, declare owners and landing order, bind each PR to the reviewed head SHA, and name every repository touched in the summary.

Cross-repository delivery is sequential, not atomic. Stop at the first failure, preserve the successful and pending states exactly, and report the partial result. Never call the bundle complete while one side is unmerged, unverified, or locally dirty.

For cross-repository GitHub planning, keep each issue in the repository that owns the implementation or documentation. Use Projects for aggregate planning; do not move ownership into a central issue merely to obtain one board.

## GitHub operating model

Use the smallest durable object that owns the concern:

| Object | Owns |
|---|---|
| Repository | Code, settings, permissions, automation, security boundary |
| Milestone | Repository-scoped release or outcome |
| Parent issue | Cohesive independently understandable outcome |
| Native subissue | Independently reviewable implementation slice |
| Issue checklist | Steps below pull-request size |
| Blocking relationship | Real dependency, not approximate ordering |
| Pull request | Proposed code/document change and validation record |
| Project | Cross-repository live planning, fields, views, prioritization |
| Discussion | Open-ended community/team conversation, not committed work |
| Release | Published version and immutable artifact narrative |

Do not duplicate native relationships as manually maintained checklists. Do not use labels as a second hierarchy when milestones, parent issues, subissues, dependencies, and Project fields already own the dimensions.

## Command and output standards

- Prefer `--json` plus `--jq` or `--template` over scraping human output.
- Use `gh help <command>` or `<command> --help` before relying on recently added flags.
- Specify `--repo HOST/OWNER/REPO` for nonlocal and scripted work.
- Use `--limit` only when truncation is intended; otherwise paginate.
- Use a validated temporary file or validated stdin artifact for multiline bodies and API payloads; avoid shell interpolation of Markdown, secrets, backticks, and `$()`.
- Never connect an unchecked producer directly to a mutating `gh` command.
- Keep user-controlled text out of shell fragments. Prefer argument arrays in scripts.
- Inspect exit status and response content. GraphQL may return an HTTP success with an `errors` array.
- Use current official GitHub CLI/manual/API documentation for unstable or unfamiliar commands.

## Commit and merge messages

Use one subject line for every commit and merge result. Never create, preserve,
copy, or infer a commit body. This applies to ordinary commits, amend/reword
operations, squashes, rewritten history, and GitHub merges.

Keep validation, risks, issue links, rationale, delivery details, and session
narration in the issue or pull-request body. If a repository or platform
requires a non-empty commit or merge body, stop and report the incompatibility;
do not ask for, invent, or add one.

## Autocommit

Controls whether work gets committed as it completes, or only when asked. On by default: when a unit of work reaches a clean boundary ([reference/commit.md](reference/commit.md)), commit it rather than leaving a growing pile of unrelated changes in the tree — an uncommitted tree is the state most work gets lost from.

`autocommit off` — do not stage or commit on your own. When a boundary is reached, name it and suggest a subject in the summary instead, then move on. `git add` / `git commit` run only when asked.

`autocommit on` — resume. Also covers staging generated output that's directly in scope for the work (regenerated docs, updated fixtures, rebuilt lockfiles), so those don't need approval one at a time.

The setting applies to the current conversation only — it does not persist across sessions or follow you into another repo.

Autocommit governs whether the agent may create a commit; it does not change
the subject-only, no-body rule above. It never authorizes anything under
**Confirm before**: a session with autocommit on still stops before a force
push, a hard reset, or a branch deletion.

## Workflow models

Read this when merging, branching, or releasing — it decides branch base, merge strategy, and where hotfixes go. Skip it for a plain commit.

| Model | Tell | Implications |
|---|---|---|
| **GitHub flow** | Short branches, PRs into one default branch, no release branches | Most common. Branch, PR, land; delete only when policy or an explicit instruction authorizes it |
| **Trunk-based** | Commits directly on the default branch, feature flags, few branches | Small commits, no long-lived branches, CI is the gate |
| **Git flow** | `develop` + `release/*` + `hotfix/*` branches | Features target `develop`, hotfixes branch from tags, releases merge to both |
| **Release train** | Long-lived version or integration branches merged with `--no-ff`, visible as lanes in the graph | Never rebase or delete a lane branch; the topology is the record |
| **Fork-based** | `origin` is your fork, `upstream` is the source | Never push to `upstream`; sync via `upstream/<default>` |

Detect from `git branch -a`, `git log --graph`, and any `CONTRIBUTING.md`. If it stays ambiguous, ask once.

## Reporting back

Git work is invisible unless you describe it. The user cannot see your terminal, and "done" tells them nothing they can verify or undo.

After any operation that changed refs, state:

- **What moved**, with SHAs: `feat/rate-limiter: a1b2c3d → e4f5a6b (3 commits)`.
- **What you didn't do** and why — validation skipped, a file left unstaged, a second repo still dirty.
- **How to undo it**, for anything destructive: the backup ref name, or the `git reset --hard <sha>` that reverses it.

One or two lines. Not a transcript of the commands — the outcome and the escape hatch.

After GitHub-platform mutations, report:

- exact repository/project and object numbers or URLs;
- created, updated, linked, closed, deleted, skipped, and failed counts;
- relationships and fields verified after the write;
- scopes, permissions, automation, or UI-only settings still requiring attention;
- whether local repositories changed;
- after a merge, each affected checkout's branch, upstream, cleanliness, and synchronization state;
- branch deletion separately from merge and synchronization.

## Escalation

When something falls outside these rules, say so in one sentence and stop. A wrong-but-permitted git operation on a shared branch costs more than a question.
