# Implement delta

Canonical owner: [`DEVELOPMENT.md#implement-mode`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#implement-mode).

- Accept exactly one Ready, unblocked PR-sized issue owned by the authenticated assignee.
- Reuse its valid open branch/PR after a failed Verify; otherwise branch from current default.
- Implement the complete slice with focused evidence and the smallest accurate `CURRENT-STATE.md` change when shipped behavior changes.
- Canonical docs use a linked Falryn Docs companion branch and PR. Code and docs form one delivery bundle but never one cross-repository PR.
- Implement does not merge. A parent target routes to its eligible child and never receives a parent branch.
