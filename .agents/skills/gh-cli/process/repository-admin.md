# admin

Administer repositories, access, rules, webhooks, keys, and environments with least privilege and explicit confirmation.

## Inspect before changing

```bash
gh repo view OWNER/REPO \
  --json nameWithOwner,visibility,isArchived,defaultBranchRef,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed
gh api repos/OWNER/REPO
gh ruleset list --repo OWNER/REPO
gh api repos/OWNER/REPO/collaborators --paginate
gh api repos/OWNER/REPO/hooks --paginate
gh api repos/OWNER/REPO/environments
```

Read repository `AGENTS.md`, `CONTRIBUTING.md`, `CODEOWNERS`, security policy, and organization policy. Organization rules may override repository settings.

## Repository lifecycle

```bash
gh repo create
gh repo clone OWNER/REPO
gh repo fork OWNER/REPO
gh repo rename NEW-NAME --repo OWNER/REPO
gh repo archive OWNER/REPO
gh repo unarchive OWNER/REPO
gh repo delete OWNER/REPO
```

Creation is safe when scope and visibility are explicit. Rename, transfer, archive, visibility change, default-branch change, and deletion require confirmation plus impact review for remotes, Pages, packages, Actions, webhooks, apps, forks, badges, and external links.

Never delete and recreate a repository to change metadata.

## Merge policy and rulesets

Inspect actual branch topology before changing merge methods. Use:

```bash
gh ruleset check BRANCH --repo OWNER/REPO
gh ruleset view RULESET_ID --repo OWNER/REPO
```

Rulesets and branch protection should define required reviews, status checks, signed commits, linear history, deployments, and bypass actors deliberately. Do not weaken protection to land one PR. Fix the PR or request a scoped exception.

`gh ruleset list`, `check`, and `view` inspect rulesets; create, update, or delete operations may require the web UI or authenticated API. Before reporting "no rules," distinguish an empty result from unsupported plan or host capability, insufficient permission, organization-owned policy, and an API or CLI error. Re-read the effective branch rules after every write.

Changing bypass lists or required checks is permission-changing and consequential. Preview the exact diff and confirm.

## Collaborators, teams, and apps

Resolve the actor, role, repository, and expiry. Grant the least role needed. Organization teams are preferred over repeated individual grants.

Before removal or downgrade, inspect open PRs, CODEOWNERS, automation, deploy ownership, and emergency access. Report invitations separately from accepted access.

Never infer permission from membership alone; query the effective repository permission when possible.

## Webhooks, deploy keys, and apps

- Verify target URL host, event list, content type, active state, and secret handling.
- Never print webhook secrets or private deploy keys.
- Prefer GitHub Apps or OIDC over long-lived personal tokens.
- Deploy keys are repository-specific; write-enabled keys are high risk.
- Test deliveries without replaying consequential external effects.
- Remove stale integrations only after ownership and replacement are confirmed.

Use `gh repo deploy-key list/add/delete` where available. Verify fingerprints and repository scope; never upload or print a private key.

## Environments, Pages, and deployments

Environments can own reviewers, wait timers, branch policies, secrets, and variables. Inspect all before changing one. Do not bypass environment protection to repair a workflow.

Publishing Pages or production deployments is outward-facing. Confirm the source branch/artifact, custom domain, visibility, and rollback path.

## Templates and community files

Maintain issue forms, PR templates, `CODEOWNERS`, `SECURITY.md`, support/funding metadata, and organization defaults in their canonical locations. Validate YAML and resulting UI behavior. A template is guidance, not proof that every issue or PR follows it.

Topics, homepage, description, social preview, licenses, language detection, and repository features are metadata, not evidence that the project delivers the advertised capability. Keep metadata accurate and verify resulting visibility.

## Verify and report

Re-read repository settings, rulesets, collaborators, hooks, environments, and effective default branch after changes. Name UI-only or organization-owned settings you could not verify.
