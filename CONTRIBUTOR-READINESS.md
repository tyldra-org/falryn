# Contributor readiness

Falryn is currently limited to collaborators while the foundation changes
quickly. The repository is nevertheless prepared for external contributions:
required issue forms, PR context and size checks, changed-file area labels,
CODEOWNERS, security reporting, Dependabot, multi-platform CI, and the
issue-governance policy are already present.

## Opening contributions

When the contracts are stable, lift the GitHub interaction restriction for the
repository or organization. `main` is already protected with the safeguards
below; do not relax them at the same time:

1. keep `main` pull-request-only, linear, and protected from force pushes and
   deletion;
2. require every CI job in `.github/workflows/ci.yml` and the **Validate
   contribution metadata** check from `.github/workflows/pr-metadata.yml`;
3. require conversation resolution; and
4. after a second maintainer can review independently, require one approving
   review and CODEOWNERS review for protected paths. A sole maintainer must not
   enable a rule it cannot satisfy.

The one operational change is the interaction restriction. When a second
maintainer can review independently, an organization administrator enables the
already documented one-approval and CODEOWNERS-review requirements in the same
branch-protection rule.

## Enforcement scope

Repository rulesets and contribution-policy checks apply to every contributor
except the repository owner's exact GitHub account. That includes organization
members, collaborators, maintainers, and future external contributors. The
owner is the only `always` bypass actor on main, release branches, and release
tags; granting repository admin access to someone else does not grant the same
exception.

The owner exception preserves emergency and solo-maintenance access. Size, area,
and trust labels may still be applied as informational metadata, but they do not
block the owner.

## Triage contract

Every valid report is triaged into the Falryn Roadmap with exactly one owner,
one Status, one work-type label, at least one area label, and either a native
parent or explicit Standalone relationship. The `Issue governance` workflow
reminds maintainers about repository-owned assignee and label metadata; it never
invents them. Because a repository-scoped `GITHUB_TOKEN` cannot read the private
organization Project, Roadmap membership, Status, and hierarchy are verified by
private Project automation and the repository-owned maintainer audit:

```bash
bun run audit:issues -- --live tyldra-org/falryn \
  --project-owner tyldra-org --project-number 1 \
  --docs-root ../falryn-docs \
  --snapshot-out /tmp/falryn-issue-readiness.json
```

Live mode uses the active `gh` authentication and requires access to the private
Roadmap. It emits exact issue-number diagnostics and never receives a token in
argv. Keep snapshots local: they contain issue bodies and Project metadata.
Re-run deterministically without network access using `--snapshot <path>`;
add `--baseline <previous-path>` to detect a title or milestone change whose
body was not reconciled. `--docs-root` verifies canonical documentation paths
against a checked-out Falryn Docs tree. The audit checks metadata, hierarchy,
body bounds and markers, blockers, cycles, canonical paths, and docs-only
completion wording; it never mutates GitHub.

Pull requests link an issue, explain scope, validation, documentation impact,
and risk. Automation applies changed-file area labels, exactly one `size: *`
label, and a transparent `vouch: *` trust classification. A large PR is not
automatically rejected, but `size: XL` is a deliberate signal to split it when
the outcome can remain independently reviewable. The vouch list records only
maintainer decisions about trusted external authors; it does not grant merge
permission or bypass checks.
