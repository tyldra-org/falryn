# Audit evidence

Run from a trusted, identity-verified `tyldra-org/falryn` checkout. Prove access
to `tyldra-org/falryn-docs` and to the organization's Roadmap issue fields
independently. The Docs checkout must have the exact remote and current guidance,
branch and revision. The authenticated gh account supplies access; never pass
credentials in arguments.

## Capture the inputs

Create a private temporary directory outside both repositories with restrictive
permissions. Use separate files for the two snapshot formats.

For public handoff and Ready evidence, with the verified private Docs checkout:

```bash
bun run audit:issues -- \
  --live tyldra-org/falryn \
  --docs-root <docs-root> \
  --snapshot-out <issues-snapshot>
```

For cross-repository order and planning consistency:

```bash
bun run audit:roadmap -- \
  --live tyldra-org/falryn \
  --live tyldra-org/falryn-docs \
  --snapshot-out <roadmap-snapshot>
```

Next needs a clean Roadmap generation and current required handoff evidence.
Any required audit diagnostic suppresses selection. Command/access failures are
failed or unavailable, never a pass. Public issues without Roadmap fields are not
subject to planning rules and do not suppress maintainer routing.

Capture reads only issues and their native relationships, release milestones and
the organization-only Roadmap issue fields. An account that cannot read those
fields sees no Roadmap issues; treat an unexpectedly empty Roadmap as unavailable
access, never as an empty backlog.

## Reuse and refresh

Replay captures without another network load:

```bash
bun run audit:issues -- --snapshot <issues-snapshot> --docs-root <docs-root>
bun run audit:roadmap -- --snapshot <roadmap-snapshot> --json
```

Replay proves its captured inputs. Regenerate when relevant issues, native
relationships, owners, PRs, milestones, Roadmap fields or repository state
change. The selector performs the second replay itself and refuses diagnostics.
Current admission and merge still need live reads. Do not rerun unrelated
product discovery to continue a known PR.

| Mutated evidence | Required refresh after reading back the objects |
| --- | --- |
| Public handoff or Ready checklist | Issue-readiness audit |
| Priority, Readiness, release milestone, release exception, hierarchy, blockers, closure or PR state | Roadmap audit |
| Both | Issue-readiness, then Roadmap |

Both snapshot formats use schema version 4. Older schemas are intentionally
rejected. Do not convert them silently. Use `--baseline` only for a reviewed
same-repository issue-readiness comparison. JSON is an output format, not weaker
validation.

Status is derived, so there is no Status to refresh: a closed issue is Done, an
open leaf is In Progress while it has an open closing pull request, and an open
parent is In Progress once a native child has started.

## Protect captured data

Snapshots contain private issue fields and exception text. Never commit, attach,
upload or paste them into public artifacts or logs. Delete them after their
bounded use. Do not clone private repositories, broaden field visibility or
substitute guessed order when access fails. The selector's output is also private
working evidence; it omits bodies but may identify private planning values.

