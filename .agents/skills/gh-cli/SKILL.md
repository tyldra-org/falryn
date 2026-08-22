---
name: gh-cli
description: >-
  GitHub CLI (`gh`) for github.com — command syntax and GitHub process (issues,
  PRs, Actions, Projects, checks, merge, admin). Use when working on GitHub.
  Does **not** cover git porcelain (git-workflow) or other forge workflows.
---

# GitHub CLI (`gh`)

Command-line reference and **GitHub process** for **github.com**.

**Not in scope:** `git` porcelain (**git-workflow**) or non-GitHub forge workflows.

Preserved syntax notes from [github/awesome-copilot `gh-cli`](https://www.skills.sh/github/awesome-copilot/gh-cli) (commit `8395dce`). Verify flags with `gh <cmd> --help` / `gh --version` when behavior may have changed.

## Skill boundaries

| Question | Load |
| --- | --- |
| "What flags for `gh pr create`?" | **gh-cli** (this) — [reference/pr.md](reference/pr.md) |
| "Open / review / merge a GitHub PR?" | **gh-cli** (this) — [process/pr.md](process/pr.md), [process/merge.md](process/merge.md) |
| "Commit / branch / rebase / force-push?" | **git-workflow** |
| "Use a non-GitHub forge?" | Use that platform's approved workflow |

## Rules

1. Run `gh auth status` (and `gh repo view` when repo-scoped) before mutating.
2. Prefer dedicated `gh` subcommands over raw `gh api` when they exist.
3. Prefer `--json` + `--jq` over scraping human tables.
4. Never print tokens (`gh auth token`, `GH_TOKEN`, `.git-credentials`) into chat or logs.
5. Destructive flags (`delete`, `--yes`, merge, secret overwrite) need explicit user confirmation unless already authorized.
6. Load **one** process or syntax reference below for the task; do not ingest the whole tree.
7. Git history changes still follow **git-workflow** (commit, push, rebase, recover).

## Process routing

| Request sounds like | Reference |
|---|---|
| "open a PR", "get this reviewed", "ship it" | [process/pr.md](process/pr.md) |
| "look at PR #N", "is this safe to merge" | [process/review.md](process/review.md) |
| "walk me through this PR", "what files changed", "what could this PR break" | `change-review` plus [process/review.md](process/review.md) |
| "merge this GitHub PR", "land this PR" | [process/merge.md](process/merge.md) |
| "coordinate these PRs/repos", "land docs then code" | [process/delivery.md](process/delivery.md) |
| "assign issue", "move card to In Progress/Done", "reconcile board after merge" | [process/issue-lifecycle.md](process/issue-lifecycle.md) |
| "CI is red", "why is the build failing", "wait for checks" | [process/ci.md](process/ci.md) |
| "authenticate gh", "which repo/account/host is this" | [process/context-and-auth.md](process/context-and-auth.md) |
| "create/update/triage issues, labels, milestones, subissues" | [process/issues.md](process/issues.md) |
| "build or maintain a roadmap/project/board" | [process/projects.md](process/projects.md) |
| "configure a repo, ruleset, collaborator, webhook, environment" | [process/repository-admin.md](process/repository-admin.md) |
| "dispatch/rerun/cancel a workflow; artifacts, caches, secrets" | [process/actions.md](process/actions.md) |
| "Dependabot, code scanning, secret scanning, advisories" | [process/security.md](process/security.md) |
| "use gh api/GraphQL, paginate, or change many GitHub objects" | [process/api-and-bulk.md](process/api-and-bulk.md) |
| "Discussion, Codespace, package, gist, organization, search" | [process/github-surfaces.md](process/github-surfaces.md) |
| "cut a GitHub release", "publish release notes" | [process/release.md](process/release.md) |

## Syntax routing

| Task | Reference |
| --- | --- |
| Install, config, env vars | [reference/setup.md](reference/setup.md) |
| Auth / switch accounts / setup-git | [reference/auth.md](reference/auth.md) |
| Full command tree | [reference/cli-structure.md](reference/cli-structure.md) |
| `gh browse` | [reference/browse.md](reference/browse.md) |
| `gh repo` | [reference/repo.md](reference/repo.md) |
| `gh issue` | [reference/issue.md](reference/issue.md) |
| `gh pr` | [reference/pr.md](reference/pr.md) |
| Actions: `run` / `workflow` / `cache` | [reference/actions.md](reference/actions.md) |
| `gh project` | [reference/project.md](reference/project.md) |
| `gh release` | [reference/release.md](reference/release.md) |
| `gh gist` | [reference/gist.md](reference/gist.md) |
| `gh codespace` | [reference/codespace.md](reference/codespace.md) |
| `gh org` | [reference/org.md](reference/org.md) |
| `gh search` | [reference/search.md](reference/search.md) |
| `gh label` | [reference/label.md](reference/label.md) |
| SSH / GPG keys | [reference/keys.md](reference/keys.md) |
| `gh status` | [reference/status.md](reference/status.md) |
| Extensions | [reference/extension.md](reference/extension.md) |
| Aliases | [reference/alias.md](reference/alias.md) |
| `gh api` / GraphQL | [reference/api.md](reference/api.md) |
| Rulesets | [reference/ruleset.md](reference/ruleset.md) |
| Attestations | [reference/attestation.md](reference/attestation.md) |
| Completion, preview, agent-task, global flags | [reference/misc.md](reference/misc.md) |
| JSON, templates, pagination | [reference/output.md](reference/output.md) |
| Copy-paste workflow recipes | [reference/workflows.md](reference/workflows.md) |
| Practices & help links | [reference/practices.md](reference/practices.md) |

## Quick patterns

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef,url
gh issue list --repo OWNER/REPO --limit 20 --json number,title,state
gh pr create --base <default> --title "type(scope): summary" --body-file /tmp/pr.md
gh pr checks <n>
gh run watch RUN_ID --repo OWNER/REPO --exit-status
gh run list --limit 10
gh api graphql -f query='query { viewer { login } }'
```

Repo override without cwd inference: `--repo OWNER/REPO` or `GH_REPO=OWNER/REPO`.

## GitHub process safety

### Confirm before

Show the concrete command and get explicit confirmation for:

- publishing a GitHub release; submitting/approving a PR review; merging a PR
- deleting/transferring/archiving/renaming a repo or changing visibility
- deleting Projects, issues, Discussions, releases, packages, Codespaces, workflow runs, caches, environments, secrets, variables, deploy keys, webhooks, rulesets, or org resources
- granting/escalating access; changing branch protection or bypass actors
- publishing packages, advisories, Discussion announcements, Pages, gists, or other public artifacts
- bulk close/move/retaxonomize where rollback is not exact

Ordinary issues, labels, milestones, project items, comments, draft PRs, and metadata are authorized when the user asked and scope is clear. Preview first when the mutation is broad, cross-repo, public, permission-changing, or hard to reverse.

Git history confirmations (force push, rewrite, hard reset) stay in **git-workflow**.

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

### Command and output standards

- Prefer `--json` + `--jq` / `--template` over scraping human output.
- `gh help <command>` before unfamiliar flags.
- `--repo HOST/OWNER/REPO` for nonlocal/scripted work.
- Paginate unless truncation is intentional.
- Validated temp file / stdin artifact for multiline bodies—no shell interpolation of Markdown, secrets, backticks, `$()`.
- Never connect an unchecked producer to a mutating `gh` command.
- Inspect exit status **and** body (GraphQL may 200 with `errors`).

### GitHub operating model

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

### Reporting back

After GitHub mutations: exact repo/project and object URLs/numbers; created/updated/linked/closed/deleted/skipped/failed counts; verified relationships/fields; remaining permission/UI gaps; whether local checkouts changed; after merge, each checkout's branch/upstream/cleanliness/sync (**git-workflow** `sync.md`); branch deletion separately from merge.

## Relationship to other skills

| Skill | Role |
| --- | --- |
| **git-workflow** | Git porcelain and git history safety |
| **gh-cli** (this) | `gh` syntax + GitHub process |

Project-specific delivery orchestration (selectors, stop rules, repo docs) lives in that project's loop skill. This skill supplies the generic GitHub and Project mechanics those loops call. Repositories may **vendor** this skill under `.agents/skills/` so every checkout gets the same guidance without a global install.

Do not document `git commit` / rebase / force-push here — that is **git-workflow**.
