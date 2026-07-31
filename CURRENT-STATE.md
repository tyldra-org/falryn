# Current state

This file is Falryn's sole concise implementation-status owner. It records what
exists and has been verified in the `falryn` repository. It does not duplicate
the product design or GitHub roadmap.

Last reconciled: **2026-07-31**

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

The domain contracts introduced by
[#2](https://github.com/yogeshprasad098/falryn/issues/2) add `src/domain/` with
one public entrypoint at `src/domain/index.ts`:

- branded identities for workspace, session, turn, model attempt, invocation,
  capability, event, trace, stream, idempotency key, sequence, and
  configuration generation, each with a boundary parser that reports a code
  rather than the rejected value;
- canonical UTC timestamps;
- the closed semantic event union for eight declared kinds, with model and tool
  events carrying their additional identity, and a payload-free diagnostic
  summary;
- the exhaustive `completed | failed | cancelled | timed-out | uncertain`
  terminal-outcome union with effect certainty carried separately;
- a Zod `4.4.3` codec that enforces a 64 KiB byte bound, rejects malformed
  UTF-8 and JSON, rejects an unknown kind without mapping it onto a known one,
  tolerates additive optional data from a newer producer, and rejects an event
  needing a newer reader while reporting the minimum compatible version;
- scoped sequence rules with per-stream monotonicity, idempotent re-append, and
  replay inspection that reports gaps, duplicates, and out-of-order records
  without repairing them;
- `EventStorePort` with a cancellation-aware in-memory test double; and
- a lossless mapping onto the persisted `StoredEvent` shape.

The control-flow lifecycle introduced by
[#4](https://github.com/yogeshprasad098/falryn/issues/4) adds `ClockPort`,
`SignalPort`, the deadline model, the cancellation scope contracts, and the
shutdown phase and participant contracts to `src/domain/`, plus two new source
areas:

- `src/application/` — the cancellation scope tree, nested immutable runtime
  contexts, the interruption escalation policy, the shutdown coordinator, and
  the lifecycle that composes them, behind `src/application/index.ts`;
- `src/integrations/` — the Bun process-signal adapter behind `SignalPort`, and
  nothing else, behind `src/integrations/index.ts`.

Its verified behavior:

- cancellation propagates from a scope to every descendant and never upward; an
  already-terminal descendant is untouched, and a scope derived under a
  cancelling parent starts cancelling too;
- a derived deadline is the tighter of inherited and requested, so a child can
  never enlarge an inherited limit;
- deadline expiry produces `timed-out` naming the expired deadline and whether
  escalation occurred;
- cancelling work that changed nothing produces `cancelled`; cancelling work
  that had begun mutating produces `uncertain`, and completion never erases a
  recorded partial effect;
- the first interrupt requests cooperative cancellation, repeated interrupts
  escalate through `graceful → escalated → forced`, and escalation shortens each
  phase's grace without skipping a phase;
- the shutdown coordinator runs the canonical ten-phase order with a deadline on
  every phase, is idempotent, aggregates participant failures instead of
  dropping them, records participants that did not finish, and leaves no scope
  in a non-terminal state; and
- forced termination reports `uncertain` for anything it did not observe
  stopping, never `completed`; and
- a scope reports how long it took to acknowledge cancellation, measured from
  the first request, so a slow drain is observable. No threshold is asserted;
  and
- resource bounds count live scopes only, so completed work never exhausts the
  budget. Settled scopes are evicted beyond a retention window after their
  effect is folded into every ancestor — so an evicted descendant's uncertainty
  stays visible from above whatever order the scopes settled in — and the
  lifecycle event log is bounded with the number of dropped events reported
  rather than truncating silently.

The scheduling engine introduced by
[#3](https://github.com/yogeshprasad098/falryn/issues/3) adds the work-unit,
budget, queue, and scheduler contracts to `src/domain/`, and three engines to
`src/application/`:

- **bounded queues** where every enqueue resolves to accept, wait with
  cancellation, spill, coalesce, or a typed limit rejection. Items past the age
  limit are dropped and counted. Display-only deltas coalesce; a semantic fact
  is never merged away and is rejected instead. Separate queues mean a saturated
  maintenance queue cannot block a lifecycle queue;
- **hierarchical budgets** in integer units, where a reservation counts against
  the limit from the moment it is taken, a child can never enlarge what it
  inherited, and a reservation refused by an ancestor is rolled back rather than
  left as a partial charge; and
- **the scheduler**, which validates each generation's dependency graph whole —
  rejecting cycles and dangling edges before anything runs — serializes work on
  normalized conflict keys, treats a mutation that declared no key as contending
  globally rather than guessing it is independent, holds global and per-key
  concurrency caps, ages waiting units so a lower class still makes bounded
  progress under sustained interactive load, releases locks on every terminal
  path, and abandons a runner that ignores its abort signal rather than letting
  it hold the scheduler.

The failure contract introduced by
[#5](https://github.com/yogeshprasad098/falryn/issues/5) adds `FalrynError`,
`SafeCause`, `CorrelationIds`, the recovery-action and exit-category
vocabularies, the structured diagnostic event, and the retry-decision contract
to `src/domain/`, and translation, redaction, the diagnostics collector, and the
recovery catalog to `src/application/`:

- every failure carries code, category, user-safe message, retryability, effect
  certainty, bounded safe cause, correlation, recovery actions, and exit
  category as independent fields;
- each boundary union #2 shipped — codec, identity, sequence, timestamp, and
  event store — maps onto a category while keeping its no-user-data guarantee;
- a cleanup failure is attached to its primary rather than dropped, and #4's
  shutdown participant reports are adopted into that shape without changing
  shutdown; failed and unfinished stay different facts;
- an unrecognized category is preserved and marked unrecognized rather than
  mapped onto a known one;
- redaction runs wherever foreign text enters, covering credential-bearing URLs,
  bearer tokens, provider keys, key/value secrets in text, and — separately —
  any value under a secret-named key in structured metadata, where no key/value
  string exists for a text rule to match; debug mode is time-scoped,
  preview-bounded, and still redacts;
- diagnostics carry timestamp, level, subsystem, code, correlation, stage,
  duration, limits, and safe metadata, bounded in retention, cardinality, and
  metadata keys, and carry no payload content; and
- the retry decision weighs the effect contract, idempotency, attempt count, and
  elapsed budget with bounded, jittered, cancellable backoff. Retryable never
  authorizes an automatic retry, and recovery after uncertainty observes present
  state before acting.

Only the `data`, `cancellation`, and `internal` categories are emitted today.
The rest of the vocabulary is declared so later owners attach to it. No error
code is stable.

The wiring introduced by
[#296](https://github.com/yogeshprasad098/falryn/issues/296) connects those
parts into one lifecycle. `src/application/runtime-lifecycle.ts` constructs the
scheduler, shares one diagnostics collector across the scope tree, scheduler,
and shutdown coordinator, and registers the scheduler's drain as a
`stop-scheduling` shutdown participant. A `WorkUnit.scopeId` is now honoured:
cancelling a scope cancels its queued and running units, and a unit's effect is
recorded on its scope so the two cannot disagree about what happened.

Because `cancel-root-scope` runs before `stop-scheduling`, scoped work is
already stopping by the time the drain participant runs; the drain exists for
work that named no scope, and reports it unfinished when it will not stop.

**`RuntimeEvent` has no production producer yet.** All eight declared kinds
describe sessions, turns, model attempts, and capability invocations, and the
runtime backbone has none of those concepts. The envelope, sequencer, and
in-memory store are implemented and tested but are not emitted from anywhere;
their first real producers are
[#13](https://github.com/yogeshprasad098/falryn/issues/13) for sessions and
turns and [#40](https://github.com/yogeshprasad098/falryn/issues/40) for model
and capability kinds. Inventing scope or scheduler event kinds to fill the gap
would create events with no consumer.

`src/main.ts` composes the cancellation lifecycle, so the compiled executable includes
the domain, application, and integration layers and the real process-signal
adapter. There is no product work to run yet, so the bootstrap shuts down
immediately and exits.

Observed on 2026-07-31:

```text
bun run check  PASS
bun run build  PASS  (112 modules bundled)
bun test       462 pass, 0 fail
```

The compiled file is a development bootstrap artifact. It is not a supported
Falryn product binary or release. A separate compiled probe confirmed that a
`SIGINT` delivered to a Bun standalone executable reaches the runtime lifecycle,
cancels the root scope, and runs all ten shutdown phases to a `completed`
outcome. Automated compiled-executable checks are not yet part of `bun run
check`.

## Not implemented

No end-user product behavior has been implemented. In particular, the
repository does not yet provide:

- any real shutdown participant — the registry exists, but scheduling drain,
  persistence, artifact finalize, child-process termination, and terminal
  restoration each register from their own owner and none exist yet;
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
- **Open children of #1:** [#296](https://github.com/yogeshprasad098/falryn/issues/296).
- **Next planning action:** verify parent [#1 Establish the unified runtime and lifecycle](https://github.com/yogeshprasad098/falryn/issues/1) against its integrated acceptance criteria once #296 lands.

Issues [#2](https://github.com/yogeshprasad098/falryn/issues/2),
[#3](https://github.com/yogeshprasad098/falryn/issues/3),
[#4](https://github.com/yogeshprasad098/falryn/issues/4),
[#5](https://github.com/yogeshprasad098/falryn/issues/5), and
[#292](https://github.com/yogeshprasad098/falryn/issues/292) are the issues with
implemented behavior recorded here. No release has been published.
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
