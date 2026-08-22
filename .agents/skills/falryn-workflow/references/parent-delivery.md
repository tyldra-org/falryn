# Parent delivery

Read this with [Deliver](deliver.md) for a parent target. A parent is a
scheduler, never a parent branch, mega-PR, or second controller.

| Selector | Scope | Stop condition |
| --- | --- | --- |
| Parent issue #N | First eligible ordered, unblocked incomplete child | One child fully lands; report its exact next-child Deliver prompt |
| Parent chain #N | Every remaining ordered, unblocked incomplete child | All children and parent integration pass, or a real stop |

Every child cycle is serial: readiness → implementation → fresh Verify →
docs-first merge → application merge → GitHub/Project/local-checkout
reconcile. An opened PR, started CI, green job, or closed issue is not a
completed child.

Before selecting a child, confirm the authenticated GitHub account is its sole
assignee. A child owned by another account is a real stop: name the owner and
route that exact child to it. Do not skip an ordered child or take it over.

For a Parent chain:

- Start the next child immediately after reconciliation. Do not end after a
  merge, PR, CI start, status report, or because the next slice is large.
- Do not emit a per-child handoff or a resume prompt while siblings remain.
  Keep a concise progress line, for example:

  ~~~text
  Parent chain #264: #265 Done → #266 in progress → #267–#270 pending
  ~~~

- /loop and /goal lead to the same controller, but their host syntaxes differ.
  In Codex, either set the objective directly with
  `/goal Deliver — Target: Parent chain #N` or, when the Desktop UI has
  already entered Goal mode, send `Deliver — Target: Parent chain #N` as that
  goal's objective. In another harness, use either its supported `/goal` or
  `/loop` mode-entry syntax; an inline target is valid only when that harness
  supports it. Neither entrypoint authorizes parallel phase agents or writers.
- Keep the controller active while required CI resolves. If the host cuts the
  turn during CI, merge, or reconciliation, report the PR URLs, head SHAs,
  progress, and Deliver — Target: Parent chain #<same parent> as the resume
  prompt.
- After the last child, run the parent's integrated verification. Close the
  parent only when it passes; then route through Next without starting an
  unrelated target.

Real chain stops are awaiting a required user decision, an unsatisfied merge
precondition, or three repair passes without progress. Name the exact active
child and resume selector.
