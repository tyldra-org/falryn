# Organizations (`gh org`)

> Extracted from github/awesome-copilot `gh-cli` (commit 8395dce). Prefer `gh <cmd> --help` when flags may have changed.

### Organizations (gh org)

```bash
# List organizations
gh org list

# List for user
gh org list --user username

# JSON output
gh org list --json login,name,description

# View organization
gh org view orgname

# View organization members
gh org view orgname --json members --jq '.members[] | .login'
```

