# Governance audits

The repository auditors inspect GitHub state and generate diagnostics and a
deterministic delivery sequence. They do not mutate records or authorize work.
Run live audits from an identity-verified `tyldra-org/falryn` checkout after
proving access to Docs and Project 1 under [private authority](private-authority.md).
Use the authenticated `gh` account without putting credentials in arguments.

## Public issue-readiness audit

Use the verified Docs checkout as `<docs-root>` and a private temporary path as
`<snapshot>`:

```bash
bun run audit:issues -- \
  --live tyldra-org/falryn \
  --project-owner tyldra-org \
  --project-number 1 \
  --docs-root <docs-root> \
  --snapshot-out <snapshot>
```

Replay that captured generation without another network read:

```bash
bun run audit:issues -- --snapshot <snapshot> --docs-root <docs-root>
```

This loads open public issues for relationship resolution but audits only
Roadmap members. Ordinary contributions outside the Project do not need private
fields and cannot suppress routing. Use `--baseline <older-snapshot>` only for a
reviewed same-repository comparison. `--json` changes output shape, not authority.

## Cross-repository Roadmap audit

```bash
bun run audit:roadmap -- \
  --live tyldra-org/falryn \
  --live tyldra-org/falryn-docs \
  --project-owner tyldra-org \
  --project-number 1 \
  --snapshot-out <snapshot>
```

Replay with:

```bash
bun run audit:roadmap -- --snapshot <snapshot>
```

The live input is exactly those two repositories and that Project. It checks
membership, field metadata, release ordering, required enabled workflows,
native relationships, liveness, state consistency and dependency-safe order.
An open hierarchy or blocker dependency of a member must also be adopted.
Workflow filters and field effects need manual verification after Project
maintenance because the API does not expose them all. The contract lives in
[Roadmap fields](roadmap-fields.md).

Default liveness grace is seven days. Change `--liveness-grace-hours` only with
the governance contract, never to hide a diagnostic. Do not reproduce priority,
readiness, liveness or sequence with hand-written queries or guessed sorting.

## Snapshot handling

Create a restrictive private temporary directory outside both repositories.
Snapshots can contain private issue bodies, Project values and identities.
Never commit, upload, attach or paste them into public artifacts or logs.
Delete them after their bounded replay purpose ends.

Both auditors use schema version 3. Roadmap snapshots include Project privacy,
Target release options, selections and Release exception values. Issue-readiness
snapshots obtain targetRelease from Project membership. Older schemas are
rejected; neither auditor uses repository milestones. Do not convert old
snapshots silently or fall back to public scheduling metadata.

Replay proves only the captured generation. Regenerate after relevant issue,
relationship, assignee, release, PR, Project or repository changes. Reuse a clean
generation only while its inputs remain valid; current admission and merge
checks still require their live reads.

## Interpret and refresh

Zero exit status with no diagnostics is necessary for routing. Any diagnostic
suppresses the sequence. Within a mutating operation's authority, repair the
named owner and rerun affected audits. Next remains read-only and reports the
diagnostic. Command or access failures are failed or unavailable, never clean.
A sequence entry is navigation, not proof of admission or completed blockers.

After each governance mutation, read back the issue and Project item. Change
one Project field per command. Then use the required audit scopes:

| Changed facts | Audit |
| --- | --- |
| Public handoff or Ready evidence | Public issue-readiness |
| Status, Priority, Readiness, hierarchy, blockers, release, issue state or PR liveness | Cross-repository Roadmap |
| Both | Issue-readiness, then Roadmap |

Claim reconciliation only after the live records match the intended state and
all required scopes pass. Public work outside the Project does not trigger
private audits. A public-only actor can inspect its exact issue or PR and must
report private readiness or order as unavailable.
