# Governance audits

Falryn's repository-owned auditors turn live GitHub state into readiness diagnostics and a deterministic delivery sequence. They inspect evidence. They do not mutate issues or Project fields.

## Access gate

Run live maintainer audits only from an identity-verified `tyldra-org/falryn` checkout after independently proving access to `tyldra-org/falryn-docs` and `tyldra-org` Project 1 through [private authority](private-authority.md). Use the authenticated account selected by `gh`; never pass a token in arguments or write one into a snapshot.

Public-only agents may inspect one named public issue or pull request. They must report private readiness, Project, liveness, and sequence evidence as unavailable. They do not replace the audit with labels, milestone order, recency, issue numbers, or hand-built GraphQL queries.

## Public issue-readiness audit

Use the exact verified Falryn Docs checkout as `<docs-root>` and a private local path as `<snapshot>`:

```bash
bun run audit:issues -- \
  --live tyldra-org/falryn \
  --project-owner tyldra-org \
  --project-number 1 \
  --docs-root <docs-root> \
  --snapshot-out <snapshot>
```

Replay the same captured generation without another network read:

```bash
bun run audit:issues -- \
  --snapshot <snapshot> \
  --docs-root <docs-root>
```

The live form checks every open public issue, native relationships, Project Status membership, public Ready evidence, and canonical-document links. `--baseline <older-snapshot>` is valid only for a deliberately reviewed same-repository comparison. `--json` changes output shape, not authority.

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

The live form requires exactly those two repositories and that Project. It checks membership; exact field option names, descriptions, colors, and order; required enabled Project workflows; native hierarchy and blockers; milestone ordering; closing-pull-request liveness; state consistency; and dependency-safe routing. The API does not expose every Project workflow filter or field effect, so a maintainer also verifies those settings against [Roadmap fields and automation](roadmap-fields.md) after Project maintenance. The default liveness grace is seven days. Change `--liveness-grace-hours` only when the governance contract itself changes, not to suppress a diagnostic.

## Snapshot handling

Snapshots can contain public issue bodies, private repository records, Project metadata, identities, and timestamps. Store them outside both repositories in a newly created private temporary directory with restrictive permissions. Never commit, attach, paste, upload, or summarize their private fields into a public issue, pull request, CI log, or artifact. Delete or securely retire them after their bounded replay purpose ends.

A replay proves only that the deterministic analyzer returns the same result for that captured generation and schema version. It does not prove the live state is still current. Regenerate after any relevant issue, hierarchy, blocker, milestone, assignee, pull request, Project field, Project workflow, or repository state change. Schema version 2 snapshots include option descriptions, colors, and Project workflow enabled state; older snapshots are intentionally rejected.

## Interpret results

- Exit zero with no diagnostics is necessary for maintainer routing. It is not permission to mutate or merge.
- Any diagnostic suppresses the delivery sequence. Repair the named owner, rerun the affected audit, then rerun the Roadmap audit when ordering inputs changed.
- A command or access failure is `unavailable` or `failed` according to its cause. Never report it as a clean audit.
- A sequence entry is navigation. The selected mode still applies its own authority, ownership, readiness, revision, and authorization checks.

## After governance mutations

Re-read the exact issue and Project item after each mutation. Use native GitHub relationships for parents and blockers and update one Project field per command. Then run the public issue-readiness audit when public contracts or Ready evidence changed, followed by the Roadmap audit when Status, Priority, Readiness, hierarchy, blockers, milestone, issue state, or delivery liveness changed.

Do not claim reconciliation until the live object reads match the intended state and both required audit scopes complete without diagnostics.
