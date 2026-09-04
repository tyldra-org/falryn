# Private authority

Falryn has two private maintainer authorities:

- the `tyldra-org/falryn-docs` repository for complete product, architecture, documentation-ownership, future-design, and docs-delivery contracts;
- the `tyldra-org` Roadmap Project 1 for cross-repository Status, Priority, Readiness, liveness, and exact delivery sequencing.

Their existence and identity may be named. Their contents remain private.

## Resolve access independently

Documentation access and Roadmap access are separate facts. Prove each before use.

For a local docs checkout:

1. locate an explicitly supplied checkout or the sibling `../falryn-docs` directory;
2. confirm that it is a Git checkout;
3. inspect its remote URL and require exact repository identity `tyldra-org/falryn-docs`;
4. read its `AGENTS.md` before any file or Git operation; and
5. inspect its current branch and revision rather than relying on remembered content.

An unrelated directory named `falryn-docs` is not authority. Do not add, replace, or rewrite its remote to make it qualify.

Without a local checkout, authenticated `gh` access may read the exact private repository. Never clone it automatically, broaden visibility, request a token in chat, place a token on a command line, or persist fetched private content in Falryn.

Roadmap access exists only when the authenticated account can read the exact organization Project and its required fields. Repository issue access does not imply Project access. A cached report is authoritative only for its recorded snapshot and scope. Use [governance audits](governance-audits.md) after proving access; use [documentation delivery](documentation-delivery.md) after resolving the canonical owners.

## Access profiles

### Public-only

Use public Falryn source, tests, `CURRENT-STATE.md`, issue and pull-request bodies, GitHub checks, and repository guidance. This profile may:

- inspect or review an explicit public issue or pull request;
- verify the application revision and public evidence;
- plan a public issue body without claiming private readiness; and
- prepare an ordinary contribution under `CONTRIBUTING.md`.

It may not:

- infer or report private Status, Priority, Readiness, ordering, or docs contents;
- declare a cross-repository delivery bundle complete;
- route Next or a parent chain;
- act on a docs-only target; or
- merge an application change whose required private documentation impact is unresolved.

Return `unavailable` with the missing authority and the safe public action. Do not call the operation failed when the public evidence itself is valid.

### Authenticated maintainer

This profile requires the exact private authority needed by the operation. It may add private documentation-owner checks, Roadmap audit results, Project reconciliation, docs-only work, and docs-first bundle delivery.

Private evidence informs the action but does not become public output automatically. Public reports state only the classification needed for delivery, such as `documentation update required`, `verified unaffected`, or `private Roadmap access unavailable`. They do not reproduce private text or planning records.

## Public implementation rule

A Roadmap-owned public Falryn issue is the maintainer implementation handoff. Before an authenticated maintainer marks it Ready, its body must state every issue-specific baseline, scope, boundary, failure and recovery rule, product composition point, validation requirement, and documentation impact needed to implement it. Ordinary contribution issues use the lighter public contract and require no private field.

A private link may provide broader maintainer context, but it cannot replace those public facts. If the issue is incomplete, Plan updates the public issue or reports Needs Planning; if a named human choice is required, it reports Needs Decision. It never tells a public contributor to discover missing behavior in a private document.

## Connection lifecycle

Revalidate private authority at each state-changing boundary and after authentication, branch, repository, Project, or revision changes. Losing access changes the operation to `unavailable`; it does not preserve stale permission. Replay and exported public evidence never embed private bodies or Project snapshots.
