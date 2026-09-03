# release

Publish a **GitHub Release**. Git tags, changelogs, and version bumps are **git-workflow** [release.md](../../git-workflow/reference/release.md).

## GitHub release

```bash
gh release create v1.4.0 --title "v1.4.0" --notes-file CHANGELOG-v1.4.0.md --draft
gh release create v1.4.0 --generate-notes --draft
# Pre-release status does not replace draft review.
gh release create v1.4.0-rc.1 --prerelease --draft
gh release upload v1.4.0 <artifact>
```

`--generate-notes` produces a starting point, not a reviewed changelog. Keep
`--draft` set while editing. Publishing or undrafting a release is a separate
outward-facing operation: show the exact notes, tag, target, artifacts, and
prerelease state, then obtain approval before publication.

Resolve exact flags from `gh release --help` and the relevant installed subcommand help before publishing.
