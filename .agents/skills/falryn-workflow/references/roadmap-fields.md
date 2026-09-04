# Roadmap fields and automation

The private Falryn Roadmap owns scheduling metadata for maintainer-selected product-development issues in the two canonical repositories. Project membership is deliberate adoption into that plan. Repository issues outside the Project are ordinary contributions or discussions and have no Roadmap field requirements. This file owns the exact field vocabulary, option descriptions, transitions, and Project automation contract. The repository auditor in `tools/roadmap-governance.ts` is the executable copy of this contract.

## Priority

Priority answers only: “How urgently should this issue be selected among work whose dependencies permit it?” It does not encode severity, readiness, blocking, progress, or issue type.

| Option | Color | Exact description | Use |
| --- | --- | --- | --- |
| `P0` | Red | `Immediate: approved active security, data-loss, availability, or release emergency.` | A current emergency with `P0 approval: @owner on YYYY-MM-DD — reason` in the public issue. Never infer it. |
| `P1` | Orange | `High: milestone critical path, safety prerequisite, or multi-outcome unlocker.` | Critical-path, safety-prerequisite, or high-leverage required work. |
| `P2` | Yellow | `Normal: required milestone work outside the critical path.` | Default when a maintainer adopts an open issue into the Roadmap, and for ordinary required milestone work. |
| `P3` | Gray | `Low: optional, experimental, polish, or safely deferrable work.` | Useful work that may move without compromising the milestone. |
| `Historical` | Gray | `Closed-only: no contemporaneous P0-P3 value; excluded from routing.` | Closed legacy records only. Never assign it to new, open, or reopened work. |

Retain the last real P0–P3 value when current work closes. `Historical` preserves the absence of a trustworthy old value; it is not a low priority.

## Readiness

Readiness answers only: “What planning action is valid for this issue now?” It is independent of native blocker state.

| Option | Color | Exact description | Use |
| --- | --- | --- | --- |
| `Ready` | Green | `Verified PR-sized contract; implementation may start when assigned and unblocked.` | Open PR-sized leaf with complete current metadata and a non-empty fully checked Ready checklist. |
| `Needs Planning` | Yellow | `Needs source evidence, scope, boundaries, validation, or documentation impact.` | Default for a newly adopted open leaf and any Roadmap leaf whose implementation contract is incomplete or stale. |
| `Needs Decision` | Red | `Planning is paused on a named maintainer product, policy, or tradeoff decision.` | Open leaf whose next missing fact cannot be safely derived. The public body must contain `Decision required: @owner — question`. |
| `Parent` | Blue | `Open outcome routes through native PR-sized children; never implemented directly.` | Open issue with native children. |
| `Historical` | Gray | `Closed issue; excluded from current routing.` | Every closed issue. |

`Needs Decision` is deliberately narrow. Use it only when planning cannot continue without an explicit human choice. Once the decision and rationale are recorded, return the issue to `Needs Planning`; Plan verifies the remaining contract before `Ready`.

Do not add `Blocked`, `In Review`, or documentation values to Readiness. Native blocked-by relationships, Project Status, pull-request state, and documentation-impact results already own those facts.

## Transitions

| Event | Status | Priority | Readiness |
| --- | --- | --- | --- |
| Maintainer adopts an open leaf into the Project | `Todo` | `P2` unless planning proves another value | `Needs Planning` |
| Explicit unresolved decision | `Todo` | Preserve current P0–P3 | `Needs Decision` with a named decision line |
| Decision recorded | `Todo` | Preserve current P0–P3 | `Needs Planning` |
| Public contract verified | `Todo` | Preserve current P0–P3 | `Ready` |
| Implementation starts | `In Progress` | Preserve current P0–P3 | `Ready`; active leaves never use a planning state |
| Open blocker appears | `Todo` | Preserve current P0–P3 | Preserve planning evidence; blockers are independent |
| Open parent | `Todo` or valid `In Progress` | P0–P3 | `Parent` |
| Issue closes after delivery | `Done` | Preserve P0–P3, or legacy `Historical` | `Historical` |
| Issue reopens | `Todo` | Restore or select current P0–P3 | `Needs Planning`, then re-verify |

Any material change to the source baseline, scope, limits, native hierarchy, blockers, validation, or documentation impact invalidates the affected evidence. Reconcile the field and rerun the required audits rather than carrying a stale `Ready` value.

## Project automation

The private Project must keep these workflows enabled:

- `Auto-add sub-issues to project`;
- `Auto-close issue`;
- `Item added to project`;
- `Item closed`;
- `Pull request linked to issue`; and
- `Pull request merged`.

Do not enable a broad `Auto-add to project` rule for repository issues. A maintainer adds an issue only after deciding it belongs in product development. The `Item added to project` workflow initializes an adopted open leaf as `Todo`, `P2`, and `Needs Planning`; issue closure produces `Done` and `Historical` readiness; native parents are reconciled to `Parent`; and linked delivery work reconciles Status without bypassing readiness or blocker checks.

GitHub's API exposes workflow names and enabled state but not every rule and filter. The Roadmap audit therefore proves that required workflows are enabled, while a maintainer must inspect their filters and field effects after creation, field migration, or workflow editing. Public issue forms must not carry a `projects` key. Contributors neither see nor populate the private plan.

## Safe field migration

Land and publish the public skill, templates, workflow checks, and schema-versioned auditors before changing live option names or descriptions. Then update the private Project, preserve existing issue values during the `Not Ready` to `Needs Planning` rename, add `Needs Decision`, remove any broad repository auto-add rule, verify the remaining automation configuration, and run both live audits. Never leave the live Project on a contract that the published auditor rejects.
