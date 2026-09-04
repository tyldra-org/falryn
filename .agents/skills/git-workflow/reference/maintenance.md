# Maintenance and repository health

Diagnose before optimizing. Maintenance rewrites internal storage and may expire recovery data. Do not run pruning or aggressive cleanup while work, refs, stashes, or corruption are unaccounted for.

## Read-only health checks

```bash
git status --short --branch
git count-objects -vH
git fsck --full
git reflog expire --dry-run --all
git worktree prune --dry-run --verbose
```

Interpret failures in context. Missing promisor objects in a partial clone, alternates, replace refs, grafts, shallow boundaries, submodules, and Git LFS can change what completeness means. Record the Git version and repository layout.

Do not treat `fsck` warnings as permission to delete objects. Preserve its full output and identify whether another clone or remote has a known-good copy.

## Routine maintenance

Inspect configured schedules and tasks first:

```bash
git config --show-origin --get-regexp '^maintenance\.'
git maintenance run
```

`git maintenance start` registers scheduled background work using platform facilities. That is persistent external state, so use it only when requested. Verify the schedule and know how `git maintenance stop` will unregister it.

Prefer the default task selection unless measurement and official help justify a specific task. Manual `gc`, repack, commit-graph, or multi-pack-index commands can overlap with maintenance and other Git processes.

## Garbage collection and pruning

Normal garbage collection is conservative, but expiry settings are configurable. `git gc --prune=now`, `git prune`, reflog expiry, and immediate worktree pruning can make recovery impossible. They require an exact inventory, backup or alternate recovery source, and confirmation.

Never remove `.git/objects`, packfiles, lockfiles, worktree administration directories, or refs by hand as a cleanup technique. First check for a live Git process and use the documented command for the diagnosed condition.

## Corruption and missing objects

Stop writes. Capture:

```bash
git fsck --full
git remote -v
git config --show-origin --get-regexp '^(extensions\.|remote\..*\.(promisor|partialclonefilter))'
git rev-parse --git-path objects/info/alternates
```

Read the alternates file only if it exists. Preserve the damaged repository before attempting repair when storage permits. Fetching a known object from a trusted remote or restoring from a verified clone is safer than deleting indexes or packs. Do not assume the remote is complete or authoritative; verify the required refs and objects.

For partial clones, allow Git's promisor mechanism to retrieve promised objects. For alternates, verify the alternate store still exists. Audit submodule and LFS data separately.

## Bundles and offline transfer

A Git bundle carries selected refs and reachable Git objects. It does not contain the working tree, untracked files, Git LFS payloads, or separate submodule repositories.

Create from explicit refs and verify the result:

```bash
git bundle create <bundle-file> <ref>...
git bundle verify <bundle-file>
git bundle list-heads <bundle-file>
```

Treat bundles as source repositories that may contain private history. Review included refs, protect the file, and test restoration in an isolated destination. An incremental bundle has prerequisite objects and is not a standalone backup.

## Archive and backup boundaries

`git archive` creates a source snapshot, not a repository backup. It omits history, normal untracked files, and separate dependency stores. Attribute export rules may alter or omit content. For disaster recovery, define and test the full set: Git refs and objects, working and untracked files, submodules, LFS objects, hooks/config when needed, release artifacts, and external secrets stored elsewhere.

## Report

State what was inspected, object and pack counts, integrity findings, maintenance performed, recovery data that may have expired, storage change, and how restoration was tested. A smaller `.git` directory alone is not proof of a healthy repository.
