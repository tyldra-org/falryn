# surfaces

Route less-common GitHub surfaces without treating them as generic repository writes.

## Search and status

```bash
gh search issues QUERY --owner OWNER --limit 100
gh search prs QUERY --repo OWNER/REPO --limit 100
gh search code QUERY --repo OWNER/REPO --limit 100
gh status
```

Use qualifiers and explicit owners/repositories. Search is an index and may lag; verify the selected object directly before mutation.

## Discussions

```bash
gh discussion list --repo OWNER/REPO
gh discussion view NUMBER --repo OWNER/REPO
gh discussion create --repo OWNER/REPO --category CATEGORY --title TITLE
```

Use Discussions for open-ended questions, proposals, announcements, and community conversation. Convert committed work into Issues. Publishing announcements, locking, deleting, or changing categories is outward-facing and requires confirmation.

## Codespaces

```bash
gh codespace list
gh codespace create --repo OWNER/REPO --branch BRANCH
gh codespace ssh --codespace NAME
gh codespace logs --codespace NAME
gh codespace stop --codespace NAME
gh codespace delete --codespace NAME
```

Verify repository, branch, region, machine size, retention, secrets, dotfiles, and cost. Deletion destroys unpushed work; inspect Git status inside the Codespace and confirm first.

Codespaces secrets are a distinct scope. Never assume Actions secrets are available or appropriate.

## Packages and registries

Package support varies by registry and may require API endpoints or native package tools. Resolve owner, package type, package name, version, visibility, linked repository, downloads, and dependent users.

Publishing, changing visibility, deprecating, restoring, or deleting package versions is outward-facing or destructive. Confirm and verify registry state independently. Never delete a package version merely because a GitHub Release was removed.

## Gists

```bash
gh gist list
gh gist view ID
gh gist create FILE --public
gh gist edit ID
gh gist delete ID
```

Secret gists are unlisted, not private access-controlled storage. Never place secrets, private source, customer data, or internal logs in a gist. Public creation and deletion require confirmation.

## Organizations

```bash
gh org list
gh api orgs/ORG
gh api orgs/ORG/teams --paginate
```

Organization membership, teams, roles, SSO, apps, rulesets, secrets, variables, billing, and security policy have broader blast radius than repository settings. Use least privilege, distinguish invitations from active membership, and confirm access changes.

## Notifications

GitHub CLI coverage may be limited. Prefer documented APIs or the UI. Marking as read, unsubscribing, or changing notification settings affects user state; resolve exact thread/repository scope.

## SSH/GPG keys and signing

```bash
gh ssh-key list
gh gpg-key list
```

Adding or deleting account keys changes authentication/signing trust. Verify fingerprints locally, never upload private keys, and confirm removals. For signing policy and local Git configuration, also read [audit.md](../../git-workflow/reference/audit.md).

## Extensions and aliases

```bash
gh extension list
gh extension browse
gh alias list
```

Extensions execute local code with the user's GitHub authority. Inspect source, publisher, permissions, install method, and updates before installation. Do not install or remove extensions without explicit user direction.

Aliases must not hide destructive flags, tokens, repository inference, or confirmation-sensitive operations.

## CLI utilities and agent surfaces

- `gh browse` opens a resolved repository object; verify the target before relying on browser state.
- `gh config`, `gh completion`, and `gh alias` change local CLI behavior, not repository state.
- `gh licenses` is reference data; verify the repository's actual license file and compatibility separately.
- `gh preview` exposes experimental features whose schema and stability may change.
- `gh skill`, `gh agent-task`, and `gh copilot` may expose account- or product-dependent agent features. Inspect `--help`, availability, permissions, data destination, and generated effects before use.

Do not treat AI-generated plans, patches, summaries, or agent-task status as repository truth until the resulting commits, PRs, checks, and effects are independently inspected.

## Browser-only and unsupported surfaces

If `gh` and official APIs do not expose a setting, state that the remaining action is UI-only. Do not claim completion from nearby API state. Browser automation must preserve exact targets and stop before consequential confirmation unless already authorized.
