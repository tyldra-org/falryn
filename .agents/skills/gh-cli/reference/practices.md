# Practices & help

> Prefer `gh <cmd> --help` when flags may have changed. Git porcelain: **git-workflow**.

### Best Practices

1. **Authentication**: For automation, use `gh auth` — never print `gh auth token` or `GH_TOKEN` in chat.

   ```bash
   # Local scripts only; do not echo token
   : "${GH_TOKEN:?set in env}"
   ```

2. **Default Repository**: Set default to avoid repetition

   ```bash
   gh repo set-default owner/repo
   ```

3. **JSON Parsing**: Use jq for complex data extraction

   ```bash
   gh pr list --json number,title --jq '.[] | select(.title | contains("fix"))'
   ```

4. **Pagination**: Use --paginate for large result sets

   ```bash
   gh issue list --state all --paginate
   ```

5. **Caching**: Use cache control for frequently accessed data
   ```bash
   gh api /user --cache force
   ```

### Getting Help

```bash
# General help
gh --help

# Command help
gh pr --help
gh issue create --help

# Help topics
gh help formatting
gh help environment
gh help exit-codes
gh help accessibility
```

### Skill split reminder

| Need | Skill |
| --- | --- |
| `gh pr merge --squash` flags | **gh-cli** [reference/pr.md](pr.md) |
| Merge a GitHub PR (should we / confirm) | **gh-cli** [process/merge.md](../process/merge.md) |
| Local git merge / rebase / force-push | **git-workflow** |

### References

- Official Manual: https://cli.github.com/manual/
- GitHub Docs: https://docs.github.com/en/github-cli
- REST API: https://docs.github.com/en/rest
- GraphQL API: https://docs.github.com/en/graphql
