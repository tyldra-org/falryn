# Parent delivery delta

Canonical owner: the parent behavior within [`DEVELOPMENT.md#deliver-mode`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#deliver-mode).

- `Deliver — Target: Parent issue #N` selects the first ordered, unblocked,
  incomplete child. If that child is Not Ready, the controller runs its bounded
  planning phase before implementation; it never skips ahead to a later Ready
  sibling.
- `Deliver — Target: Parent chain #N` continues the same controller through
  remaining ordered children, one issue/branch/PR/bundle at a time.
- Recompute eligibility with the repository-owned Roadmap audit after each child; never rely on a stale sibling list.
- Keep the parent In Progress while required work remains.
- After the last required child, run integrated parent verification; close and mark Done only when every parent criterion passes.

These are the only parent delivery selectors. Do not introduce another host-specific wrapper.
