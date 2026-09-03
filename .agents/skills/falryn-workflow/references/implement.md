# Implement

Implement accepts one explicitly named, Ready, unblocked PR-sized Falryn issue. A parent target is not an implementation target; route it through its selected child.

## Preconditions

1. Read the complete public issue handoff, source baseline, tests, `CURRENT-STATE.md`, repository guidance, native hierarchy, blockers, and existing delivery pull requests.
2. Require every Ready checklist item to be checked and current. A private link cannot fill a missing public requirement.
3. For upstream maintainer delivery, require authenticated Roadmap access, confirm the authenticated account is the sole assignee, verify Ready and unblocked state, then set In Progress before source mutation.
4. Without private Roadmap access, implementation may still proceed for one explicitly named public issue when its public handoff is complete and the user authorizes work in the current branch or a fork. Record private Project state as unavailable, make no readiness or sequence claim, mutate no private field, and follow `CONTRIBUTING.md` plus the public pull-request contract.
5. Reuse a valid open correction branch and PR only after fresh verification. Otherwise branch from the fetched current default branch.

## Execution

Implement the complete issue with the smallest coherent source and test changes. Update `CURRENT-STATE.md` only when shipped behavior changes. Run focused checks while iterating, then the repository's required validation.

Classify documentation impact as:

- `private-update-required`;
- `private-verify-unaffected`;
- `public-code-adjacent-update`; or
- `not-applicable`.

A contributor without private docs access records the classification and evidence in the Falryn PR. An authenticated maintainer owns any required private docs companion. Do not copy private pages into Falryn or make up a companion link.

Commit and push only intended paths. Open or update one focused application PR with its delivery owner, scope, validation, limitations, documentation classification, and any verified companion identity. Implement never merges unless the originating request is the composite Deliver mode and all fresh delivery conditions pass.

## Stop conditions

Stop on an incomplete issue body, open blocker, ownership mismatch, stale base, conflicting public and private contracts, unavailable required docs companion, failed validation, uncertain external effect, or changed PR revision. Report the exact recovery action.
