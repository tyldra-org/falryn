# rewrite

History surgery: amend, squash, reword, reorder, rebase, filter. Everything here rewrites SHAs. Confirm the exact outcome before touching history, then create a backup and verify by tree hash. Publishing a rewritten ref requires a second confirmation bound to the exact remote lease.

## Commit messages during rewrites

A rewrite changes commit identity, not message policy. Preserve required
bodies, sign-offs, co-author lines, breaking-change metadata, and issue
trailers unless the confirmed rewrite explicitly changes them. Prepare and
review every replacement message in full. Use `--no-edit` when the exact
existing message must survive an amend; use a validated message file when the
complete message changes.

## Gate

Before touching history, answer three questions out loud:

1. **Is it pushed?** `git log <remote>/<branch>..<branch> --oneline` lists commits absent from the resolved remote-tracking branch. Both published and unpublished rewrites require confirmation; the published case also requires ownership and force-push review.
2. **Is anyone else on it?** A published branch with other people's work on it is not yours to rewrite. Use `git revert` or a follow-up commit instead.
3. **Is the intended outcome unambiguous?** "Clean this up" is not an instruction. `reset --soft`, `reset --hard`, `revert`, and `rebase --onto` all "get rid of a commit" and only one is right. Confirm the outcome, not the command.

If any answer is no or unclear, stop and ask.

## Always, first

```bash
git branch backup/<what>-<timestamp>
git rev-parse HEAD                          # record the SHA in your summary
```

## Amend the tip

Prefer an unpushed tip, after explicit amend confirmation. Amending a published owned feature-branch tip also requires coordination and a separately authorized leased force-push.

```bash
git add <files>
git commit --amend --no-edit                       # preserve the exact message
git commit --amend -F <reviewed-message-file>      # replace the full message
```

Inspect `git log -1 --format=%B` afterward. A changed subject does not authorize
stripping an existing body or trailers.

Amending changes the SHA. If the commit is pushed, landing the amend requires a force-push; confirm that separately.

## Squash, reword, reorder

```bash
git rebase -i <remote>/<default-branch>
```

Interactive rebase is not available in a non-interactive environment. Use the scripted equivalents instead:

```bash
# Squash a whole branch into one. Reset to the merge base, not the base branch.
git reset --soft "$(git merge-base <base-branch> HEAD)" && \
  git commit -F <reviewed-message-file>

# squash the last N into one
git reset --soft HEAD~N && git commit -F <reviewed-message-file>

# drop a specific commit
git rebase --onto <sha>^ <sha> <branch>
```

`reset --soft` keeps everything staged. `reset --mixed` (default) unstages.
`reset --hard` **discards the working tree** and needs its own confirmation and
a backup ref, always.

Rewording a non-tip commit needs both a sequence editor and a commit-message
editor. In a non-interactive host, proceed only with reviewed portable helper
scripts for both; do not embed platform-specific `sed -i` syntax or leave Git
waiting for an editor.

Prefer `fixup` commits during work and one confirmed autosquash at the end:

```bash
git commit --fixup <sha>
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <remote>/<default-branch>
```

## Moving commits between branches

```bash
git rebase --onto <new-base> <old-base> <branch>
git cherry-pick <sha>            # copy one commit elsewhere
git cherry-pick <a>..<b>         # a range, exclusive of a
```

`cherry-pick` copies; it does not move. The original stays. If the intent was "move", the original still needs removing; say so explicitly rather than leaving a duplicate.

## Verifying a rewrite

Never verify by reading commit subjects. Subjects can survive a rewrite that loses content.

When the base is unchanged and the intended final tree should be identical, compare trees:

```bash
git rev-parse 'backup/<what>^{tree}' 'HEAD^{tree}'      # equal = content identical
git diff backup/<what> HEAD                              # empty = content identical
```

For a multi-commit rewrite on the same base where the final tree should match:

```bash
git diff backup/<what> <branch> --stat
```

Non-empty means the rewrite changed content, not just structure. Read the diff before pushing. This check is what turns "I think it worked" into "it worked".

When a rebase changes the base, tree equality is the wrong test because the new tree includes upstream changes. Compare patch series and then run validation:

```bash
git range-diff <old-base>..backup/<what>-<timestamp> \
  <new-base>..<rewritten-branch>
```

Inspect altered, missing, and newly empty commits. `range-diff` is evidence about patch correspondence, not proof of runtime equivalence.

## Repo-wide history rewriting

Removing a file from all history (a leaked secret, a large binary):

```bash
git filter-repo --invert-paths --path <path>          # preferred
```

`git-filter-branch` is deprecated and slow; use `filter-repo`. Before any of this:

`git filter-repo` is a separately installed tool, not a core Git subcommand. Verify its installed version and current official usage. If it is unavailable, stop and report the dependency instead of falling back to `filter-branch`.

- Confirm a coordinated migration plan for collaborators and automation that hold old object IDs. A repository-wide rewrite invalidates affected clones, branches, PR comparisons, and SHA references until each consumer is repaired or replaced.
- For a leaked secret, **rotate the credential first**. The rewrite does not un-leak it. See [audit.md](audit.md#secret-leak-response).
- Preserve the pre-rewrite state with an explicitly named backup ref whose exact SHA you record. Use a tag instead of a branch only when repository policy requires a durable shared marker.

## Publishing a rewrite

Read the remote ref directly immediately before the confirmation and push. Record that SHA as `<expected-old-sha>` and stop if it differs from the reviewed value:

```bash
git ls-remote --refs <remote> refs/heads/<branch>
```

```bash
git push --force-with-lease=<branch>:<expected-old-sha> <remote> <branch>
```

Bare `--force` is never acceptable. Bare `--force-with-lease` (without `=<branch>:<sha>`) is also not acceptable; if anything ran `git fetch` in between, the lease checks against the updated remote-tracking ref and passes when it should fail.

After publishing, state in the summary:

- The old and new tip SHAs.
- That other clones need a coordinated recovery against `<remote>/<branch>` or a fresh clone. Do not prescribe a hard reset without protecting their local work.
- That the backup ref exists and where.
- **Whether the push published content that wasn't on the remote before.** Squashing a partly-pushed branch does two things at once: it rewrites the published commits *and* it uploads the local-only ones. The user asked for the first and may not have registered the second. Check before pushing and say so plainly:

  ```bash
  git log <remote>/<branch>..<branch> --oneline # local-only commits about to become public
  ```

  This matters most when the unpushed commits were unpushed on purpose.

Delete the backup ref only after the user confirms the outcome.

## Never rewrite

- A shared default, integration, or release branch, except an explicitly coordinated incident-response rewrite.
- Anything with a release tag on it, except an explicitly coordinated incident-response rewrite.
- A reviewed pull-request revision without re-review; force-pushing can stale line anchors and invalidates evidence.
- Someone else's commits without their agreement.

For published history that needs correcting, prefer `git revert`. It creates a reviewable commit and preserves ancestry, though the behavioral impact still needs validation.
