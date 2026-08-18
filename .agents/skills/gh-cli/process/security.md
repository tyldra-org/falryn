# security

Inspect and manage GitHub security surfaces without exposing secrets or weakening controls.

## Scope

Cover:

- dependency graph and Dependabot alerts;
- code scanning alerts and SARIF workflows;
- secret scanning and push protection;
- repository security advisories and private forks;
- dependency review, branch/ruleset controls, and Actions supply chain;
- artifact attestations, signing, provenance, and SBOMs;
- organization and repository security settings.

Use [audit.md](../../git-workflow/reference/audit.md) for local secret/history/size hygiene and [actions.md](actions.md) for workflow security.

## Read before write

Prefer dedicated `gh` commands when available; otherwise use documented REST/GraphQL endpoints:

```bash
gh api repos/OWNER/REPO/dependabot/alerts --paginate
gh api repos/OWNER/REPO/code-scanning/alerts --paginate
gh api repos/OWNER/REPO/secret-scanning/alerts --paginate
gh api repos/OWNER/REPO/security-advisories --paginate
gh ruleset list --repo OWNER/REPO
```

Security endpoints require feature availability and specific permissions. Distinguish “no findings” from “feature disabled,” “not licensed,” “insufficient permission,” and “endpoint unavailable.”

## Triage

For every alert, retain:

- immutable alert number/ID and repository;
- detector/rule/package and affected location/range;
- vulnerable version or secret type;
- state, reason, resolution actor, and timestamps;
- fix availability and affected branches/releases;
- evidence supporting true positive, false positive, risk accepted, revoked, or fixed.

Do not dismiss from title or scanner confidence alone. Validate against code, dependency resolution, reachability, runtime configuration, or secret rotation evidence.

## Secret incidents

If a credential may be exposed:

1. Stop printing or copying it.
2. Revoke/rotate at the issuing system first.
3. Identify repository, commits, forks, logs, artifacts, caches, releases, packages, and downstream use.
4. Remove current exposure.
5. Decide whether history rewrite is necessary; follow rewrite safety and coordinate clones.
6. Close the alert only with rotation/revocation evidence.

Deleting the string from Git does not revoke the credential. Marking an alert resolved does not remove it.

## Advisory lifecycle

Repository security advisories and CVEs are coordinated disclosure surfaces. Drafting and private collaboration are safer than public publication. Confirm before publishing, requesting a CVE, creating a public fork/PR, or changing credits.

Keep severity, affected versions, patched versions, ecosystem identifiers, and remediation consistent with released artifacts. Do not announce a fix before users can obtain it.

## Supply-chain controls

- Review lockfile and resolved dependency changes.
- Verify package/source provenance and licenses.
- Pin Actions and privileged automation appropriately.
- Generate and retain SBOMs where required.
- Verify signatures and attestations against expected repository, workflow, ref, and issuer.
- Do not treat an attestation as a vulnerability scan.

## Mutation safeguards

Closing/dismissing alerts, disabling protection, adding bypass actors, making advisories public, and deleting evidence are consequential. Preview exact targets and reasons and confirm.

Never disable a scanner, branch rule, push protection, or required check merely to unblock delivery.

## Reporting

Report counts by state and severity, feature/permission gaps, validated findings, dismissals with reasons, remediation status, and remaining exposure. Do not include secret values or sensitive exploit detail outside the authorized audience.

