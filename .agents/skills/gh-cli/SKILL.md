---
name: gh-cli
description: GitHub CLI (gh) command reference for repos, issues, PRs, Actions, projects, releases, gists, codespaces, orgs, search, api, secrets, and extensions. Use when composing or debugging gh commands, flags, JSON/--jq output, or auth/config via the CLI.
---

# GitHub CLI (gh)

Command-line reference for `gh`. Prefer this skill for **flag/syntax recall**; use `github-workflow` for commit/PR/merge safety, confirmation gates, and delivery procedure.

Preserved from [github/awesome-copilot `gh-cli`](https://www.skills.sh/github/awesome-copilot/gh-cli) (commit `8395dce`) after upstream removal. Verify flags with `gh <cmd> --help` / `gh --version` when behavior may have changed.

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

## Relationship to github-workflow

| Concern | Skill |
| --- | --- |
| How to run `gh …` safely with history/delivery rules | `github-workflow` |
| Exact subcommands, flags, examples | **this skill** |

When both apply: follow `github-workflow` for process; use these references for CLI syntax.
