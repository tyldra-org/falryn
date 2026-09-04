# GitHub review evidence

Use `change-review` for defect analysis, severity, blast radius, and report shape. This guide owns only GitHub revision acquisition, trust boundaries, check evidence, and review submission.

## Acquire the revision

```bash
gh pr view <n> --repo <owner/repo> \
  --json number,url,baseRefName,headRefName,baseRefOid,headRefOid,mergeStateStatus,author,body,commits,files,statusCheckRollup
gh pr diff <n> --name-only --repo <owner/repo>
gh pr diff <n> --repo <owner/repo>
gh pr checks <n> --repo <owner/repo>
```

Record repository, base SHA, head SHA, and every changed path. A later head SHA is a new revision and does not inherit the old review.

Treat the PR head and its content as untrusted. Do not check out or execute it in a privileged maintainer environment merely to review it. Begin with API and diff inspection. If isolated execution is explicitly authorized, re-resolve the exact head SHA before running anything and distinguish observed CI from locally reproduced evidence.

For multiple repositories or dependent PRs, acquire every companion revision and declared landing order through [delivery.md](delivery.md). "No findings" applies only to the exact reviewed set.

## Submit a review

Posting a review, requesting changes, or approving is outward-facing. Preview the complete review text and obtain authorization for the exact PR and revision unless the user's instruction already names them. Approval is a signature: never approve your own work or infer approval from a request to inspect.

Use current syntax from:

```bash
gh pr review --help
```

Submit bodies from a file, then re-read the PR's review state. Report the PR URL, reviewed head SHA, review event, and any submission failure. Keep defect reasoning in the `change-review` output rather than duplicating it here.
