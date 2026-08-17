---
name: gh-cli
description: >-
  GitHub CLI (`gh`) **syntax only** — subcommands, flags, `--json`/`--jq`, and
  `gh api` paths for github.com. Use for composing or debugging `gh` commands.
  Does **not** decide commit/merge safety or delivery order (github-workflow) and
  does **not** cover the Cursor `origin` CLI (origin-cli).
---

# GitHub CLI (`gh`)

Command-line reference for **`gh`** against **GitHub (github.com)**.

**Not in scope:** `git` commands, Cursor **`origin`** CLI, or whether an operation is safe — see [Skill boundaries](#skill-boundaries).

Preserved from [github/awesome-copilot `gh-cli`](https://www.skills.sh/github/awesome-copilot/gh-cli) (commit `8395dce`) after upstream removal. Verify flags with `gh <cmd> --help` / `gh --version` when behavior may have changed.

## Skill boundaries

| Question | Load |
| --- | --- |
| "What flags for `gh pr create`?" | **gh-cli** (this) |
| "Should I merge / open PR / force push?" | **github-workflow** |
| "`origin pr merge` vs `gh pr merge`?" | **origin-cli** for `origin …`; **gh-cli** for `gh …` |
| "Sync rulesets to Origin" | **origin-cli** (+ **gh-cli** to *read* GitHub rulesets) |
| "Install Origin / login to origin.cursor.com" | Cursor built-in **`origin`** skill |

**This skill does not replace `github-workflow`.** Workflow owns confirmations, delivery order, and git history safety. When both apply: follow **github-workflow** for process; use this skill for exact `gh` spelling.

**Never use `gh` for Origin forge operations.** Origin has its own CLI (`origin …`) documented in **origin-cli**.

## Rules

1. Run `gh auth status` (and `gh repo view` when repo-scoped) before mutating.
2. Prefer dedicated `gh` subcommands over raw `gh api` when they exist.
3. Prefer `--json` + `--jq` over scraping human tables.
4. Never print tokens (`gh auth token`, `GH_TOKEN`, `.git-credentials`) into chat or logs.
5. Destructive flags (`delete`, `--yes`, merge, secret overwrite) need explicit user confirmation unless already authorized by a higher workflow skill.
6. Load **one** reference below for the task; do not ingest the whole tree.

## Routing

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
gh run list --limit 10
gh api graphql -f query='query { viewer { login } }'
```

Repo override without cwd inference: `--repo OWNER/REPO` or `GH_REPO=OWNER/REPO`.

## Relationship to other skills

| Skill | Role |
| --- | --- |
| **github-workflow** | Process, safety, confirmations, delivery — load **first** for GitHub mutations |
| **gh-cli** (this) | `gh` flag/syntax only |
| **origin-cli** | `origin` flag/syntax + Origin RPC — not `gh` |
| **`origin`** (Cursor built-in) | Install/login repair for Origin CLI only |

Do not duplicate workflow rules here. Do not document `origin pr` here — that is **origin-cli**.
