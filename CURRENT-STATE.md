# Current state

This file is Falryn's sole concise implementation-status owner. It records what
exists and has been verified in the `falryn` repository. It does not duplicate
the product design or GitHub roadmap.

Last reconciled: **2026-07-30**

## Where to look

| Question | Canonical owner |
| --- | --- |
| What should Falryn become? | [`falryn-docs`](https://github.com/yogeshprasad098/falryn-docs) and its [documentation map](https://github.com/yogeshprasad098/falryn-docs/blob/main/DOCUMENTATION-MAP.md) |
| What is planned, active, blocked, or complete? | [Falryn Roadmap](https://github.com/users/yogeshprasad098/projects/2), milestones, parent issues, native subissues, and linked pull requests |
| What is actually implemented now? | This file, checked against the current source, tests, manifests, and build |
| What proves a change? | The owning issue, merged pull request, code, focused tests, and applicable compiled/platform checks |
| What has shipped? | GitHub Releases and verified installation/support documentation |

Specifications and open issues are target state, not implementation evidence.
Closed checklists or Project fields do not override the source and validation
results recorded here.

## Implemented and verified

The implementation scaffold introduced by
`503ab52545a70d4cadb3265cb356feea95d31a2f` contains:

- a private Bun package pinned to Bun `1.3.14`;
- strict TypeScript `7.0.2` configuration;
- Biome `2.5.6` formatting and linting configuration;
- a single TypeScript bootstrap in `src/main.ts`;
- one bootstrap smoke test in `src/main.test.ts`;
- repository-owned quality, type-check, test, and compiled-build commands; and
- a Bun standalone compilation target at `dist/falryn`.

Observed on 2026-07-30:

```text
bun run check  PASS
bun run build  PASS
bun test       1 pass, 0 fail
```

The compiled file is a development bootstrap artifact. It is not a supported
Falryn product binary or release.

## Not implemented

No end-user product behavior has been implemented. In particular, the
repository does not yet provide:

- the runtime identities, event model, scheduling, cancellation, or recovery
  services;
- configuration, credentials, local-data, SQLite, session, or artifact
  behavior;
- yargs commands, headless product behavior, or the OpenTUI application;
- provider integration, model routing, the agent loop, or unified tool
  execution;
- workspace, read, search, patch, shell, Git, LSP, DAP, browser, or computer-use
  capabilities;
- context planning, Brief, Hush, Loom, compression, indexing, or memory;
- MCP, skills, hooks, plugins, marketplace, agents, jobs, or workflows; or
- an installer, updater, supported platform package, signed release, or support
  channel.

The detailed target contracts for these capabilities live in `falryn-docs`.
Their implementation breakdown lives in GitHub Issues and the Project.

## Planning frontier

- **Live roadmap:** [Falryn Roadmap](https://github.com/users/yogeshprasad098/projects/2)
- **Current release outcome:** [v0.1 Foundation issues](https://github.com/yogeshprasad098/falryn/issues?q=is%3Aissue%20is%3Aopen%20milestone%3A%22v0.1%20Foundation%22)
- **First parent outcome:** [#1 Establish the unified runtime and lifecycle](https://github.com/yogeshprasad098/falryn/issues/1)
- **Next planning action:** make [#2 Define stable runtime identities and event envelopes](https://github.com/yogeshprasad098/falryn/issues/2) Ready by resolving its Ready checklist and exact dependencies; then implement it as the first focused pull request.

No issue is currently recorded here as implemented, in progress, or released.
GitHub owns live workflow state; this section provides a stable entry point and
must be reconciled when the frontier materially changes.

## Update rule

Update this file in the same implementation pull request when verified behavior
is added, removed, replaced, or made unavailable. Record only:

- the smallest implemented capability inventory;
- the exact validation that supports it;
- material limitations;
- the current planning frontier; and
- release/support truth.

Do not add phase plans, issue checklists, schedules, gates, evidence registries,
or copies of design contracts. Link their canonical owner instead.
