# OpenTUI documentation provenance

The `docs/` directory is an unmodified snapshot of OpenTUI's official MDX documentation for the package version used when this bundle was refreshed.

| Field | Value |
| --- | --- |
| Repository | `https://github.com/anomalyco/opentui` |
| Tag | `v0.5.9` |
| Annotated tag object | `a46022237cc92826558e8f493e3d00874b8b8d18` |
| Commit | `df2fc1594bb7a1274fc490155305e3d9f61f1b01` |
| Source path | `packages/web/src/content/docs/` |
| Files | 76 MDX files |
| License | MIT; see `LICENSE.opentui` |

## Refresh contract

1. Resolve the exact installed `@opentui/core`, `@opentui/react`, and related versions from the target project's lockfile.
2. Resolve the matching signed or annotated upstream tag to its commit. Stop if the tag is absent or ambiguous.
3. Clone or archive that exact commit into a temporary directory without executing package scripts.
4. Replace `docs/` from `packages/web/src/content/docs/` exactly; do not mix files from different revisions.
5. Update every field above and copy the upstream license.
6. Verify recursive file count and byte equality against the temporary source.
7. Validate all local MDX links, the top-level routing table, and representative installed package exports.
8. Review the resulting diff. An upstream docs refresh is data import, not proof that application code is compatible with the new package.

`references/` and `SKILL.md` are maintained guidance and are intentionally outside the upstream snapshot comparison.
