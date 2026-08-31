# Contributing to Falryn

## Contribution status

Falryn is public for reading, use, and forking, but it is not yet accepting
outside issues or pull requests. GitHub restricts those interactions to
collaborators while the foundation changes quickly.

Security reports remain welcome. Please use the private process in
[SECURITY.md](SECURITY.md), not a public issue.

## When contributions open

The expected contribution path will be conventional:

1. discuss a meaningful outcome in a GitHub issue;
2. create a short-lived, focused branch;
3. open one pull request with its scope and validation; and
4. run bun run check before requesting review.

Contributions will be evaluated on correctness, scope, tests, and documentation
for released behavior—not on an editor, agent, or workflow choice.

## Fast local checks

Use the smallest command that proves the current edit while iterating:

```sh
bun run check:static       # quality, types, repository integrity, and catalogs
bun run test:changed       # tests affected relative to main
bun test src/domain/opportunity-plan.test.ts  # one test file
bun run test:watch         # rerun tests while files change
```

Run the bounded four-worker suite when a change needs full local coverage:

```sh
bun run test:parallel
```

`bun run check:fast` runs the static checks and that parallel suite. Do not nest
it inside another `bun run --parallel` call because both stages already create
concurrent work. Before requesting review, run the canonical checks:

```sh
bun run check
bun run build
```

[CONTRIBUTOR-READINESS.md](CONTRIBUTOR-READINESS.md) records the safeguards
already prepared for that transition.
