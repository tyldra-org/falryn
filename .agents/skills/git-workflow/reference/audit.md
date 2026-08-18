# audit

Repository hygiene: what's leaking, what's bloating, what's stale.

## Secret scan

```bash
git grep -nEI '(api[_-]?key|secret|password|token|BEGIN [A-Z ]*PRIVATE KEY|aws_access_key_id)' -- . ':!*.lock' ':!*test*'
git log --all --diff-filter=A --name-only --pretty=format: | sort -u | grep -Ei '\.(env|pem|p12|key|jks)$|credentials|id_rsa'
```

Scan history, not just the working tree — a file deleted three commits ago is still in every clone.

Also check what's *tracked* that shouldn't be:

```bash
git ls-files | grep -Ei '^\.env|\.pem$|\.p12$|credentials\.json|id_rsa'
```

## Secret-leak response

Order matters. Getting it wrong wastes the window when it counts.

1. **Rotate the credential. Immediately, before anything else.** Assume it is compromised the moment it hit a remote — bots scrape public pushes within seconds, and it's in every clone, every fork, every CI log, and the remote's reflog. History rewriting does not un-leak it.
2. **Check for use.** Provider audit logs, unexpected API calls, unfamiliar IPs.
3. **Stop the bleeding.** Add the path to `.gitignore`; `git rm --cached <path>`; commit.
4. **Then**, and only if the user wants it, purge from history — [rewrite.md](rewrite.md#repo-wide-history-rewriting). Explain the cost first: every clone breaks, every open PR breaks, every SHA in a ticket goes stale.
5. **Ask the host to expire cached views.** On GitHub, force-pushed and dangling commits stay reachable by SHA until support purges them. The rewrite alone leaves the secret fetchable.
6. **Record it.** What leaked, when, rotated when, purged or not.

Never report a leak as "fixed" after step 4. Fixed is after rotation.

## Large files

```bash
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1=="blob" && $3>1000000 {print $3, $4}' | sort -rn | head -20
du -sh .git
```

A `.git` much larger than the checkout means history carries something the working tree doesn't. Candidates for Git LFS or for removal from history.

Committed binaries are permanent by default — every clone downloads every version forever. Catch them before commit ([commit.md](commit.md)), not in an audit six months later.

## Ignore rules

```bash
git status --ignored --short | head -30
git check-ignore -v <path>           # why is this ignored
```

Check that `.gitignore` covers: build output, dependency dirs, editor state (`.idea/`, `.vscode/` unless shared), OS files (`.DS_Store`, `Thumbs.db`), local env (`.env*`, `!.env.example`), coverage, caches, logs.

`.env.example` should be tracked and should contain **no real values** — placeholder strings only. It's the most common accidental-leak path because it looks safe.

## Stale branches

```bash
git fetch --prune
git branch -vv | grep ': gone]'                                   # remote deleted
git for-each-ref --sort=committerdate refs/remotes/origin --format='%(committerdate:short) %(refname:short)' | head -20
```

Report the list with ages. Never bulk-delete — each deletion is its own ask, and each needs the unlanded-commit check from [branch.md](branch.md#deleting).

## Line endings

```bash
cat .gitattributes 2>/dev/null
git ls-files --eol | grep -v 'i/lf' | head
```

A repo with no `.gitattributes` and mixed-OS contributors gets whole-file phantom diffs. The fix is `* text=auto eol=lf` in `.gitattributes` plus a one-time renormalization (`git add --renormalize .`) — flag it, don't do it unasked; it touches every file.

## Signing

```bash
git config --get commit.gpgsign
git log --show-signature -3
```

If the repo signs, keep signing. If the branch protection requires signatures, an unsigned commit will be rejected at push time — check before, not after.

## Config sanity

```bash
git config --list --local
```

Watch for: a `user.email` that leaks a personal address into a work repo (or vice versa), `push.default = matching`, credentials in a remote URL (`https://user:token@host/...` — a leak sitting in `.git/config`).

## Health summary

Report as findings, severity-ordered. Do not fix anything during an audit — an audit that edits is a refactor with no review.
