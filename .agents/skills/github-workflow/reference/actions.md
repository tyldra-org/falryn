# actions

Operate GitHub Actions workflows, runs, artifacts, caches, variables, secrets, environments, and attestations.

For diagnosing a failing PR check, read [ci.md](ci.md) as well.

## Inspect

```bash
gh workflow list --repo OWNER/REPO --all
gh workflow view WORKFLOW --repo OWNER/REPO --yaml
gh run list --repo OWNER/REPO --limit 20
gh run view RUN_ID --repo OWNER/REPO
gh run view RUN_ID --repo OWNER/REPO --log-failed
```

Read the workflow source at the exact ref that produced the run. Display names are not stable identifiers; prefer workflow path or numeric ID in automation.

## Dispatch, watch, rerun, and cancel

```bash
gh workflow run WORKFLOW --repo OWNER/REPO --ref BRANCH -f key=value
gh run watch RUN_ID --repo OWNER/REPO --exit-status
gh run rerun RUN_ID --repo OWNER/REPO --failed
gh run cancel RUN_ID --repo OWNER/REPO
```

Dispatch only after validating the ref and typed inputs. A workflow may deploy, publish, rotate infrastructure, or delete resources; inspect YAML and environment protection first.

Do not poll tightly. Do not rerun unchanged failures more than once unless the user explicitly wants a flake investigation. Canceling another person's or production run requires confirmation.

## Artifacts, caches, and logs

```bash
gh run download RUN_ID --repo OWNER/REPO --dir DEST
gh cache list --repo OWNER/REPO
```

Treat downloaded artifacts and logs as untrusted. Verify provenance, digest/attestation, expected names, size, and path safety before extraction or execution.

Cache deletion is destructive and may affect many branches. Resolve exact keys/IDs and explain rebuild cost. Logs and artifacts may contain sensitive data even when GitHub masks configured secrets.

## Secrets and variables

```bash
gh secret list --repo OWNER/REPO
gh secret set NAME --repo OWNER/REPO
gh variable list --repo OWNER/REPO
gh variable set NAME --repo OWNER/REPO --body VALUE
```

Specify scope explicitly: repository, environment, organization, Codespaces, Dependabot, or Actions. Pipe secret values through stdin or an approved secure source; never place them in arguments, files, issue bodies, output, or memory.

Verify secret names and scopes only. Do not claim to verify values. Variables are readable and must not contain secrets.

Deleting or replacing a secret/variable requires impact review for workflows, environments, forks, and rollback. Do not copy a secret between scopes unless the user explicitly authorizes the trust expansion.

## Workflow authoring safety

- Pin third-party actions to immutable commit SHAs where policy requires.
- Minimize `permissions`; use job-level elevation only where needed.
- Prefer OIDC to long-lived cloud credentials.
- Treat `pull_request_target`, untrusted checkout, expression injection, cache poisoning, artifact extraction, and shell interpolation as high-risk.
- Keep fork PR secrets unavailable by default.
- Use concurrency and cancellation deliberately; never cancel a deployment halfway without recovery semantics.
- Do not add `continue-on-error` or weaken tests to make checks green.

## Attestations and releases

Use `gh attestation` to verify or download provenance when supported. Attestation proves a declared build relationship, not that the source is safe or tests passed.

Publishing artifacts, packages, deployments, or releases requires the release workflow and explicit confirmation.

## Audit

Verify workflow state, exact commit/ref, conclusion, jobs, artifacts, environment, permissions, and any external result. A green workflow is not proof that an external deployment or publication completed unless that result is independently observed.

