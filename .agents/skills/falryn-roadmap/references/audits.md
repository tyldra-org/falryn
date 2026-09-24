# Audit evidence

Run from a trusted, identity-verified `tyldra-org/falryn` checkout. Prove access
to `tyldra-org/falryn-docs` and `tyldra-org` Project 1 independently. The Docs
checkout must have the exact remote and current guidance, branch and revision.
The authenticated gh account supplies access; never pass credentials in arguments.

## Capture the inputs

Create a private temporary directory outside both repositories with restrictive
permissions. Use separate files for the two snapshot formats.

For public handoff and Ready evidence, with the verified private Docs checkout:

```bash
bun run audit:issues -- \
  --live tyldra-org/falryn \
  --project-owner tyldra-org \
  --project-number 1 \
  --docs-root <docs-root> \
  --snapshot-out <issues-snapshot>
```

For cross-repository order and Project consistency:

```bash
bun run audit:roadmap -- \
  --live tyldra-org/falryn \
  --live tyldra-org/falryn-docs \
  --project-owner tyldra-org \
  --project-number 1 \
  --snapshot-out <roadmap-snapshot>
```

Next needs a clean Roadmap generation and current required handoff evidence.
Any required audit diagnostic suppresses selection. Command/access failures are
failed or unavailable, never a pass. Public issues outside the Project are not
subject to private fields and do not suppress maintainer routing.

Live capture merges the Project's paged item list with each open issue's own
non-archived Project items, because GitHub's item index can lag behind item
creation. The issue-side value wins for an item both sources report. A nonzero
stderr count reports items the list omitted. An item that neither source
reports remains a diagnostic.

## Reuse and refresh

Replay captures without another network load:

```bash
bun run audit:issues -- --snapshot <issues-snapshot> --docs-root <docs-root>
bun run audit:roadmap -- --snapshot <roadmap-snapshot> --json
```

Replay proves its captured inputs. Regenerate when relevant issues, native
relationships, owners, PRs, releases, Project fields/workflows or repository state
change. The selector performs the second replay itself and refuses diagnostics.
Current admission and merge still need live reads. Do not rerun unrelated
product discovery to continue a known PR.

| Mutated evidence | Required refresh after reading back the objects |
| --- | --- |
| Public handoff or Ready checklist | Issue-readiness audit |
| Status, Priority, Readiness, hierarchy, blockers, target release, closure or PR liveness | Roadmap audit |
| Both | Issue-readiness, then Roadmap |

Both snapshot formats use schema version 3. Older schemas are intentionally
rejected. Do not convert them silently. Scheduling comes from private Project
Target release selections, not repository milestones. Use `--baseline` only for
a reviewed same-repository issue-readiness comparison. JSON is an output format,
not weaker validation.

The default liveness grace is seven days. Do not increase it to conceal stale
work. The auditors can inspect enabled workflow names, but not every filter or
field effect; inspect those manually after Project maintenance.

## Protect captured data

Snapshots contain private records and scheduling values. Never commit, attach,
upload or paste them into public artifacts or logs. Delete them after their
bounded use. Do not clone private repositories, broaden Project visibility or
substitute guessed order when access fails. The selector's output is also private
working evidence; it omits bodies but may identify private issues and releases.
