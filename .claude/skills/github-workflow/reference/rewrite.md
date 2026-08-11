# rewrite

History surgery: amend, squash, reword, reorder, rebase, filter. Everything here rewrites SHAs. Back up first, verify by tree hash, and confirm before publishing.

## Commit messages during rewrites

Recreated commits are always subject-only. Strip existing bodies during
amend, reword, squash, reorder, and rebase operations; never preserve,
invent, or expand them. Do not use `--no-edit` when it would preserve a
body. If a repository or platform requires a non-empty body, stop and report
the incompatibility; do not add one.

## Gate

Before touching history, answer three questions out loud:

1. **Is it pushed?** `git log origin/<branch>..<branch> --oneline` — commits listed are unpushed and safe to rewrite. Anything not listed is published.
2. **Is anyone else on it?** A published branch with other people's work on it is not yours to rewrite. Use `git revert` or a follow-up commit instead.
3. **Is the intended outcome unambiguous?** "Clean this up" is not an instruction. `reset --soft`, `reset --hard`, `revert`, and `rebase --onto` all "get rid of a commit" and only one is right. Confirm the outcome, not the command.

If any answer is no or unclear, stop and ask.

## Always, first

```bash
git branch backup/<what>-$(date +%Y-%m-%d)
git rev-parse HEAD                          # record the SHA in your summary
```

## Amend the tip

Unpushed tip only.

```bash
git add <files>
git commit --amend -m "<existing subject>"          # keep subject, no body
git commit --amend -m "type(scope): summary"       # change subject
```

Every amend must reissue a subject-only message; do not use `--no-edit` when
it can preserve a body.

Amending changes the SHA. If the commit is pushed, landing the amend requires a force-push — confirm that separately.

## Squash, reword, reorder

```bash
git rebase -i origin/<default-branch>
```

Interactive rebase is not available in a non-interactive environment. Use the scripted equivalents instead:

```bash
# squash a whole branch into one — reset to the MERGE BASE, not to the base branch
git reset --soft "$(git merge-base <base-branch> HEAD)" && git commit -m "type(scope): summary"

# squash the last N into one
git reset --soft HEAD~N && git commit -m "type(scope): summary"

# drop a specific commit
git rebase --onto <sha>^ <sha> <branch>

# reword a specific commit (not the tip)
GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick <short-sha>/reword <short-sha>/'" git rebase -i <sha>^
```

`reset --soft` keeps everything staged — it is the safest squash. `reset --mixed` (default) unstages. `reset --hard` **discards the working tree** and is the single most destructive routine git command; it needs its own confirmation and a backup ref, always.

Prefer `fixup` commits during work and one squash at the end:

```bash
git commit --fixup <sha>
git rebase --autosquash origin/<default-branch>
```

## Moving commits between branches

```bash
git rebase --onto <new-base> <old-base> <branch>
git cherry-pick <sha>            # copy one commit elsewhere
git cherry-pick <a>..<b>         # a range, exclusive of a
```

`cherry-pick` copies; it does not move. The original stays. If the intent was "move", the original still needs removing — say so explicitly rather than leaving a duplicate.

## Verifying a rewrite

**Compare tree hashes. Never verify by reading commit subjects** — subjects survive rewrites that lose content.

```bash
git rev-parse 'backup/<what>^{tree}' 'HEAD^{tree}'      # equal = content identical
git diff backup/<what> HEAD                              # empty = content identical
```

For a multi-commit rewrite where the final tree *should* match:

```bash
git diff backup/<what> <branch> --stat
```

Non-empty means the rewrite changed content, not just structure. Read the diff before pushing. This check is what turns "I think it worked" into "it worked".

## Repo-wide history rewriting

Removing a file from all history (a leaked secret, a large binary):

```bash
git filter-repo --invert-paths --path <path>          # preferred
```

`git-filter-branch` is deprecated and slow — use `filter-repo`. Before any of this:

- Confirm with the user that every collaborator will re-clone. This breaks every existing clone, every open PR, and every SHA reference in tickets and CHANGELOGs.
- For a leaked secret, **rotate the credential first**. The rewrite does not un-leak it. See [audit.md](audit.md#secret-leak-response).
- Tag the pre-rewrite state, not just a branch: `git tag pre-rewrite-$(date +%Y-%m-%d)`.

## Publishing a rewrite

```bash
git push --force-with-lease=<branch>:<expected-old-sha> origin <branch>
```

Bare `--force` is never acceptable. Bare `--force-with-lease` (without `=<branch>:<sha>`) is also not acceptable — if anything ran `git fetch` in between, the lease checks against the updated remote-tracking ref and passes when it should fail.

After publishing, state in the summary:

- The old and new tip SHAs.
- That other clones need `git fetch && git reset --hard origin/<branch>` or a fresh clone.
- That the backup ref exists and where.
- **Whether the push published content that wasn't on the remote before.** Squashing a partly-pushed branch does two things at once: it rewrites the published commits *and* it uploads the local-only ones. The user asked for the first and may not have registered the second. Check before pushing and say so plainly:

  ```bash
  git log origin/<branch>..<branch> --oneline   # local-only commits about to become public
  ```

  This matters most when the unpushed commits were unpushed on purpose.

Delete the backup ref only after the user confirms the outcome.

## Never rewrite

- The default branch of a shared repo.
- Anything with a release tag on it.
- A branch with an open PR that has review comments — force-pushing orphans them.
- Someone else's commits without their agreement.

For published history that needs correcting, the tool is `git revert` — it's a new commit, it's reviewable, it breaks nothing.
