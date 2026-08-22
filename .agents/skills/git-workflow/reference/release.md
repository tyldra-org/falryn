# release

Semver, annotated tags, changelog. Pushing a tag is outward-facing and effectively permanent — confirm it. GitHub Releases are **gh-cli** `process/release.md`.

## Version from repository policy and changes

Use this mapping only when the repository explicitly adopts both Semantic Versioning and Conventional Commits for release calculation:

| Commits since last tag | Bump |
|---|---|
| Any `!` suffix | **major** |
| Any `feat:` | **minor** |
| Only `fix:` / `perf:` | **patch** |
| Only `docs` / `test` / `chore` / `ci` / `style` / `refactor` | **no release** |

Semantic Versioning does not prescribe a universal pre-1.0 inversion. A repository may map breaking changes to minor and features to patch while `0.x`, but that must come from its documented release policy or tooling. Do not invent it.

```bash
git describe --tags --abbrev=0                                  # last tag
git log $(git describe --tags --abbrev=0)..HEAD --pretty=%s     # commits since
```

Read the repository's release configuration, previous versions, and user-visible change set before proposing a version. Commits are evidence, not the policy itself.

## Pre-flight

- On the default branch (or the release branch), current with origin, clean tree.
- The commit being tagged is the one you intend to ship. If CI is the gate, confirm it on that commit via **gh-cli** before tagging.
- Version files updated and committed (`package.json`, `Cargo.toml`, `pyproject.toml`, `__version__`). The tag and the manifest must agree; a mismatch is a support ticket six months later.
- Lockfile regenerated if the version is in it.

## Tag

Annotated, never lightweight. A lightweight tag has no tagger, no date, no message, and `git describe` treats it differently.

```bash
git tag -a v1.4.0 -m "v1.4.0"
git tag -v v1.4.0        # verify, if signing
```

Sign it if the repo signs commits: `git tag -s`.

```bash
git push origin v1.4.0
```

Push the one tag by name. Never `git push --tags` — it publishes every local tag including experiments and other people's leftovers.

## Never move a published tag

A pushed tag is immutable in practice. Clones that already fetched it will not update it, so the same tag name now means two different commits depending on who you ask — the worst failure mode in a release system.

If the wrong commit was tagged: publish a new version. `v1.4.1`, not a corrected `v1.4.0`. Deleting and re-pushing a tag requires an explicit decision *and* an announcement to everyone who may have fetched it.

## Changelog

Generate from the commit range, group by type, and **edit it**. A raw commit dump is a log, not a changelog — the audience is users, not contributors.

```markdown
## v1.4.0 — 2026-07-24

### Breaking
- Config key `auth.timeout` is now milliseconds, was seconds. Multiply existing values by 1000. (#412)

### Added
- Session refresh without re-authentication (#398)

### Fixed
- Null token on concurrent login (#405)
```

Rules:

- Breaking changes first, with the migration step, always.
- One line per user-visible change. Internal refactors don't appear.
- Link the issue or PR.
- Past tense or noun phrases here — the imperative-mood rule is for commit subjects, not for prose users read.

## Hotfix on a released version

Branch from the affected release tag or maintained release branch, not automatically from the default branch:

```bash
git switch -c fix/PROJ-500-token-expiry v1.4.0
# fix, test, commit; land through the repository's approved PR workflow
# tag the resulting release commit only after it is reviewed and accepted
```

Tagging a local, unreviewed hotfix branch bypasses repository policy and can tag a commit that never landed. After release acceptance, port the fix forward to every maintained successor branch (`cherry-pick` or the repository's prescribed flow), or it can regress in the next release.

## After release

State in the summary: the version, the tagged SHA, what's in it, and whether the tag was pushed. If a package registry publish is part of the flow, that's a separate outward-facing action and a separate ask.
