# Review delta

Canonical owner: [`DEVELOPMENT.md#review-mode`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#review-mode).

Load `change-review`, `gh-cli`, and the relevant stack skill. Review the exact application or docs PR revision and its required companions without mutating source, GitHub state, or review state.

Falryn-specific checks:

- delivery owner and companion completeness;
- canonical contract and `CURRENT-STATE.md` truth;
- product wiring, projections, persistence, recovery, and bounds affected by the diff;
- docs impact and required merge order.

Use `change-review` for inventory, findings, severity, evidence, and report shape. Review never posts, approves, merges, or authorizes delivery.
