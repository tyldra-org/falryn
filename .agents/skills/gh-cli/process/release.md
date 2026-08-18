# release

Publish a **GitHub Release**. Git tags, changelogs, and version bumps are **git-workflow** [release.md](../../git-workflow/reference/release.md).

## GitHub release

```bash
gh release create v1.4.0 --title "v1.4.0" --notes-file CHANGELOG-v1.4.0.md
gh release create v1.4.0 --generate-notes       # draft to edit, not to publish as-is
gh release create v1.4.0 --prerelease           # rc / beta
gh release upload v1.4.0 <artifact>
```

`--generate-notes` produces a PR list. Useful as a starting draft; not a changelog. Edit before publishing.

Publishing a release is outward-facing — show the notes to the user and get approval before it goes out.

Flag syntax: [reference/release.md](../reference/release.md).
