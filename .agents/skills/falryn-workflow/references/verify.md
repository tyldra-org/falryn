# Verify delta

Canonical owner: [`DEVELOPMENT.md#verify-mode`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#verify-mode).

Verify reads product source, docs, diffs, checks, artifacts, and exact revisions without changing them. It may mutate only the issue/Roadmap governance state explicitly required by the canonical Verify contract, such as reopening an incomplete owner, reconciling post-merge status, recording a missing PR-sized gap, or closing a fully proven parent.

For a PR, verify the complete delivery bundle and preview every repository, head SHA, docs-first order, final squash subject/footer choice, and safe checkout synchronization. Do not merge. Any later revision or precondition change requires a fresh Verify.

A gap is not silently fixed in Verify; route it through [corrections](corrections.md).
