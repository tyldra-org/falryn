# Stage and commit

Commit one coherent unit using repository conventions and the active autocommit
policy. A completed feature with its tests is one unit; file count alone does
not justify splitting it. [Conventions](conventions.md) owns naming and messages.

## Prepare the index

Inspect status, the working diff and the existing staged diff. Separate intended
changes from unrelated edits before choosing paths. A dirty checkout is workable
when ownership and overlap are clear; the index may contain someone else's work.
Do not commit it accidentally. Use a separate checkout or resolve overlapping
ownership when the intended commit cannot be isolated safely.

```bash
git status --short --branch
git diff -- <paths>
git diff --cached
```

Follow the repository's branch policy. Inspect a detached HEAD or ongoing Git
operation before committing; do not switch away from recoverable work.

Stage explicit paths or reviewed hunks. A scoped directory is appropriate only
when all changes under it belong to the unit. Re-read the complete staged diff:

```bash
git add -- <paths>
git diff --cached --check
git diff --cached
```

Stage only intended content. Secrets, private files and incidental tool output
must not enter the commit. An empty index needs no ordinary commit.

## Validate and record

Use focused checks while working and the repository's required final checks.
Follow repository message, trailer and signing requirements. Prepare multiline
messages in a file; avoid an editor that cannot run in this environment.

```bash
git commit -m "<reviewed subject>"
git commit -F <reviewed-message-file>
```

These are alternatives, not two consecutive commits. Use the first only when the
complete required message is a subject. Do not disable signing or hooks.

If a hook fails, inspect its exit status and changes, repair an in-scope defect,
validate and retry. If it edits files, do not assume the commit succeeded. Inspect
`HEAD`, status and the index to learn what happened, then review those edits before
restaging. Never retry unchanged or bypass a hook to obtain a commit.

Verify the resulting SHA, complete message, committed paths and remaining work.
Report skipped checks. Preserve unrelated staged content throughout.

## Generated files and history

Keep tracked generated output and lockfiles with the source change that owns them.
Follow repository policy for untracked build output and large binaries; a filename
alone does not decide whether an artifact belongs in Git.

Amending is a rewrite. Follow [rewrite](rewrite.md), including authority, backup,
message preservation and content verification. A follow-up commit usually avoids
rewriting an already shared revision. A commit policy alone does not authorize
amend, publication or deletion.

For moving uncommitted work, use [branches](branch.md#switching-with-dirty-tree)
or [worktrees](worktree.md). Stashing has its own preservation rules in
[undo](undo.md#stash).
