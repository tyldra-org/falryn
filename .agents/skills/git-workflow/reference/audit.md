# audit

Repository hygiene: what's leaking, what's bloating, what's stale.

## Secret scan

Use the repository's configured secret scanner across the working tree and reachable history, with redaction enabled. A hand-written keyword search is only a triage aid; it misses many credential formats and produces false positives. Do not print a suspected secret merely to prove it matched.

```bash
git grep -IlE '(api[_-]?key|secret|password|token|BEGIN [A-Z ]*PRIVATE KEY|aws_access_key_id)' -- .
git log --all --diff-filter=A --name-only --pretty=format: \
  | sort -u | rg -i '\.(env|pem|p12|key|jks)$|credentials|id_rsa'
```

Scan history, not just the working tree. A file deleted three commits ago remains in existing clones and any reachable remote history.

Also check what's *tracked* that shouldn't be:

```bash
git ls-files | rg -i '^\.env|\.pem$|\.p12$|credentials\.json|id_rsa'
```

## Secret-leak response

Order matters. Getting it wrong wastes the window when it counts.

1. **Rotate the credential immediately.** Assume exposure once it reached a remote or log. History rewriting does not revoke it.
2. **Check for use.** Provider audit logs, unexpected API calls, unfamiliar IPs.
3. **Stop the bleeding.** Add the path to `.gitignore`; `git rm --cached <path>`; commit.
4. **Then**, and only if the user wants it, purge from history; [rewrite.md](rewrite.md#repo-wide-history-rewriting). Explain the cost first: clones need coordination, affected PRs and comparisons may break, and rewritten SHAs in external records go stale.
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

Committed binaries are permanent by default; every clone downloads every version forever. Catch them before commit ([commit.md](commit.md)), not in an audit six months later.

## Ignore rules

```bash
git status --ignored --short | head -30
git check-ignore -v <path>           # why is this ignored
```

Check that `.gitignore` covers: build output, dependency dirs, editor state (`.idea/`, `.vscode/` unless shared), OS files (`.DS_Store`, `Thumbs.db`), local env (`.env*`, `!.env.example`), coverage, caches, logs.

`.env.example` should be tracked and should contain **no real values**; placeholder strings only. It's the most common accidental-leak path because it looks safe.

## Stale branches

```bash
git fetch --prune
git branch -vv | rg ': gone]'                                     # remote deleted
git for-each-ref --sort=committerdate refs/remotes/<remote> --format='%(committerdate:short) %(refname:short)' | head -20
```

Report the list with ages. Never bulk-delete; each deletion is its own ask, and each needs the unlanded-commit check from [branch.md](branch.md#deleting).

## Line endings

```bash
cat .gitattributes 2>/dev/null
git ls-files --eol | rg -v 'i/lf' | head
```

A repo with no `.gitattributes` and mixed-OS contributors gets whole-file phantom diffs. The fix is `* text=auto eol=lf` in `.gitattributes` plus a one-time renormalization (`git add --renormalize .`); flag it, don't do it unasked; it touches every file.

## Signing

```bash
git config --get commit.gpgsign
git log --show-signature -3
```

If the repo signs, keep signing. If the branch protection requires signatures, an unsigned commit will be rejected at push time; check before, not after.

## Config sanity

Query relevant local keys with `--show-origin` rather than dumping unrelated configuration. Watch for a `user.email` that crosses personal and work identities, `push.default=matching`, unsafe hooks or filters, and credentials embedded in remote URLs. Redact any credential before reporting the URL.

## Health summary

Report as findings, severity-ordered. Do not fix anything during an audit; an audit that edits is a refactor with no review.
