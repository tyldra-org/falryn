# commit

Stage one logical unit, verify it, commit it. Subject rules in [conventions.md](conventions.md).

Follow the active repository and user policy for automatic commits. Without an
authoritative opt-in, stop at the clean boundary and suggest the commit.

## Boundaries

Commit at clean logical boundaries:

- a finished task or unit of work
- a working feature, fix, refactor, doc, test, or chore
- a self-contained set of related changes
- before switching to unrelated work
- before a handoff or pause after meaningful completed work

**One commit, one reason to exist.** The test: can you write a specific subject without "and"? If not, split.

**Don't split for its own sake.** A rename touching 40 files is one commit. A feature and its tests are one commit unless the repo says otherwise. Granularity tracks *reasons to change*, not file count.

Checkpoint commits on an unlanded branch are fine — `chore(<scope>): checkpoint <what>`, not `wip`. Flag them so they get squashed before landing ([rewrite.md](rewrite.md)).

## Commit message

Follow the effective subject, body, trailer, and signing policy in
[conventions.md](conventions.md). For a reviewed subject-only message:

```bash
git commit -m "type(scope): summary"
```

When a body or trailers are required, materialize and inspect the complete
message before using `git commit -F <reviewed-message-file>`.

## Procedure

### 1. Confirm where you are

```bash
git status --short --branch
```

- **On the default branch?** In GitHub flow or git flow, branch first ([branch.md](branch.md)). In trunk-based, this is correct. Know which model the repo uses.
- **Detached HEAD you didn't create?** Stop and report.
- **Mid-rebase / mid-merge?** Finish or abort that first, with the user.

### 2. Read the change

```bash
git diff -- <files>
git diff --cached -- <files>   # when anything is already staged
```

The actual diff, not `--stat`. You're about to attest these changes are one unit; you can't attest to what you haven't read.

Scan for: secrets, debug prints, commented-out code, absolute local paths, large binaries, unrelated formatting churn.

### 3. Stage

Prefer explicit paths — they're the only form that can't surprise you:

```bash
git add path/to/file path/to/other-file
```

Scoped pathspecs are fine when the scope *is* the unit:

```bash
git add -A -- packages/auth/
git add -p                          # interactive, when one file holds two changes
```

Bare `git add .` / `git add -A` at repo root is acceptable **only** after reading `git status --short` and confirming every listed path belongs. In practice that's rare — on a tree with several things in flight it's how unrelated work gets swept into a commit that claims to be about one thing.

Leave unrelated changes unstaged. Never fold them in "since they were there".

### 4. Verify the staged set

```bash
git diff --cached --stat
```

Every staged path belongs to the unit. If one doesn't: `git restore --staged <path>`.

**Nothing staged?** Stop — don't create an empty commit. Report there was nothing to commit.

### 5. Validate

Run focused validation for the changed files when practical — the adjacent test, the linter on the touched package, the type checker. Not the whole suite unless the change is broad.

If validation is skipped, say so explicitly in the summary. Silence reads as "it passed".

### 6. Write the subject

Inspect the diff and recent history first:

```bash
git diff --cached --stat
git diff --cached --name-only
git log --pretty=%s -n 20
```

Follow [conventions.md](conventions.md). The repo's established type and scope style wins over the defaults there.

### 7. Commit

Use `git commit -m "type(scope): summary"` only when the effective policy is
subject-only. Otherwise use the previously reviewed complete message. In a
non-interactive host, do not invoke an editor that can block unexpectedly.

If the repo signs (`commit.gpgsign`, a signing key, or signed commits in `git log --show-signature -1`), keep signing. Never `--no-gpg-sign`.

### 8. Hook outcomes

- **Hook fails** → stop, quote the shortest decisive line. Never `--no-verify`. Never retry unchanged.
- **Hook modifies files** (formatter, import sorter) → the commit succeeded but the tree moved. Re-check `git status`, then either amend (unpushed tip only) or make a follow-up `style` commit.

## Generated artifacts and lockfiles

**Lockfiles are source.** Commit them with the dependency change that produced them, always. A dependency change without its lockfile is a broken commit.

**Generated output** — build artifacts, exported media, tool output directories — usually belongs in `.gitignore`, not in a commit. When it *is* tracked (committed docs, checked-in fixtures, generated API clients), keep it in the same commit as the source that produced it, so the two never drift.

Binaries and large generated assets are worth confirming before they go in — they're permanent, every clone pays for them forever, and `.gitignore` is usually the right answer instead.

## Amending

Amend only when it is the unpushed tip and the user explicitly confirms the rewrite. Otherwise make a new commit. See [rewrite.md](rewrite.md).

```bash
git commit --amend --no-edit                       # preserve the exact message
git commit --amend -F <reviewed-message-file>      # replace the full message
```

Do not use `-m` to reissue only the subject when the existing or required
message contains bodies or trailers. Verify the resulting full message.

## Moving uncommitted work

```bash
git stash push -m "<what>"
```

Never bare `git stash` — an unlabeled entry you can't identify later. Pop it back the same session. If work needs to survive, it needs a branch or a worktree, not a stash.
