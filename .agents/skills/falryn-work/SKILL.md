---
name: falryn-work
description: Complete or assess a selected Falryn issue, PR, or documentation outcome using Deliver or the manual Plan, Implement, Review, Verify, and Merge commands. Also maintain Falryn workflow guidance.
---

# Falryn work

Keep the user's outcome, scope and stopping point explicit. Continue from the
work that actually remains. Source, issue acceptance and observed results decide
the next action; a fixed sequence of agent roles does not.

## Interpret the request

Keep `Command - Target: ...` syntax, including typographic dashes, and accept
unambiguous natural-language requests. Resolve [targets](references/targets.md)
only when an issue, PR or delivery scope needs resolution.

| Command | Authorized work and stopping point |
| --- | --- |
| Plan | Complete the issue contract and applicable planning records; stop before implementation |
| Implement | Complete one admitted issue, review and verify acceptance, repair in-scope gaps, and prepare its PR; stop before merge |
| Review | Assess the exact PR diff and report findings; no editing or posting |
| Verify | Establish acceptance or merge readiness; only separately authorized governance reconciliation |
| Merge | Merge and reconcile the exact verified, authorized delivery; no implementation repairs |
| Deliver | Complete the selected outcome, including implementation, review for gaps, acceptance verification, in-scope repairs, PRs, required companions, merge and reconciliation |
| Next | Route selection to [falryn-roadmap](../falryn-roadmap/SKILL.md); it starts no delivery |

A question, greeting, walkthrough or ordinary edit keeps its ordinary scope.
Answer it from relevant evidence. Do not turn it into Next, adopt a Roadmap issue,
or infer permission to publish. "What should I work on next?" requests selection;
"What changed in this PR?" requests an assessment of that PR.

Read applicable `AGENTS.md`, `DEVELOPMENT.md` and the selected issue or PR.
Use `software-engineering-discipline` for engineering judgment, stack skills for
implementation, `change-review` for assessment, `git-operations` for Git and
`github-operations` for GitHub. Reuse unchanged instructions. This skill owns
only Falryn coordination; it does not repeat those skills' procedures.

## Do the remaining work

Use [work](references/work.md) for the contract, delivery state, proof, merge and
recovery. Use [documentation](references/documentation.md) for canonical owners,
private access and companions. Load [falryn-roadmap](../falryn-roadmap/SKILL.md)
only for Roadmap admission, planning-field changes, selection or parent ordering.
Ordinary public contributions do not require private planning access.

Both Implement and Deliver include the [completion check](references/work.md#prove-the-result).
Check what the user could still find missing before declaring the outcome done;
do not leave review, verification or an authorized repair for a follow-up prompt.

The user's request supplies authority. A useful suggestion does not grant it.
Do not ask again for the same authorized work. Refresh changed evidence and
continue within the command's boundary. Ask when an unresolved choice changes
the outcome, ownership or permitted action. Never narrow acceptance silently.

## Close the loop

Report what finished, what proves it and what remains. Distinguish local, pushed,
merged, partial and unavailable results. Include relevant revisions and checks;
use the specialist review report when assessing a diff. Keep progress updates
about findings and decisions, not stage names or unchanged polls.

Implement and Deliver reports include the completion check's scope, acceptance
and integration evidence, material gaps corrected, and unresolved implementation
or verification gaps. When none remain, say so within the assessed scope. Do not
imply that passing checks prove the absence of every possible defect. Separate
optional enhancements from missing original acceptance. Implement reports PR
preparation separately from later merge and reconciliation; an intentional stop
before merge is not an implementation gap. Unresolved required implementation or
proof remains incomplete under either command.

### Choose the next prompt

Recommend the most useful remaining action, not a fixed command sequence.
Unfinished selected work keeps its issue or existing PR unless the user redirects;
an unrelated open issue does not replace missing acceptance or reconciliation.
Honor manual stopping points without requiring every later manual stage.

After completed maintainer delivery or Roadmap maintenance, look for eligible
work through [falryn-roadmap](../falryn-roadmap/SKILL.md#select-work-with-next).
Reuse valid audits, resolve missing selection evidence when available, run the
selector and recheck a candidate live before recommending it. A large backlog
is a reason to seek actionable work, not proof that every issue is eligible.
Preserve explicit selection scope; otherwise use the generated broad order.

Choose one copy-ready `Suggested next prompt: ...` from the evidence:

| What is actionable | Recommendation |
| --- | --- |
| A clear implementation or delivery outcome, current or newly selected | Prefer `Deliver - Target: Issue #N` or the verified PR/Docs equivalent |
| New-work selection remains uncertain and a focused selection pass can resolve it | `Next - Target: Falryn Roadmap`, or the explicit scoped Next target; explain what needs checking |
| A bounded manual action is the useful remaining step, or the user wants that boundary | The appropriate Plan, Implement, Review, Verify or Merge command with its exact issue/PR |
| No useful delivery, selection or manual action is available | `none`, with the concrete blocker or confirmed absence of actionable work |

Prefer a concrete target when evidence supports it. Do not default to Next merely
because the selector has not been run, or force Deliver by guessing an issue.
An audit result alone is not a selection. Distinguish uncertainty from a known
failure: repeating Next cannot fix denied access, an unchanged audit defect or
a human-owned decision. Name the recovery step or required answer; use Next again
only when new evidence or that recovery makes another selection pass useful.
Blocked work is not an empty backlog, and unavailable evidence proves neither.

Keep recommendation limits separate from completed work. A suggestion authorizes
no execution. Ordinary answers need neither selection nor a command footer;
public contributions outside the maintainer workflow acquire no private access
requirement. Honor requests to omit recommendations or stop without selection.

## Maintain the design

Use `skill-creator` and the global `software-engineering-discipline`. Preserve
user-facing command meanings while replacing internal structure where helpful.
Keep deterministic policy in the repository tools, with references to its owner.
Test behavior across ordinary requests, manual limits, delivery and recovery.

These two Falryn skills are distributed together from the application checkout;
Docs uses the identity-verified sibling, then the installed pair as fallback.
Validate with `python3 scripts/validate_skill.py` from this directory. Sync only
after verifying installed preimages, remove known obsolete files, preserve
unrelated files and check complete parity. Report installation separately from
GitHub delivery. Never publish private snapshots or machine-specific paths.
