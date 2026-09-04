# release

Publish a **GitHub Release**. Git tags, changelogs, and version bumps are **git-workflow** [release.md](../../git-workflow/reference/release.md).

## GitHub release

```bash
gh release create v1.4.0 --repo OWNER/REPO --title "v1.4.0" --notes-file CHANGELOG-v1.4.0.md --draft
gh release create v1.4.0 --repo OWNER/REPO --generate-notes --draft
# Pre-release status does not replace draft review.
gh release create v1.4.0-rc.1 --repo OWNER/REPO --prerelease --draft
gh release upload v1.4.0 <artifact> --repo OWNER/REPO
```

By default, `gh release create` may create a missing Git tag from the default branch. For a release tied to a reviewed and pushed tag, require it to exist:

```bash
gh release create v1.4.0 --repo OWNER/REPO --verify-tag --draft --notes-file <reviewed-notes>
```

Resolve the tag SHA, target, previous release, and whether there are new commits. Use `--fail-on-no-commits` when duplicate no-change releases are invalid, while accounting for its first-release behavior.

`--generate-notes` produces a starting point, not a reviewed changelog. Keep
`--draft` set while editing. Publishing or undrafting a release is a separate
outward-facing operation: show the exact notes, tag, target, artifacts, and
prerelease state, then obtain approval before publication.

Asset upload is a separate API call and can partially succeed. Record names, sizes, media types, and local digests, then re-read the release. `gh release upload --clobber` deletes an existing asset before uploading its replacement; if upload fails, the original is lost. Treat clobber as destructive and confirm it against exact asset names.

When release immutability is enabled, published release tags and assets cannot be changed or deleted, while drafts remain mutable. Verify repository policy before publication. Use `gh release verify-asset` when supported to validate GitHub's signed release-asset attestation, and still compare the expected release, filename, and digest.

Resolve exact flags from `gh release --help` and the relevant installed subcommand help before publishing. After publication, verify state, URL, tag SHA, target, latest/prerelease flags, notes, discussion, and every asset.
