# Current state

This file is Falryn's sole concise implementation-status owner. It records what
exists and has been verified in the `falryn` repository. It does not duplicate
the product design or GitHub roadmap.

Last reconciled: **2026-08-01**

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

Only the `configuration`, `data`, `cancellation`, and `internal` categories are
emitted today. The rest of the vocabulary is declared so later owners attach to
it. No error code is stable.

The configuration schema introduced by
[#7](https://github.com/yogeshprasad098/falryn/issues/7) adds the configuration
contract — value model, scope, source kind, sensitivity, declared merge
behavior, credential-reference type, validation-issue union, and the registry
port — to `src/domain/`, and a new source area at `src/config/` behind
`src/config/index.ts`. It owns the `falryn.configuration` schema family, whose
source owner is that area and whose `schemaVersion` starts at `1`. The area
imports `src/domain` and Zod and nothing further out; it opens no file, reads no
environment, and composes no layer.

Its verified behavior:

- every key declares a Zod 4 type, default, unit and range, scope availability,
  merge behavior, sensitivity, application class, environment mapping, alias and
  deprecation, and cross-field dependencies, and merge behavior is declared per
  key so composition has no generic deep merge to fall back on;
- a document declares its `schemaVersion`. A version this build owns is read
  strictly and an unrecognized key is an error; a newer version whose
  `minimumReaderSchemaVersion` this build meets is read tolerantly and an
  unknown key is dropped with a warning naming both versions; a newer required
  semantic is rejected while reporting the minimum compatible version;
- a limit is a bounded positive integer or the word `unlimited`, so zero,
  negative, missing, and unlimited stay four distinct facts, and a value above a
  safe hard maximum is an error rather than a silent clamp;
- a deprecated spelling resolves to its canonical path and a deprecated key is
  accepted, each with a visible warning; a key set from a scope it does not
  declare is refused;
- folding one document over the defaults obeys each key's declared merge
  behavior, so a document that sets one entry of a map key keeps the default
  entries beside it, and cross-field rules run over that whole value — an
  impossible combination fails at compose time rather than at use time.
  Combining several layers across sources is still #8's;
- a folded value is rechecked against the declaration that bounds it, because a
  fold can produce a value neither the document nor the default stated: an
  identified list at exactly its maximum, folded onto a non-empty default, is
  longer than both and longer than the key allows. A declared bound the
  effective value does not obey would be the same defect as a silent clamp;
- every issue reports a path, an issue kind, and the constraint that was
  violated, and never the rejected value — proven by negative controls that feed
  credential-shaped values through every declared type; and
- rendering withholds by declaration: a declared-sensitive value is replaced
  wholesale, a credential reference is shown as store kind, consumer, and
  account label with its locator withheld, and a public value still passes
  through #5's redactor. Configuration writes no redaction rules of its own —
  the redactor is injected as a domain port, because `src/config/` may not
  import the application layer.

The catalog is deliberately smaller than the mechanism. Only the `data` group
consumed by [#10](https://github.com/yogeshprasad098/falryn/issues/10) — root
overrides, retention classes, and quotas — and the `diagnostics` group consumed
by #5's collector and debug window are declared. The other groups named in the
configuration reference are owned elsewhere and are not invented here, on the
same rule that keeps an unemitted error category out of the emitted set. No
declared key relocates the configuration root, because discovery has to find
that root before it can read a key. No declared key has an alias or a
deprecation either, because none has a predecessor; those shapes, the
merge-by-identity list, the declared-sensitive value, and the credential
reference are proven against fixture registries rather than against an invented
product key.

The configuration load lifecycle introduced by
[#8](https://github.com/yogeshprasad098/falryn/issues/8) adds the source,
provenance, and generation contracts to `src/domain/`, a bounded `readText` to
`FileSystemPort`, and discovery, JSONC parsing, composition, diffing,
classification, publishing, and the inspection projection to `src/config/`.
`jsonc-parser 3.3.1` enters as a product dependency, so the standalone
executable now bundles it.

Its verified behavior:

- **six ordered layers** — built-in defaults, user file, project file, selected
  profile, environment bridge, CLI override — with precedence declared as data
  rather than as the order a function calls things in;
- discovery reads bytes and executes nothing. The project source resolves from a
  caller-supplied workspace path rather than by walking ancestors or consulting
  Git, and a profile name that is not a legal file name is refused rather than
  sanitized into a different profile;
- every failure mode of a source is its own reported outcome — absent, empty,
  unreadable, oversized, mis-encoded, malformed, rejected — and one bad file
  never stops the other layers loading;
- JSONC with comments and trailing commas is accepted; a file that is only
  comments is an empty document rather than a syntax error; a malformed file
  reports a line and a column and never a fragment of its text;
- merging is schema-defined per key across layers, using the same fold the
  registry applies between a document and the defaults, and the folded result is
  rechecked against the declaration that bounds it;
- every effective value carries provenance — source, scope, layer index, schema
  version, and redacted original — and every value a later layer beat is kept,
  so inspection answers "where did this come from and what did it beat" without
  re-reading a file;
- **the environment bridge reads only keys that declare a mapping.** It never
  scans for names that look like settings, and a CLI path nothing declares is an
  unknown key rather than a silent no-op;
- cross-field rules run over the composed whole, so a conflict that no single
  layer contains still fails;
- a change publishes the next generation and appends one
  `configuration.generation.changed` event keyed by the generation, so a
  re-append is a duplicate rather than a second event. A refresh that changes
  nothing publishes no generation and appends nothing;
- each change carries its key's declared application class, and a refresh
  reports the strongest class among them — applying the live half of a mixed
  refresh and calling it done would leave the restart half configured and not in
  effect; and
- **an invalid refresh leaves the last valid generation active**, with the
  reason reported. Composition succeeding while publication fails is a separate
  outcome again, because valid values nobody was told about must not take hold
  silently.

The redacted inspection projection is a data structure: effective value rendered
through each key's declared sensitivity, winning source, overridden values, the
per-source reports, and diagnostics. Rendering it for humans or machines is
#18's and #19's.

The local-data layout introduced by
[#10](https://github.com/yogeshprasad098/falryn/issues/10) adds `FileSystemPort`,
`EnvironmentPort`, and the local-data contracts — roots, ownership classes,
durability, removal posture, retention report, removal plan and outcome — to
`src/domain/`, a new source area at `src/data/` behind `src/data/index.ts`, and
the host filesystem and environment adapters to `src/integrations/`.

The filesystem port is deliberately shallow: it stats, creates one directory,
lists one directory, removes one entry, and resolves one link. Recursion,
symlink-escape checks, and every other dangerous decision live in `src/data/`,
where they are tested against an in-memory double rather than against a real
disk.

Its verified behavior:

- seven separate roots — configuration, state, cache, logs, temporary ingest,
  artifacts, exports — resolve from platform conventions and explicit
  environment overrides and from nothing else. Durable data and rebuildable
  caches never share a root, so they can never share deletion semantics;
- **configuration never relocates the roots configuration discovery needs.**
  The configuration root moves only through `FALRYN_CONFIG_DIR`, which is what
  breaks the otherwise-circular dependency between root resolution and
  configuration composition;
- preparation creates only the roots the caller asked for, with owner-only
  permissions. A root that is a file, is unwritable, or is group- or
  world-readable is a named diagnostic and is never repaired, replaced, or
  chmod-ed — each of those destroys the evidence that something else is using
  the path. An unusable environment override falls back and is reported rather
  than silently ignored;
- an ownership class exists because an owner registered it, not because it
  appears in the documented vocabulary. Registrations sit with their owners:
  configuration in `src/config/`, logs beside the diagnostics collector, and
  temporary ingest and the external credential-reference class in `src/data/`.
  A second owner for one class is refused, and a class no owner registered is
  named in every plan and never acted on;
- retention reports bytes and item counts per class against budgets a caller
  supplies, and enforces nothing. The walk is bounded and never follows a
  symlink; a walk that stops at its bound reports `unmeasured` rather than a
  verdict drawn from a number it knows is short;
- reset and uninstall produce a plan naming every class, its exact paths, its
  counts, what is preserved, and what is out of scope. Execution requires a
  confirmation carrying that exact plan's identity, and the identity is
  re-derived from the plan's own content, so a plan edited after being shown is
  refused;
- the executor re-checks every path against the layout at delete time, removes
  a symlink as a link without touching its target, refuses a directory that
  resolves outside its root, is idempotent, and reports deleted, retained, and
  failed as three separate facts. A removal that failed on some paths, or that a
  cancellation or a bound stopped before it reached them, reports `partial` and
  a `partial` completeness — never `completed`. A path it never reached is
  recorded as `not-reached` rather than as one the plan chose to keep, and a
  cancellation after the first deletion returns that outcome rather than a
  refusal, because by then some bytes are already gone; and
- uninstall's blast radius is bounded by what owners registered. A fixture
  containing a project, a shell startup file, a package-manager directory, and a
  user export proves none of them appears in a plan or is removed, and a user's
  own exports are out of scope for both actions.

Startup reconciliation of temporary ingest reports every entry it finds as
`uncertain` and removes nothing. Whether a leftover file represents finished
work is knowable only by the owner that wrote it, and no such owner exists yet.

**macOS is the qualified target.** The Linux XDG and Windows layouts are
declared so the layout is not macOS-shaped by accident, and both are marked
unqualified: they resolve, and nothing claims they were verified on those
targets.

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

A unit can outlive its scope, because settling is cooperative and a scope may
complete while work under it is still stopping.
[#299](https://github.com/yogeshprasad098/falryn/issues/299) makes that ordering
observable rather than silent: the scheduler no longer discards the refusal, and
`ScopeTree.recordLateEffect` folds the late effect into every surviving ancestor
using the same upward fold a scope performs when it settles normally. The settled
scope's own terminal outcome is never rewritten, and the scheduler warns —
naming the unit, the scope, and the effect — whenever a late effect demands
inspection.

Two limitations of that wiring:

- the drain polls every 10 ms through `ClockPort` rather than waiting on a
  quiescence signal, because the scheduler reports a running count and publishes
  no such signal. The poll is bounded and deterministic under a manual clock and
  carries no correctness risk; and
- a late effect whose scope was already evicted is reported but not attributed.
  Eviction refuses a scope with live scope *children*, and scheduled units are
  not children, so a settled scope with a still-running unit is evictable. The
  diagnostic still names the unit and the effect; there is no ancestor chain left
  to fold into. Changing that would change the eviction policy, which #299's
  non-goals excluded.

**One `RuntimeEvent` kind now has a production producer.** The configuration
loader appends `configuration.generation.changed` whenever it publishes a
generation, through the in-memory store #2 shipped; durable persistence stays
with [#13](https://github.com/yogeshprasad098/falryn/issues/13). The remaining
seven kinds describe sessions, turns, model attempts, and capability
invocations, and the runtime backbone still has none of those concepts — their
first producers are #13 for sessions and turns and
[#40](https://github.com/yogeshprasad098/falryn/issues/40) for model and
capability kinds. Inventing scope or scheduler event kinds to fill the gap would
create events with no consumer.

`src/main.ts` composes the cancellation lifecycle, so the compiled executable includes
the domain, application, and integration layers and the real process-signal
adapter. There is no product work to run yet, so the bootstrap shuts down
immediately and exits.

Observed on 2026-08-01:

```text
bun run check  PASS  (Biome, tsc --noEmit, and bun test)
bun run build  PASS  (Bun standalone executable compiled to dist/falryn)
```

No module or test count is recorded here. Re-running these commands re-proves
that they pass, but it re-proves no count, so a count decays silently between
runs — one did so by mis-transcription and one by an ordinary sibling delivery,
which is why neither is recorded now. Exact output belongs to the pull request
that observed it, which is dated by its own merge and is never re-read as a
current claim.

A separate compiled probe confirmed that root resolution produces byte-identical
output in source mode and in a Bun standalone executable, both for platform
defaults and for an environment override. The probe is not part of `bun run
check`; `src/main.ts` composes no local-data service, so nothing in the shipped
bootstrap resolves a root.

The compiled file is a development bootstrap artifact. It is not a supported
Falryn product binary or release. A separate compiled probe confirmed that a
`SIGINT` delivered to a Bun standalone executable reaches the runtime lifecycle,
cancels the root scope, and runs all ten shutdown phases to a `completed`
outcome. Automated compiled-executable checks are not yet part of `bun run
check`.

## Not implemented

No end-user product behavior has been implemented. In particular, the
repository does not yet provide:

- the shutdown participants other than the scheduler drain — persistence,
  artifact finalize, child-process termination, and terminal restoration each
  register from their own owner and none exist yet;
- watching configuration sources, and writing configuration files. Nothing in
  v0.1 runs long enough to observe a live reload and nothing sets a value, so a
  watcher and a serializer would be scaffolding with no caller. Refresh is an
  explicit call carrying the complete diff, classification, and publish path;
- credential resolution and storage; SQLite; or artifacts. A session, turn, and
  event *identity* exists — what does not exist is anything that produces or
  persists those;
- any composition of the configuration loader into a running program.
  `src/main.ts` constructs no loader, so no configuration file is read on a real
  run;
- any composition of the local-data service. Roots, ownership classes,
  retention reporting, removal planning, guarded execution, and reconciliation
  exist and are tested, and `src/main.ts` constructs none of them, so no
  directory is created and nothing is measured or removed on a real run. The
  owners that will register the remaining ownership classes — SQLite state,
  artifacts, memory, extensions, exports — do not exist, and each is reported as
  unregistered rather than assumed absent;
- the command surfaces that would show a reset or uninstall plan and collect its
  confirmation. This area produces the plan and the typed outcome; rendering
  them and asking is the CLI's;
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
- **Next planning action:** verify parent [#1 Establish the unified runtime and lifecycle](https://github.com/yogeshprasad098/falryn/issues/1) against its integrated acceptance criteria.

Which of #1's children are open, and which delivered the behavior recorded
above, is read from
[#1](https://github.com/yogeshprasad098/falryn/issues/1) and the
[v0.1 Foundation milestone](https://github.com/yogeshprasad098/falryn/milestone/1)
rather than copied here. GitHub renders that live; a hand-maintained list of it
went stale three deliveries running, and the "Implemented and verified" section
above already attributes each capability to the issue that delivered it.

No release has been published.
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
