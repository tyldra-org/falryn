# context

Resolve the GitHub host, account, repository, capabilities, and permissions before acting.

## Inspect

```bash
gh --version
gh auth status
gh config get git_protocol
git remote -v
gh repo view --json nameWithOwner,defaultBranchRef,url,visibility
```

Use `gh auth status --hostname <host>` for GitHub Enterprise. Never assume `github.com`, the active account, `origin`, or the current directory identifies the requested target.

For remote-only work, require one stable selector: `HOST/OWNER/REPO`, repository URL, issue/PR URL, or an owner plus Project number.

## Authenticate safely

The user performs interactive login:

```bash
gh auth login
gh auth refresh --hostname github.com --scopes read:org,repo,project,workflow
```

Request only scopes needed by the operation. Common needs:

| Work | Typical scope or permission |
|---|---|
| Private repository read/write | `repo` |
| Organization metadata | `read:org` |
| Projects | `project` |
| Workflow-file mutation | `workflow` |
| Packages | package-specific read/write/delete permission |

Scope possession does not prove repository, organization, environment, or Project authorization. Verify the actual operation read-only first.

Never run `gh auth token`, print credential files, inject a token into `curl`, or place tokens in command arguments, logs, issue bodies, or scripts.

Automation may receive a token through the runner's protected environment. Treat `GH_TOKEN`/`GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` as secret inputs with host-specific precedence. Never echo them, forward them to an unverified process, or persist them in Git configuration.

## Resolve repository and branch

```bash
gh repo view https://<host>/<owner>/<repo> \
  --json nameWithOwner,defaultBranchRef,isArchived,visibility,url
git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null
```

Check for forks and upstreams:

```bash
gh repo view --json isFork,parent,owner,name
git remote -v
```

Do not push to an upstream repository from a fork workflow. Do not write to archived repositories or protected/default branches without explicit scope.

## Choose the interface

1. Prefer a connected GitHub tool for structured issue/PR operations when available.
2. Prefer dedicated `gh` commands for local-branch discovery, GitHub CLI-only capabilities, and reproducible scripts.
3. Use `gh api` for missing REST/GraphQL capabilities.
4. Use the browser only for settings not exposed by tools or APIs.

Keep connector and local context aligned. Re-resolve repository and account after switching worktrees, hosts, or authenticated users.

## Version and capability checks

Flags evolve. Before using a capability that may be recent:

```bash
gh issue create --help
gh issue edit --help
gh project --help
gh ruleset --help
```

If the installed CLI lacks a documented flag, use an official API fallback or report the version blocker. Do not approximate a native relationship with body text.

GitHub.com and GitHub Enterprise Server can expose different features even with the same local CLI. Verify server capability and permissions before using issue relationships, Projects, rulesets, attestations, or previews.

## API gateway configuration

Recent CLI versions can set a per-host `api_host`:

```bash
gh config get api_host --host <github-host>
gh config set api_host <gateway-host> --host <github-host>
```

This setting is experimental. It routes API traffic through a gateway but keeps the original host for authentication, Git remotes, and browser URLs, and it is not a security boundary. Changing it affects later commands for that host. Inspect current help, verify the gateway owner and TLS name, and re-read the value after an authorized change.

## Stop conditions

Stop on:

- wrong account or hostname;
- ambiguous repository or owner;
- missing scope or permission;
- archived, transferred, or renamed target not acknowledged by the user;
- local remote and requested repository disagreement;
- a CLI/API version difference that changes semantics.
