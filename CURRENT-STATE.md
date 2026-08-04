# Current state

This file is Falryn's sole concise implementation-status owner. It records what
exists and has been verified in the `falryn` repository. It does not duplicate
the product design or GitHub roadmap.

Last reconciled: **2026-08-03**

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

Only the `configuration`, `authentication`, `data`, `cancellation`, and
`internal` categories are emitted today. The rest of the vocabulary is declared
so later owners attach to it. No error code is stable.

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
  unreadable, oversized, mis-encoded, malformed, rejected — and the load fails
  closed on bad *content* and open on an unavailable *source*. A source that
  could not be read at all is skipped and the load publishes without it; a
  source that was read and does not describe a valid configuration refuses the
  whole load and retains the previous generation. Silently dropping a file whose
  key was mistyped would be the same failure as accepting the typo;
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
per-source reports, and diagnostics. #18 renders it for people; rendering it for
machines is #19's.

The credential contract introduced by
[#9](https://github.com/yogeshprasad098/falryn/issues/9) adds `CredentialStorePort`,
`SecretResolverPort`, `CredentialReferenceStorePort`, the credential health and
removal contracts, and a supervised `CommandRunnerPort` to `src/domain/`;
reference resolution and two-part removal to `src/config/`; the secret resolver
to `src/application/`; and the keychain, environment-reference, and host-command
adapters to `src/integrations/`. `authentication` joins the emitted error
categories and `credentials` joins the diagnostic subsystems, because the
resolver now produces both.

Its verified behavior:

- **a reference carries store kind, opaque locator, consumer, optional account
  label, and observed health, and never the secret.** It is an ordinary
  configuration value with #7's declared-sensitive type, so it inherits that
  registry's validation and its rendering — store kind, consumer, and account
  label shown, locator withheld;
- **resolution is late and narrow.** The port hands the secret to a
  caller-supplied callback and returns only that callback's result. There is no
  `getSecret()`, no store enumeration, and no export. A sweep serializes the
  resolution, the health, the translated error, the inspection projection, the
  `configuration.generation.changed` event, the provenance, the source reports,
  and the diagnostics buffer, and asserts the secret's and the locator's bytes
  appear in none of them;
- **a request is bound to one consumer.** A reference declares who may resolve
  it and a caller declares who is asking; a mismatch is denied before any store
  is named, so a mismatched consumer learns nothing about whether the credential
  exists;
- **nine unresolved statuses stay nine facts** — missing, empty, locked, denied,
  unavailable, unsupported, timed out, cancelled, malformed — each with the
  health it implies. Only a store that answered can report `absent`; a locked or
  unreachable store reports `unreachable`, because reporting it as absent would
  invite writing over a credential that is already there;
- **a plaintext credential is refused with a named diagnostic.** A credential
  key cannot be declared settable from project scope at all, a scalar written
  where a reference belongs is a `plaintext-credential` issue, and a secret
  smuggled in beside the reference is an unknown key. Every one of them reports
  the constraint and never the value, and a user file containing one refuses the
  whole load rather than publishing the rest;
- **local removal is two reported halves.** The secret is deleted first, so a
  failure leaves a reference naming a secret that is still there rather than a
  secret nothing can name again; execution requires a confirmation carrying an
  identity re-derived from the reference's own content; and removing an
  environment-backed credential reports `partial`, because no process can unset
  a variable in the shell that exported it. Remote revocation is
  [#35](https://github.com/yogeshprasad098/falryn/issues/35) and is neither
  attempted nor implied;
- **no native credential module enters the lockfile.** The keychain adapter is a
  narrow `Bun.spawn` leaf over `/usr/bin/security` with a structured argument
  vector, an empty environment, a bounded output, and a deadline. `security`
  exits with the low byte of the `OSStatus` it received, which is what makes the
  exit-status table derivable rather than guessed; a status the table does not
  name is `unavailable` with its code preserved, never `missing`; and
- **the command adapter is tested against real processes.** An empty supplied
  environment reaches the child empty while a variable set in this process does
  not reach it at all; shell metacharacters and `$HOME` arrive as literal
  argument text, because no shell parses them; a child that writes past its
  output bound is killed at the moment the bound is reached and reported as
  exceeding it, rather than left blocked on a full pipe until its deadline
  expires; a deadline and an abort each kill the child and stay distinct facts;
  a missing executable reports an `errno` code and never the path it tried; and
  `stderr` is drained to completion so a noisy child cannot stall the call, and
  then discarded, so no field exists for it to come back in.
- **this adapter is internal.** It is not a tool, is registered in no capability
  catalog, and does not pass through the tool boundary
  [#47](https://github.com/yogeshprasad098/falryn/issues/47) will own. A
  model-requested credential read is not a supported path.

**macOS is the qualified keychain target.** Linux and Windows report
`unsupported` with a stated reason and spawn nothing; qualifying them is
[#220](https://github.com/yogeshprasad098/falryn/issues/220). The
environment-reference store works on every platform, so no host is left without
a credential path.

Two limitations of this slice:

- **a secret cannot be wiped from memory.** JavaScript strings are immutable and
  not zeroable, so the mitigation is to keep the secret inside the callback's
  scope rather than to claim it is erased afterwards; and
- **nothing supplies the reference half of a removal in production.**
  Configuration writing does not exist — #8 excluded it because nothing in v0.1
  sets a value — so `CredentialReferenceStorePort` has an in-memory supplier
  only. The port exists so that removal is one operation with two reported
  halves; its production supplier arrives with the configuration writer.

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
generation, through the in-memory store #2 shipped. A durable store now exists
beside it — see the persistence section below — and nothing composes the two
together yet, because the loader is not composed into a running program either.
The remaining seven kinds describe sessions, turns, model attempts, and
capability invocations, and the runtime backbone still has none of those
concepts — their first producers are
[#33](https://github.com/yogeshprasad098/falryn/issues/33) for sessions and
turns and
[#40](https://github.com/yogeshprasad098/falryn/issues/40) for model and
capability kinds. Inventing scope or scheduler event kinds to fill the gap would
create events with no consumer.

**Falryn has one database.**
[#12](https://github.com/yogeshprasad098/falryn/issues/12) adds `SqliteConnectionPort`
to `src/domain/`, its `bun:sqlite` adapter at `src/integrations/bun-sqlite.ts`,
and the owner at `src/data/sqlite-store.ts` with its migration list beside it.
The port is SQL-shaped rather than SDK-shaped: it runs a statement, reads rows,
applies a pragma, runs synchronous work inside a transaction, copies the
database, controls persistent WAL, and closes. No `Database`, `Statement`, or
driver constant crosses it.

Its verified behavior:

- one connection opens at `<state root>/falryn.sqlite` in strict mode, so a
  mis-named bound parameter is an error rather than a silent `null`, and one
  pragma set is applied in one place — `busy_timeout` from configuration,
  `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`, and an
  `integrity_check` probe;
- the registered migration list is validated at load for gaps, duplicates,
  ordering, names, and empty SQL, so a defective set is refused before it
  touches a database. Every defect in the set is reported, not only the first;
- the runner owns a bookkeeping table created outside that list, recording
  version, name, a checksum of the applied SQL, and the applied instant. Each
  migration applies inside its own `exclusive` transaction that re-reads the
  recorded version, so a second process racing the same upgrade waits its busy
  timeout and then finds the work done rather than repeating it;
- a checksum mismatch, a database recorded newer than the build, and a failed
  integrity check are each refused with both facts needed to diagnose them. A
  failed migration rolls back and leaves its version unrecorded; an interrupted
  run names the recorded version, the applied set, and the backup path. None of
  them deletes anything;
- a destructive migration takes a bounded backup with `VACUUM INTO` into the
  `state` root first. `.serialize()` is refused for that purpose, and a negative
  control proves it appears nowhere in the tree, because it materializes the
  whole database in memory;
- writes use the `immediate` transaction variant. Cancellation before `BEGIN`
  returns `cancelled` and nothing commits; cancellation after `COMMIT` reports
  itself beside the committed value rather than claiming nothing happened. A
  transaction wraps a synchronous function, so work inside one cannot `await` a
  provider, process, or user;
- close is a sequence — persistent WAL off, `wal_checkpoint(TRUNCATE)`, then a
  close that does not force statements still running — and leaves one file, so a
  leftover `-wal` is a real signal of a crashed run. It is registered as the
  first `close-storage` shutdown participant, and a close that does not finish
  before the phase deadline leaves the shutdown `uncertain`;
- `sqliteState` is registered with the ownership registry as `app-owned` with
  the `export-before-reset` posture in the `state` root. It has no
  `data.retention` entry, so durable state is measured for usage — sidecars
  included — and counted against `data.quotas.totalMaxBytes` rather than aged
  out;
- every failure is a `data` error in #5's shape except cancellation, which stays
  `cancellation`. The driver's own message reaches the developer cause through
  the runtime's single redactor and never reaches a user-facing message; and
- `data.sqlite.busyTimeoutMs` is declared in #7's registry with its unit,
  bounds, default, `user`/`environment`/`cli` scopes, and the
  `application-restart` class. Journal mode, foreign keys, and `synchronous` are
  deliberately not configurable.

The runner itself is driven by fixture migration sets, which is what covers
ordering, failure, contention, and interruption independently of the production
schema.

The durable records introduced by
[#13](https://github.com/yogeshprasad098/falryn/issues/13) add the production
schema and everything that reads and writes it:

- migration `0001` is the first production step. It creates `sessions`, `turns`, `model_attempts`,
  `invocations`, `events`, and `projection_cursors` as `STRICT` tables, plus the
  four indexes the listings below actually use. It is non-destructive, so it
  takes no backup. There is no `workspaces` table: a session carries
  `workspace_id` as an identity column with no foreign key, because the
  workspace record is owned by
  [#55](https://github.com/yogeshprasad098/falryn/issues/55) and
  `foreign_keys = ON` would otherwise block every session write;
- `EventStorePort` has exactly one durable implementation, and
  `createInMemoryEventStore` remains a test double. The database is the ordering
  and idempotency authority: expected sequence, duplicate detection, and
  identifier conflicts are all decided from stored rows inside the same
  `immediate` transaction that inserts, backed by `UNIQUE (stream_id,
  sequence)`, `UNIQUE (stream_id, idempotency_key)`, and the event-identifier
  primary key. No in-memory ledger is rehydrated at open, so a restart continues
  at the correct sequence and a second connection sees the first's committed
  events. The durable store is stricter than the double in one respect, on
  purpose: an event identifier is unique across every stream, not only within
  one;
- rejections use the four applicable `SequenceError` codes and no others;
  `ledger-capacity-exceeded` is an in-memory bound and is never emitted.
  `EventStoreError` gained one member carrying a `SqliteStoreError`, so a busy,
  full, unavailable, or closed database is not folded onto a codec or sequence
  failure;
- the 64 KiB bound is enforced before the insert, and every row read back is
  revalidated through the same codec as an event arriving from transport. A
  hand-edited row with an unknown kind, a malformed identity, a non-JSON
  payload, or an oversized payload is rejected on read with a path and an issue
  code and never the rejected value;
- typed repositories for sessions, turns, model attempts, and invocations return
  domain records under branded identities and expose no row shape. Existence is
  decided inside the write transaction, so a repeated insert reports
  `already-exists` and a completion with no record reports `not-found` rather
  than a constraint violation. A terminal outcome is stored as its kind beside
  its effect certainty, constrained by `CHECK`, and a record cannot be left
  half-terminal;
- one deterministic projection, `terminal-outcomes`, derives each turn's, model
  attempt's, and invocation's completion time and outcome from stored events
  alone — no provider, network, filesystem, or tool lookup. It is applied in
  pages of 256, and each page's cursor is written in the same transaction as the
  state it describes, so a rolled-back page moves neither. Dropping the derived
  state and its cursor and rebuilding reproduces identical state, and a cursor
  recorded under a different reducer generation triggers a rebuild rather than a
  resume; and
- `persist-outcomes` and `checkpoint-projections` each do real work.
  `persist-outcomes` stops the event store accepting appends and awaits those in
  flight; `checkpoint-projections` then brings every stream holding events up to
  its head, and does nothing for a stream whose cursor is already there. Both
  run before `close-storage`, so the truncating checkpoint meets a database with
  nothing still writing.

The artifact foundation introduced by
[#14](https://github.com/yogeshprasad098/falryn/issues/14) adds large and binary
content, stored as bytes outside SQLite and described by a durable record:

- migration `0002` creates `artifacts` as a `STRICT` table, so a real run now
  ends at schema version 2. Its `invocation_id` is nullable and is its only
  foreign key, because bytes can be ingested before any invocation claims them.
  Sensitivity, availability, origin, and encoding are `CHECK`-constrained closed
  unions, and finalized time is constrained against availability so no row can
  be half-finalized. The digest is indexed and deliberately not unique: two
  artifacts with distinct lineage may share exact bytes;
- the sensitivity vocabulary is `public`, `user-content`, `sensitive`, and
  `restricted`, and the availability vocabulary is `reserved`, `available`,
  `quarantined`, and `missing`. Both were decided by this delivery and are
  recorded in the canonical design documents;
- artifacts are reachable only through `ArtifactStorePort`, and bytes only
  through a separate narrow `BlobStorePort` that addresses them by scope and
  content digest. No filesystem path crosses either port, so no path, digest, or
  byte reaches an error, an event, or a diagnostic. Negative controls assert
  that artifact bytes are written in exactly one adapter module and that the
  store names no path type;
- ingest runs `allocate temp → stream and hash → flush and close → atomic
  finalize → commit metadata → available`. The declared byte length is enforced
  against the configured ceiling before a byte is written and against the
  observed count before anything is finalized, and the digest is verified by
  re-reading the *finalized* bytes rather than by trusting the stream;
- a digest mismatch quarantines the bytes instead of deleting them and records
  the artifact as `quarantined` beside them, so there is something to inspect
  them with. A caller-supplied expected digest that disagrees quarantines the
  same way, before anything reaches content;
- metadata is committed twice on purpose: a `reserved` row before the bytes
  move, and the move to `available` only after they verify. A run that dies
  between the two leaves a row that says exactly that, and a failed commit
  leaves finalized bytes the sweep can collect;
- exact bytes deduplicate by digest while the records keep distinct lineage;
- range reads validate their bounds and return the actual offset and length, so
  a short tail is reported as what it read. A zero-length read, a read at
  exactly the end, and an offset past the end are three distinct answers, and
  previews are bounded separately from range reads;
- cancellation is checked at every stage. Before the final commit it reports
  `cancelled`; after it, the commit stands and the cancellation is reported
  beside the committed value;
- `artifacts` is registered with the ownership registry as `app-owned` with the
  `lifecycle-aware` posture, so reset and uninstall plans name it instead of
  reporting it unregistered. Its `data.retention` entry carries a byte budget
  and no age, because durable user content is collected by reachability rather
  than by clock;
- in-flight bytes are written under a declared temporary-ingest name, so startup
  reconciliation now reports the owner of every entry it finds. Naming an owner
  is not a claim that the write finished: reconciliation still removes nothing
  and still reports `uncertain`;
- `finalize-artifacts` does real work. It stops accepting ingest, awaits what is
  in flight, and discards the temporary bytes *this run* allocated and
  abandoned — safe precisely because this run knows it abandoned them; and
- a sweep marks, rechecks, and then deletes bytes this store wrote that no
  record references, in that order, because a record can commit between the
  first answer and the deletion. Quarantined bytes with a record are kept for
  inspection, another run's in-flight bytes are reported and left alone, and
  deleted, retained, and failed stay three separate counts.

Not yet present in this area: reachability garbage collection driven by session
retention, pinning, and export dependency
([#121](https://github.com/yogeshprasad098/falryn/issues/121)); startup recovery
of interrupted writes and export foundations
([#15](https://github.com/yogeshprasad098/falryn/issues/15)); corruption and
missing-blob detection
([#120](https://github.com/yogeshprasad098/falryn/issues/120)); viewers and
rendered previews
([#117](https://github.com/yogeshprasad098/falryn/issues/117)); and the complete
typed artifact API and provenance graph
([#116](https://github.com/yogeshprasad098/falryn/issues/116)).

The startup recovery introduced by
[#319](https://github.com/yogeshprasad098/falryn/issues/319) establishes what an
earlier run left behind, and never invents a completion:

- migration `0003` creates a `STRICT` `runs` table and adds a nullable
  `artifacts.run_id`, **stamped by the artifact repository on every reserve**,
  so a real run now ends at schema version 3. A run inserts
  its row at startup and stamps a clean end during shutdown, so **a row with no
  end time is the durable trace of a run that did not close**. The added column
  is nullable by necessity — `ALTER TABLE ... ADD COLUMN` can only add one whose
  default is `NULL` — and rows written under migration `0002` predate every run,
  so there is nothing to backfill. The index on it is partial, covering only the
  reserved rows recovery reads;
- one pass runs after migrations and before any producer. Every session, turn,
  model attempt, and invocation without a completion time is therefore from a
  run that is gone, and each is completed as `uncertain` carrying `uncertain`
  effect. **None becomes `failed` and none is deleted** — failure is an
  observation, and this is the absence of one;
- an artifact an earlier run left `reserved` is resolved from its bytes rather
  than from its row: present and verifying becomes `available`, present and not
  verifying becomes `quarantined` with the bytes moved aside rather than
  deleted, and absent becomes `missing` — the availability state #14 declared
  and deliberately left uninferred. Verification re-reads and re-hashes through
  the same helper the artifact store uses, so "are these bytes intact" has one
  answer;
- **an unended run is presumed live and its bytes are never touched.** With no
  liveness probe in v0.1 this is the only rule that cannot destroy a concurrent
  Falryn's in-flight work; treating an unended run as abandoned once it is old
  enough would delete the temporary bytes of any session that outlives the
  window. The ingest path is what makes that defence real rather than nominal:
  the repository stamps the run on the row it reserves, so a reserved artifact
  whose bytes have not yet been renamed into content scope is attributable to
  the process still making it. That state is exercised through the shipped
  repository rather than by staging the column, because a column only a test
  writes is a column production never writes. In-flight bytes are discarded
  when their owning run is known to have ended, and unattributable bytes only
  when no other run is open at all — with
  no other run open, nothing on the machine is past startup, so nothing can be
  writing them — and, on top of that, only once `data.recovery.windowMs` has
  elapsed since any *other* run started, which keeps the sweep away from a
  machine that is actively cycling Falryn processes. This run's own row is
  excluded from that window: recovery runs immediately after the row is written,
  so including it would make the window unsatisfiable and the branch
  unreachable;
- a leftover `falryn.sqlite-wal` or `-shm` is probed *before* the database is
  opened, because opening it creates both, and reported as the crashed-run
  signal `reference/LOCAL-DATA.md` already documents;
- the pass is idempotent: a second one over an already-recovered database
  changes nothing and reports no repairs. Bounds on records, artifacts, blobs,
  and bytes re-read are each reported as `partial` rather than rounded off, and
  a cancelled pass claims nothing about what it did not reach; and
- `data.recovery.windowMs` is declared with its unit, bounds, default, and the
  `application-restart` class.

One limitation this slice does not close: records carry no run identity, so a
recovery pass starting while a *second* Falryn holds an open session would mark
that session's live records `uncertain`. Artifact bytes are protected against
this by run attribution; records are not, because attributing them needs a
column on four more tables. The issue's own design scopes the concurrency
guarantee to bytes and to simultaneous *startup*, which is covered; the general
case is follow-up work rather than a hidden TODO.

The export foundations introduced by
[#320](https://github.com/yogeshprasad098/falryn/issues/320) turn a selection of
durable local state into one portable, versioned, digest-verified package:

- an export declares **its own schema version**, separate from the database's. A
  package outlives the database that produced it, so one number cannot answer
  both "what shape are these rows" and "what shape is this file". A reader
  refuses a package that requires a newer one, and accepts a newer package that
  says an older reader is enough;
- the container is `falryn-export/1`: a format line, the members in the order
  the manifest declares them, the manifest itself, and a fixed-width footer
  giving the manifest's length. **The manifest is a trailer, not a header**,
  because a member's digest is known only once it has been streamed — and the
  fixed footer is what still lets a reader seek to the manifest and refuse an
  incompatible package before reading its body;
- a selection names sessions or a time range. Resolving it walks the existing
  repositories to the turns, model attempts, invocations, events, and artifacts
  it reaches. Sessions, events, artifacts, members, and artifact bytes are all
  bounded **before the writer is touched**. The package total is enforced as it
  is written, because the records member's size is not knowable until it has
  been generated — a selection carrying no artifacts at all still produces a
  member that grows with every session, turn, and event it names. Either way a
  selection above a bound is an error and no package appears;
- events are read a page at a time until the stream is exhausted, and a stream
  past the declared bound is refused. A single bounded read would have exported
  a stream's first page and dropped the rest without saying so, which is the one
  thing the omission rule exists to prevent;
- an artifact reached but not carried appears in the manifest as a declared
  omission with a reason: `restricted-sensitivity`, `sensitive-not-selected`,
  `bytes-missing`, or `bytes-quarantined`. A package that silently lacks
  something is a package nobody can audit;
- **`restricted` artifacts never leave the machine, whatever the selection
  asks.** The check runs before the sensitivity opt-in is consulted, so a
  selection cannot opt back into content the vocabulary #14 decided says stays.
  Credentials are not excluded by a rule but by reachability: nothing in the
  export path names the credential vocabulary at all, and a negative control
  asserts that absence;
- the writer streams: free space and the ceiling are checked first, artifact
  bytes are copied in chunks and **re-hashed as they go**, and a digest that
  changed between inventory and write is reported rather than written around.
  The package is staged under a visible `.partial` name beside its destination
  and published by one atomic rename, so a failed or cancelled export leaves
  nothing where a finished one would be;
- a verification pass reads a finished package, parses its manifest, and
  re-hashes every member against what was declared — without importing it.
  That is what makes an export claim checkable in a release where nothing can
  import one, and it catches a tampered member, a truncated package, and a file
  that is not a Falryn export at all; and
- the `exports` ownership class is registered with the `never-implicit` posture,
  retiring another *unregistered* row, and `data.exports.maxBytes` is declared
  with its unit, bounds, default, and the `next-operation` class.

Two limitations this slice carries deliberately. **No producer of sessions or
artifacts exists**, so on a real run an export has nothing to export and an
empty selection is a reported fact rather than an edge case; the tests stage
records through the repositories and artifacts through the artifact store.
And the export service is **not composed** into `src/main.ts` — only its
ownership class is registered. Constructing a writer that no run can call would
add a dead object rather than exercised behavior, so the honest statement is
that nothing in a real run writes a package. Redaction, import, replay, and fork
are owned by [#118](https://github.com/yogeshprasad098/falryn/issues/118) and
[#119](https://github.com/yogeshprasad098/falryn/issues/119).

The seams closed by
[#323](https://github.com/yogeshprasad098/falryn/issues/323) complete two of
those foundations:

- **an export names the schema families it carries.** The manifest's
  `schemaFamilies` list declares each family with the version it was written at,
  built from `RUNTIME_EVENT_SCHEMA_FAMILY` rather than a second literal, so the
  package version answers "what shape is this file" and the family list answers
  "what is inside it". Every package this build writes declares
  `falryn.runtime-event` at `schemaVersion` 1, including one whose selection
  produced no events — the records member is that family's encoding by
  construction. The parser refuses an absent, empty, unknown, repeated,
  non-object, or non-positive-versioned entry with a path and an issue code and
  never the rejected value, so a development-tree package written before the
  field existed is refused as `malformed-manifest` rather than leniently
  accepted. `EXPORT_SCHEMA_VERSION` stays 1 and the container stays
  `falryn-export/1`, because nothing has been released for a reader to negotiate
  with; and
- **the database file is owner-only.** `src/integrations/bun-sqlite.ts` creates
  the path exclusively at `0600` and sets the mode explicitly before SQLite
  opens it, so there is no world-readable window and SQLite derives owner-only
  `-wal` and `-shm` files from it. The pre-create runs only when creation is
  permitted, and any errno other than `EEXIST` is left to the one classification
  table the adapter already owns rather than given a second spelling. A
  pre-migration `VACUUM INTO` backup is set to `0600` too, and a backup that
  could not be made private fails the backup. An existing database an earlier
  build left at `0644` is opened and left alone — the same diagnose-rather-than-
  adjust rule the roots follow. Observed on a real compiled run against an
  isolated state root, which is the only place the process umask applies.

The integrated persistence walk added by
[#325](https://github.com/yogeshprasad098/falryn/issues/325) demonstrates the
whole chain at one source revision rather than leaving it inferred from the
per-seam files. `src/data/integrated-persistence.test.ts` holds **one** test — it
opens a fresh temporary state root, asserts the store created the database and
applied every production migration, records a session, a turn, a model attempt,
and an invocation through the typed repositories, appends the eight ordered
events, ingests an artifact through the artifact store's declared boundary so its
bytes are finalized and its metadata committed rather than inserted directly,
advances the projection cursor, then closes the store and opens the same root
again. The second process asserts it created nothing and applied no migration,
and reads back the session view with its turn, model attempt, invocation, and the
events **in order**, the artifact's committed metadata, its bytes through the
same host blob adapter, and the cursor at the sequence the events actually
reached along with the derived outcomes it claims to describe.

Every owner in it is the real one — the store, the repositories, the durable
event store, the artifact store over the host blob adapter and the real SHA-256
hasher, and the projection runner — because a double anywhere would make it a
sixth unit file rather than the integration proof. It changes no production
source. Removing a seam was demonstrated to fail it: dropping any of the four
record inserts, reversing the event order, skipping the ingest, skipping the
projection advance, or reopening a different root each turn the test red.

The persistence resource measurement added by
[#326](https://github.com/yogeshprasad098/falryn/issues/326) turns "resource
behavior is verified" into numbers. `src/data/measurement.test.ts` is gated
behind `FALRYN_MEASURE=1`, runs from `bun run measure`, is part of neither `bun
run check` nor `bun run ci`, asserts no timing threshold, and changes no
production source. What it does assert is that the work it measured happened —
the rows are counted, the digests are distinct, the read-back bytes are the ones
written, the schema reached version 3 — so a run that measured nothing cannot
report zero and look fast. Every owner in it is the real one, and the blob store
is `createHostBlobStore` against a real temporary root rather than the in-memory
double, because a throughput number taken against memory measures RAM.

Observed on 2026-08-01, on macOS 26.6 (`darwin arm64 25.6.0`), Apple M3, 8
logical cores, 16 GiB RAM, Bun 1.3.14. The declared dataset is 50 sessions of 5
turns — each turn carrying a model attempt, an invocation, and 4 events, so 1,800
rows of which 1,000 are events — plus 8 MiB artifacts and 64 KiB range reads.

| Quantity | Against | State | Result |
| --- | --- | --- | --- |
| transaction latency | one `SqliteStorePort.write` `immediate` transaction, via `turns.insert` | warm | 250 samples; median 0.027 ms, p95 0.039 ms, min 0.024 ms, max 2.639 ms |
| busy wait | a second process holding `BEGIN IMMEDIATE` for 300 ms, 5,000 ms busy timeout | warm | 5 samples; median 301.911 ms, p95 302.290 ms; refused 0/5 |
| refusal rate | the same contention held 2,000 ms against a 300 ms busy timeout | warm | 5 samples; refused 5/5 as `busy` with effect `none`; median wait 301.363 ms |
| migration time | `openSqliteStore` bringing a fresh database to schema version 3 | cold | 5 samples on 5 fresh roots; median 2.283 ms, p95 5.602 ms |
| database size | `falryn.sqlite` after the dataset is written and closed | cold | 868,352 bytes (0.83 MiB) for 1,800 rows, no `-wal` or `-shm` |
| artifact throughput | `ingest` through atomic finalize over the host blob adapter | cold and warm | 3 samples of 8 MiB; median 13.337 ms ≈ 600 MiB/s, max 20.757 ms; includes the SHA-256 pass |
| range-read latency | `readRange` over the host blob adapter | warm | 64 samples of 64 KiB at unaligned offsets; median 0.058 ms, p95 0.080 ms, max 0.437 ms |

Five limitations belong with those numbers:

- **Falryn performs no application-level retry.** `src/data/sqlite-store.ts`
  reports `busy` and returns. `evaluateRetry` and `DEFAULT_RETRY_BACKOFF` in
  `src/domain/retry.ts` are an application-layer policy reached only from
  `src/application/recovery.ts`; nothing in `src/data/` calls them, and no
  persistence path routes a `busy` through them. The waiting measured above happens
  inside SQLite's own busy handler, in C, where no counter is reachable. "Busy
  retries" is therefore recorded as busy wait and refusal rate; a retry counter
  would have been product behavior invented inside a measurement.
- **There is no regression gate and no CI job.** These are one observation, not
  a threshold. Thresholds, regression detection, and a performance job are the
  benchmark harness, which [#28](https://github.com/yogeshprasad098/falryn/issues/28)
  defers and none of whose children (#29, #30, #31, #32) owns. That gap has no
  owner today and is recorded here rather than closed by inventing a sibling.
- **One platform.** macOS is the only qualified target; measuring on it
  qualifies no other, and a second platform is
  [#220](https://github.com/yogeshprasad098/falryn/issues/220).
- **Nothing was tuned.** This issue measures. A number that turns out to be bad
  is a new issue, not a silent rewrite.
- **Ungated, `bun test` reports five skipped tests from this module** rather than
  the single one the plan anticipated: Bun records each test inside a false
  `describe.if` as skipped, and the module keeps one explicitly skipped test that
  names `bun run measure`. The measurement is visibly absent either way, which is
  the point.

The process boundary introduced by
[#20](https://github.com/yogeshprasad098/falryn/issues/20) adds
`OutputStreamPort`, `InputStreamPort`, and the terminal capability facts to
`src/domain/terminal.ts`; the one Bun-backed handle adapter to
`src/integrations/host-terminal.ts`; and a new `src/cli/` area, behind
`src/cli/index.ts`, owning the numeric exit table and the stdout/stderr
contract. `src/main.ts` sets its exit status through that table.

Its verified behavior:

- **a write is never assumed to have landed.** `write` reports what the stream
  accepted and `flush` reports what left the process, with the bytes still
  unconfirmed carried in the report. A flush that could not complete turns the
  run's outcome `uncertain` rather than letting it claim success over output
  nobody received;
- **a stream releases what it holds on the host.** The adapter must attach an
  error listener to observe a departed reader, and a standard handle is one
  object for the whole process, so the port carries a `dispose` for the same
  reason `SignalPort` returns an `Unsubscribe`. Releasing twice removes nothing
  extra, and releasing one handle does not detach the other;
- **stdout carries the selected result format and nothing else**, including
  when the human format is the selected result format. Progress, warnings, and
  notices go to stderr. The rule is a negative control over the source tree,
  not a convention: outside `src/integrations/host-terminal.ts` nothing names a
  host handle, nothing anywhere calls a `console` method, and every stdout line
  of every scenario is parsed back on a real run;
- **the exit table is frozen at thirteen codes** — 0, 1, 2, 3, 4, 5, 6, 7, 8,
  9, 70, 124, and 130 — resolved from the terminal outcome, the error's
  `exitCategory`, and its `category` together, because four exit categories
  cannot distinguish thirteen outcomes. 126, 127, and 128 are never assigned;
  the shell owns them;
- **effect certainty outranks the failure.** A cancelled operation that already
  changed something exits 8, not 130 — the reason effect is carried separately
  from outcome. An error whose effect is less certain than its outcome's decides
  the code;
- **an unrecognized error resolves to the internal code** and never to a
  category-specific one it was not entitled to;
- **four of the thirteen codes are declared and unreachable today** — 5, 6, 7,
  and 9. Which nine a v0.1 build can produce is derived from
  `RUNTIME_EMITTED_CATEGORIES` rather than listed, following that constant's own
  precedent, and both halves of the partition are asserted against real
  processes;
- **a closed reader is a normal end.** Writing stops, stderr is not used to
  complain about it, and the run keeps the code its work earned. `EPIPE`
  reaching the default handler would end the process with a stack trace over an
  ordinary `| head -1`;
- **stdin never blocks when nothing is attached.** A TTY handle resolves
  immediately as `not-connected` rather than being read, `</dev/null` reads as
  `empty`, and the two stay distinguishable. An over-bound read is reported as
  invalid input rather than truncated, and bytes that are not the declared
  encoding are reported as such;
- **capability is a fact about this process**, derived per handle through
  `EnvironmentPort` from `NO_COLOR`, `FORCE_COLOR`, `TERM`, `COLORTERM`, and
  TTY-ness. A handle that reports no size has none; a non-TTY is never treated
  as a narrow terminal. The `--color` option that overrides this is #17's, and
  it overrides a fact rather than replacing the computation; and
- **the exit is taken by setting `process.exitCode`.** No governed source calls
  `process.exit()`, which would abandon the drain the flush contract exists to
  complete.

The boundary is composed and exercised, not a shipped command surface. No
command exists yet, so the table, the handle split, the broken pipe, the
interrupt, and the stdin contract are driven through `src/cli/probe-fixtures.ts`
— a scenario harness that ships in no build — spawned in both source and
compiled mode by `src/cli/process-boundary.test.ts`. `src/main.ts` is the only
product path through the table today, and it writes nothing to either handle.

The command tree introduced by
[#17](https://github.com/yogeshprasad098/falryn/issues/17) makes `falryn` a real
executable. It adds the yargs tree, global options, dispatch, the
`CommandResult` contract, a service factory, and the `config` and `doctor`
commands to `src/cli/`, plus a read-only `probeStorage` to `src/data/`.
`src/main.ts` is now the CLI entry: it composes #20's streams, dispatches one
invocation, and exits through #20's table.

Its verified behavior:

- **yargs has no authority over the process.** It does not print and does not
  exit: `help(false)`, `version(false)`, `exitProcess(false)`, help pulled as a
  string, `--help` and `--version` as ordinary booleans, and a fail handler
  that raises. The raise is load-bearing — with `exitProcess(false)` yargs
  calls the handler and then resolves normally, so a handler that only recorded
  the failure let an invalid invocation continue, which the packaging probe
  reproduced;
- **the compiled packaging probe passed**, and was run before anything was
  built on yargs. A standalone executable produced identical help to source
  mode, produced version output, and reported unknown flags, unknown commands,
  and out-of-choice values; non-English locales changed and failed nothing.
  `@types/yargs` type-checks clean under `skipLibCheck: false` and
  `exactOptionalPropertyTypes`, so no accommodation was added;
- **only `config` and `doctor` are declared.** Every other group named in
  `reference/CLI.md` is absent from the tree, asserted by a control, because
  parsing one would advertise it in `--help`;
- **invalid usage never reaches application work.** Unknown flags, unknown
  commands and subcommands, wrong-typed values, out-of-range timeouts, an
  illegal profile name, a workspace root no resolution could rescue, and every
  refused option combination exit `2` on stderr with an empty stdout;
- **help and version initialize nothing.** No provider, no database, no
  workspace scan, no integration, and no directory created. Proven by running
  every such path against a service factory that throws if constructed — the
  reason the factory is a function — with the positive case asserted too, so
  the control tests a boundary rather than a dead branch;
- **`--verbose` and `--quiet` are the only global options that map to a
  declared configuration key.** They set `diagnostics.level` through the
  existing `cli-override` layer; the CLI supplies a key-path map and writes no
  precedence, coercion, or range rule. `--workspace` and `--profile` are loader
  inputs, and `--format`, `--color`, `--non-interactive`, and `--timeout` are
  facts about the invocation that no declared key describes;
- **a relative `--workspace` resolves against the current directory.**
  `./site` and `../sibling` name the directories a caller means, through the
  domain's own resolution and normalization rather than a rule written in the
  CLI. A root that no base could rescue is invalid usage rather than a silently
  absent project layer;
- **`config show`, `validate`, and `path` run over the existing loader**, with
  the runtime redactor injected rather than reimplemented and the generation
  event appended to an in-memory store, so inspecting settings never writes to
  a user's database. An unknown override key refuses the load rather than being
  ignored, and since
  [#344](https://github.com/yogeshprasad098/falryn/issues/344) a source that
  exists and could not be read is reported rather than silently skipped, which
  is described below;
- **`doctor` describes without creating.** It names each root and the database
  path, and reads the database with `create: false` — so asking whether one
  exists never creates it. A fresh root reports `absent`; after a bootstrap it
  reports the schema version it carries. Since
  [#342](https://github.com/yogeshprasad098/falryn/issues/342) it also probes
  each root's *viability*, which is described below;
- **`--version` names the build**: version, Bun, platform, architecture, and
  whether the run is source or compiled, detected from the `$bunfs` module root
  a standalone executable mounts; and
- **the CLI area restates nothing it consumes.** Controls assert it authors no
  SQL, imports no database driver, touches no filesystem module directly,
  declares one parser, and writes no second precedence, redaction, or
  profile-name rule.

The human and quiet projections introduced by
[#18](https://github.com/yogeshprasad098/falryn/issues/18) render that result.
They add `src/cli/render-human.ts` — one pure function from a `CommandResult`
plus resolved terminal facts to text — `src/domain/text-display.ts` for display
width, wrapping, shortening, and sanitization, and a `symbols` capability fact
to `src/domain/terminal.ts`. `dispatch` now switches on the selected format.

Its verified behavior:

- **the renderer returns two texts, and `dispatch` routes each to the handle
  that owns it.** The payload rendering is the result; the status line,
  warnings, declared omissions, truncation notices, and rendered errors are
  diagnostics — in human mode too, so `falryn config show > file` produces a
  file containing the configuration and nothing else;
- **every terminal outcome and every effect certainty renders distinguishably**,
  with the certainty as its own clause rather than folded into the outcome word.
  "Cancelled" and "cancelled, and something may have changed" are different
  sentences, and the requested intent is rendered beside the observed effect;
- **nothing is shortened silently.** A bounded list reports how many it dropped,
  a shortened value is counted and reported once, and each names a route this
  build honours: `--verbose` where raising the renderer's own bound would
  actually help, and a wider terminal where the width is what cut the value.
  What the *command* declared it summarized or omitted is rendered as the
  command's own statement, distinct from anything the renderer did;
- **colour is never the only cue.** Every state carries a word; stripping the
  escape sequences from a coloured rendering reproduces the uncoloured one byte
  for byte. No ANSI byte appears when the resolved level is `none`, when the
  handle is not a terminal, or in any format that is not `human`, and a
  source-tree control keeps the escape sequences in this one module;
- **an ASCII repertoire carries the same meaning as the Unicode form.**
  `symbols` is derived once, beside `colorLevelFor`, from `TERM=dumb` and the
  `LC_ALL`/`LC_CTYPE`/`LANG` charset, and it is independent of colour in both
  directions;
- **untrusted text is rendered as data.** Control characters, C1 controls, and
  lone surrogates are replaced with a visible ASCII escape before a value
  reaches a line, so a configuration value carrying an escape sequence renders
  as those characters and cannot forge a line, move the cursor, or repaint the
  screen. Width is display width, so a wide or combining character is measured
  by the cells it occupies rather than by its length;
- **`--format quiet` emits only the primary result**: one `key=value` line per
  set key for `config show`, one path per line for `config path`, and nothing at
  all for `config validate` and `doctor`, whose verdict is the exit status and
  whose findings go to stderr. It is unbounded, uncoloured, and unlabelled — a
  shortened primary result would be a different answer; and
- **the renderer is pure.** A control asserts it reaches no stream, no clock,
  and no filesystem, so a rendering is a function of the result it was given and
  the terminal facts it was handed. A property check confirms it never changes
  the outcome kind or the effect certainty it was given.

Only `config` and `doctor` produce results in v0.1, so the renderer is exercised
against those two payloads plus fixtures covering the outcome, certainty, and
failure matrix. It has not been proven against a rich command surface.

The machine projections introduced by
[#19](https://github.com/yogeshprasad098/falryn/issues/19) complete the four
declared output contracts. They add `src/cli/schema.ts` — the `falryn.cli`
schema family, its encoder, and its reader policy — plus `src/cli/render-json.ts`
and `src/cli/render-jsonl.ts`, and expose the run's in-memory event store on
`Services` so a JSON Lines run reports the lifecycle it actually produced.

Its verified behavior:

- **`falryn.cli` is the third declared schema family**, beside
  `falryn.runtime-event` and `falryn.configuration`, with a version and a
  minimum-reader version following the pattern those two established. A source
  control asserts it is declared in exactly one module;
- **a reader can refuse a record without parsing its body.** Family, version,
  minimum reader version, kind, and a `terminal` flag are all in the envelope;
- **an unknown *terminal* kind is refused and an unknown non-terminal kind is
  tolerated.** A terminal record this build cannot read leaves the run's
  outcome unknown, and unknown is never read as success. An added optional
  field is tolerated, and a record whose `minimumReaderSchemaVersion` exceeds
  this build's is refused with the version it would need;
- **JSON emits exactly one bounded terminal record.** A result that will not
  encode becomes a `refusal` record — still terminal, so a consumer never waits
  for an answer that is not coming — carrying a code and the bytes it would
  have taken. It is never a trimmed object, which would parse cleanly and lie;
- **JSON Lines emits ordered lifecycle records and exactly one terminal
  record.** Sequences are monotonic and contiguous, and the reader reports a
  gap and a stream that ended without a terminal record. Lifecycle records
  carry the wire form `toWireEvent` already produces, so this format invents no
  second event vocabulary — asserted by a control;
- **encoding is deterministic and refuses what JSON would corrupt.** Object
  keys are sorted, so equal results produce equal bytes however they were
  assembled; a non-finite or unsafe-integer number, a lone surrogate, and a
  value with no JSON form are each refused rather than written as `null` or as
  a replacement character a consumer would read as content;
- **a reader that leaves gets whole records.** Writing stops between lines when
  the stream reports the reader gone, so `--format jsonl | head -1` yields one
  complete record, no partial one, and the run neither claims a terminal record
  it did not deliver nor changes the code its work earned; and
- **neither format contains ANSI, diagnostics, or a secret.** Controls run both
  formats under a forced-colour environment and over a configuration file
  containing token-shaped text, and assert stdout holds records only.

Both formats are exercised from the standalone executable as well as from
source. The pinned v0.1 record fixture is byte-checked, so a change that would
break a deployed consumer fails a test rather than a pipeline.

Shell completion is deferred rather than hand-written.

`doctor` reports whether each data root can actually hold data, which
[#342](https://github.com/yogeshprasad098/falryn/issues/342) added after
verifying #16's "unusable state root" scenario found it reporting a state root
that was a regular file as healthy. It adds `inspectRoots` to `src/data/roots.ts`
and to `LocalDataService`, and a `RootViability` vocabulary to
`src/domain/local-data.ts`.

Its verified behavior:

- **viability is four states, not a boolean.** `ready`, `absent`, `blocked`,
  and `unknown`. A root that does not exist yet is the normal first-run state
  and is not a fault; a root that is a regular file is. Merging those two is
  what let a machine that could not persist anything be reported as healthy;
- **the probe creates nothing.** It is the read-only sibling of `prepareRoots`
  and runs the same sequence — stat, kind, writability, permission bits — with
  creation removed and the missing-path branch answered from the nearest
  existing ancestor. `blocked` covers `not-a-directory`, `not-writable`,
  `parent-not-writable`, and `dangling-symlink`; `insecure-permissions` stays
  an advisory finding on a root that works;
- **a symlink is judged by its target.** `stat` does not follow a final
  symlink, so a root that is a symlink to a real directory would otherwise read
  as `not-a-directory`. `prepareRoots` still has that blind spot; changing
  preparation is a separate outcome;
- **a probe that did not complete is `unknown`, never `ready`.** A filesystem
  error other than absence, and cancellation, both report what the boundary
  said rather than a verdict the probe did not reach;
- **`resolved` and `viability` are separate payload fields** and each means
  what it says. The field they replaced was named `usable` and measured only
  whether the layout produced a path;
- **a blocking finding reaches the exit status.** A `blocked` or `unknown`
  root, an unresolved root, or storage that could not be determined makes
  `doctor` exit `1`; a refused override, an unregistered ownership class, an
  `absent` root, wide permissions, and an unexpected schema version stay at
  `0`. `reference/CLI.md` makes a diagnostic's verdict its exit status, and an
  unconditional `0` left that verdict carried by nothing;
- **storage is `undetermined` rather than `absent` when the state root cannot
  be reached.** `probeStorage` maps every `cannot-open` to `absent`, which is
  right for a reachable root and wrong for a path that is a regular file;
  `doctor` composes the two facts rather than teaching the probe a distinction
  it cannot draw. The probe itself is unchanged; and
- **`doctor` still creates nothing**, proven by its own control over a blocked,
  an absent, and a ready root rather than by the help-path control, which never
  covered it.

The finding reaches all four output contracts. The machine payload changed
shape: `usable` is gone and `resolved`, `viability`, and `blocked` are new. No
`CLI_SCHEMA_VERSION` bump was taken, because v0.1 payloads are not published and
the family declares no compatibility promise yet.

`config validate` and `config show` report a configuration source that exists
and could not be read, which
[#344](https://github.com/yogeshprasad098/falryn/issues/344) added after
verifying #16's "unreadable configuration" scenario found `config validate`
calling a configuration valid when the only file it had was at mode `000`. The
loader is unchanged — it already recorded the outcome and skipped the source —
so the change is a `UNREAD_SOURCE_OUTCOMES` vocabulary and `isUnreadSource` in
`src/domain/configuration-source.ts`, `fromUnreadConfigurationSource(s)` in
`src/application/error-translation.ts`, one payload field, and the rendering
that reads it.

Its verified behavior:

- **three outcomes are findings and two are not.** `unreadable`, `oversized`,
  and `malformed-encoding` each mean a document exists at a path the user chose
  and the configuration in effect is not the one they wrote. `absent` and
  `empty` stay silent: a file that is not there says nothing, and an empty file
  is what `> falryn.jsonc` deliberately leaves;
- **the outcomes stay distinguishable.** A permission, a file size, and an
  encoding are three different repairs, and each is named as itself rather than
  collapsed into "could not be read";
- **an unread source is blocking for `validate` and advisory for `show`.**
  `validate` reports a `configuration` failure and exits `3` — the same code a
  malformed document produces, because both mean the effective configuration is
  not the authored one. `show` exits `0`: the values it displayed did load, and
  displaying them is its purpose;
- **`valid` still answers only its own question.** It reports whether an issue
  blocks use of the configuration that loaded. Whether every declared source was
  read is the separate `unreadSources` field, so a mistyped key and an
  unopenable file stay tellable apart;
- **the finding names the source and never the document.** The layer, the
  outcome, and the path bounded by `sourceLabel`. The read produced no bytes in
  the `unreadable` and `oversized` cases, and the `malformed-encoding` case is
  the one whose bytes must not be echoed — asserted by a control that puts
  token-shaped content in a file that is then refused at the boundary; and
- **the finding reaches all four output contracts**: stderr in human and quiet,
  the payload in JSON and JSON Lines, with stdout still carrying only the
  configuration under `config show`.

A load refused for bad content keeps its previous behavior and exit status, and
carries its unread sources alongside the issues rather than instead of them. The
`config.validate` payload gained `unreadSources`, which is additive under the
reader policy `src/cli/schema.ts` states; no `CLI_SCHEMA_VERSION` bump was taken,
for the same reason #342 took none.

The matrix is exercised over the in-memory `FileSystemPort` double, so what a
directory-in-place, an oversized document, and a mis-encoded one each produce
does not depend on what the running user is permitted to do; one real-disk check
over a mode `000` file covers the boundary itself, and is skipped when the suite
runs as root.

An interrupt and `--timeout` reach the command that is running, which
[#345](https://github.com/yogeshprasad098/falryn/issues/345) added after
verifying #16's "SIGINT" and "deadline expiry" scenarios found `--timeout`
parsed, range-checked, and then dropped, and `dispatch` taking no signal at all.
It adds `src/cli/invocation-scope.ts` — the scope one invocation runs under —
one input on `DispatchOptions`, and the entry composition both `src/main.ts` and
the probe harness now call.

Its verified behavior:

- **the CLI writes no cancellation model.** The deadline, its inheritance rule,
  the scope tree, the escalation policy, and the mapping from a stopped scope to
  a terminal outcome all stay where they were. What this area adds is *when to
  look*: deadline expiry is polled by design, so the surface that owns waiting
  decides when to poll;
- **`--timeout` is the invocation scope's deadline.** It is requested rather
  than set, so `derive` caps it by whatever the parent carried and a caller can
  never enlarge a limit it inherited. Expiry produces `timed-out` and exit
  `124`; a deadline the run meets changes neither its output nor its status;
- **an interrupt cancels the invocation rather than killing the process.**
  `SIGINT` reaches the real signal adapter, the policy cancels the root scope,
  and cancellation travels down to the invocation derived under it. A run that
  changed nothing exits `130`;
- **effect certainty still outranks the outcome.** An interrupted run that had
  already recorded a partial effect reports `uncertain` and exits `8`, and its
  record's own `effect.observed` agrees with it rather than claiming a
  read-only run observed nothing;
- **exactly one terminal record survives, in all four contracts.** A stopped
  invocation emits a record with a null payload — the command never answered —
  so a consumer waiting on a terminal record gets one instead of a stream that
  stops. Under `--format quiet` stdout stays empty and the verdict is the exit
  status;
- **nothing is killed and nothing is left armed.** The work is abandoned rather
  than aborted: it holds no lock and writes nothing after the invocation stops.
  The deadline wait ends as soon as the race is decided, so a run given the
  maximum `--timeout` does not sit on a day-long timer after it finishes; and
- **the exit is still taken by setting `process.exitCode`.** A cancelled run
  flushes what it wrote, and the existing control that no governed source calls
  `process.exit()` continues to pass.

Both paths are exercised on real processes in source and compiled mode. The
probe harness gained `dispatch-run`, `dispatch-timeout`, `dispatch-interrupt`,
and `dispatch-interrupt-partial`, which run the real command tree, command,
projections, and exit resolution, and replace only the filesystem the command
reads with one that holds until the invocation stops — because `config` and
`doctor` finish in roughly 50 ms, which is too fast to race an interrupt
against reliably.

`--non-interactive` is still carried without a consumer, and is vacuously
honoured: nothing in this build prompts, and a run with no stdin attached
answers rather than blocking, which is asserted rather than assumed.

One limitation stands: an interrupt that arrives before the entry has installed
its signal handler — roughly the first 30 ms of process startup, before any
Falryn code runs — terminates the process by the signal's default disposition.
No handler can be installed earlier than the runtime that would install it.

The compiled check covers the bootstrap through its own fixture entry. The bare
invocation is the command tree now, so `src/main-fixtures.ts` — an entry that
ships in no build and is compiled by the check that needs it, the pattern
`src/cli/probe-fixtures.ts` established — calls `main()` inside a standalone
executable. What that asserts is unchanged from before #17: every product table
present and the recorded schema version equal to `PRODUCT_SCHEMA_VERSION`, in a
database a compiled binary created and migrated.

`src/main.ts` composes the cancellation lifecycle and the local data foundation,
so the compiled executable includes the domain, application, data, and
integration layers and the real process-signal, filesystem, `bun:sqlite`, blob,
and SHA-256 adapters. It resolves roots, registers `sqliteState`, `artifacts`,
and `exports`, prepares the `state` root, probes for crash signals, opens and
migrates the database, records this run, runs startup recovery, constructs the
durable event store, its projection runner, and the artifact store, and
registers the `finalize-artifacts`, `persist-outcomes`,
`checkpoint-projections`, and `close-storage` participants — the run's clean
end among them, in `persist-outcomes` rather than `close-storage`, because
participants inside one phase run concurrently. There is no producer yet, so a
real run writes no session, turn, event, or artifact — and neither the
`artifacts` nor the `temporaryIngest` root is created, because the blob adapter
creates what it needs when it needs it. What a real run exercises is the schema,
all three migrations, the recovery pass, and the four shutdown phases.

Observed on 2026-08-02:

```text
bun run check    PASS  (Biome, tsc --noEmit, and bun test)
bun run build    PASS  (Bun standalone executable compiled to dist/falryn)
bun run ci       PASS  (quality, tsc --noEmit, build, then bun test)
```

The compiled file is now a runnable CLI rather than a bootstrap: `dist/falryn`
answers `--help`, `--version`, `config`, and `doctor`, and reports its own
compiled mode.

`bun run measure`, the gated persistence resource measurement, was last
observed passing on macOS on 2026-08-01 and is unaffected by the process
boundary.

`bun run ci` now builds before it tests, so `src/main.compiled.test.ts` runs
against a real `dist/falryn`: the standalone executable opens, migrates, and
closes a database under a temporary state root, leaves one file, carries its
migration bookkeeping and every product table into the binary at schema version
3, creates that database owner-only under the process umask, and reopens the
same database on a second run, and writes nothing to stdout or stderr while
exiting through the CLI table. Without a build the check reports itself as
skipped rather than passing on an executable that does not exist.

`src/cli/process-boundary.test.ts` is the second automated compiled check, and
it runs under `bun run check` because it compiles what it needs itself: it
builds the scenario harness once with `bun build --compile` into a temporary
directory and then spawns it for every assertion, in source mode and compiled
mode alike. That is what proves `src/cli/` survives packaging rather than only
working under the interpreter. A build failure there is reported as a failing
test rather than as a skipped one.

A run now exits as soon as its work is done. It previously lingered for one full
shutdown phase grace: each phase armed a deadline wait through `ClockPort` and,
when its participants finished first, the losing wait stayed armed — `Promise.race`
settles but does not cancel — so the host kept the process alive for a timer
whose answer was already known. The coordinator now releases that wait the moment
the race is decided, by completion, deadline, or escalation. `src/main.test.ts`
measures the latency on a real spawned process rather than trusting the report,
which had always claimed every phase finished in milliseconds.

No module or test count is recorded here. Re-running these commands re-proves
that they pass, but it re-proves no count, so a count decays silently between
runs — one did so by mis-transcription and one by an ordinary sibling delivery,
which is why neither is recorded now. Exact output belongs to the pull request
that observed it, which is dated by its own merge and is never re-read as a
current claim.

A separate compiled probe confirmed that root resolution produces byte-identical
output in source mode and in a Bun standalone executable, both for platform
defaults and for an environment override. That probe is not part of `bun run
check`, but root resolution is no longer unexercised in a real run:
`src/main.ts` now resolves roots and prepares the `state` root before it opens
the database, and the compiled smoke check drives that path through
`FALRYN_STATE_DIR`.

A separate compiled probe confirmed the keychain adapter on macOS 26.6, observed
manually on 2026-08-01 and not part of `bun run check`. Against a temporary
generic-password item created and then deleted for the probe, a Bun standalone
executable resolved the reference through the real `/usr/bin/security`, reported
`present` health, and handed the callback a secret of the expected length; the
same probe run in source mode produced identical output. A locator with no
keychain entry reported `missing` from exit status 44 in both modes, and a
lookup after the item was deleted reported 44 again. Nothing in the probe
printed a secret. `src/main.ts` composes no credential resolver, so nothing in the
shipped bootstrap reaches a keychain.

React and OpenTUI are pinned and their packaging is proven, delivered by
[#22](https://github.com/yogeshprasad098/falryn/issues/22). `react` is `19.2.8`
and `@opentui/core`, `@opentui/react`, and `@opentui/keymap` are all `0.4.5` —
one version across the three, because they are released together. The lockfile
carries every platform's optional native package and resolves
`@opentui/core-darwin-arm64` for this host; a multi-target release build will
need `bun install --os="*" --cpu="*"` and, on Linux, `process.env.OPENTUI_LIBC`
defined at build time so only one libc branch is embedded.

`tsconfig.json` gained `jsxImportSource: "@opentui/react"` and nothing else.
`skipLibCheck` is still `false`, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` are still on, and `lib` is still `["ESNext"]` — the
OpenTUI React documentation recommends adding `DOM`, and it is not required;
adding it would have put browser globals in scope for every module in `src/`.
Two upstream declaration files do not type-check under `skipLibCheck: false`,
and both are accommodated by a type-only Bun patch in `patches/` rather than by
loosening a compiler option: `@opentui/core` narrows `emit` in a way its base
`EventEmitter` does not permit, and `@opentui/react` extends
`React.JSX.IntrinsicElements` while redeclaring `a`, `span`, `input`, and the
other names it shares with the DOM. The second patch drops the DOM intrinsics
from the JSX namespace entirely, so `<div>` in a terminal application is now a
type error rather than an accepted element. Both patches are pinned to `0.4.5`
and fail loudly on an upgrade, which is when they should be retried.

The packaging probe passed, and was run before anything was built on OpenTUI. A
`bun build --compile` artifact created a real `CliRenderer`, mounted a React
tree, rendered a frame with a drawn border, and highlighted TypeScript through
Tree-sitter — proving the native Zig library, the parser worker, the default
grammar, and the Tree-sitter WASM all resolved from inside the executable with
no `OTUI_ASSET_ROOT` set. `src/tui/probe.test.tsx` makes every assertion twice,
in source mode and against an artifact it compiles itself, and reports itself
skipped rather than passed when that artifact could not be built.
`src/tui/probe-fixtures.tsx` is the harness; it ships in no build and is held to
the process boundary's rules, which is why `src/cli-boundaries.test.ts` now
scans `.tsx` as well as `.ts`.

Four facts were recorded from observed behavior for the shell to design against.
`screenMode: "split-footer"` works. Its `externalOutputMode: "capture-stdout"`
intercepts the same handle `src/cli/streams.ts` writes results through, so a
line a command emits while a footer renderer is up lands in the renderer's
scrollback queue instead of reaching the consumer — a shell wanting both has to
route machine output around the renderer or leave capture off; the interception
is undone by `destroy()`. `exitOnCtrlC: false` with `exitSignals: []` installs
no `SIGINT` or `SIGTERM` listener at all, measured beside a default renderer
that installs one of each, so signal handling stays entirely with
`src/cli/invocation-scope.ts`. `createCliRenderer` itself costs about 4 ms in
both modes; the compiled *process* starts about 170 ms slower than `bun run`,
which is the standalone executable's own cost and not the renderer's.

The interactive shell exists, delivered by
[#23](https://github.com/yogeshprasad098/falryn/issues/23). `falryn` with no
arguments decides from observed facts whether this terminal can host it, owns
exactly one renderer when it can, keeps the previous behavior when it cannot,
and restores the terminal on every exit path.

The launch decision is a pure function of a capability record and the parsed
options, in `src/tui/launch.ts`, and returns either a launch or one of seven
named reasons: `machine-format`, `non-interactive`, `unsupported`, `not-a-tty`,
`piped-output`, `dumb-terminal`, and `no-dimensions`. Precedence is what the
caller asked for, then the documented override, then the handles, then the
terminal, then its size — so `--format json` on a perfect terminal reports the
format rather than sending someone to check a handle that was never the problem.
A refusal is an ordinary answer: help on stdout and exit 0, exactly as before
the shell existed, with the reason on the diagnostic handle. A run that will not
launch loads no renderer at all, because `src/cli/dispatch.ts` reaches
`src/tui/shell.tsx` through a dynamic import and only after the decision said
yes; `src/tui/tui-boundaries.test.ts` walks the entrypoint's value-import graph
to assert that, and `src/cli/dispatch-shell.test.ts` proves it behaviorally with
a renderer factory that throws if anything calls it.

The capability record in `src/tui/capabilities.ts` extends the domain's facts
and recomputes none of them: colour, character repertoire, TTY status, and size
are carried verbatim from `terminalCapabilities()`. What it adds is dumb,
multiplexer, remote, and CI hints derived from the environment, the documented
`FALRYN_TUI` override, and — once a renderer exists — the facts only a renderer
can report. It carries a generation and its detection provenance, so "not
observed yet" stays distinguishable from "not supported". `FALRYN_TUI` accepts
`off` or a screen mode; a value this build does not understand is reported and
then ignored rather than treated as a refusal, so a typo cannot lock a user out.

Four OpenTUI defaults are overridden, each for a reason #22 measured or the
architecture already owns: `exitOnCtrlC: false` and `exitSignals: []` leave
interrupt and signals with `src/application/interruption.ts` and
`createProcessSignalPort`, `consoleMode: "disabled"` keeps diagnostics on the
stderr boundary, and mouse reporting is gated on the record rather than left at
OpenTUI's default of on — it is off today because nothing consumes a pointer
event until [#26](https://github.com/yogeshprasad098/falryn/issues/26).

`split-footer` is the delivered default, qualified by #22, with
`alternate-screen` when the terminal has too few rows to leave anything above a
footer. The stdout reconciliation is explicit: while a split-footer renderer is
alive it owns the handle `src/cli/streams.ts` normally owns, which is safe only
because the launch decision has already refused every machine format, so no
result record can be in flight. The shell writes nothing through the result
stream during a session. `destroy()` puts the original `write` back, so the
invocation's closing flush still reports what left the process.

`restore-terminal` has its owner. `src/tui/shutdown.ts` registers the phase's
only participant, and restoration happens at most once in effect and any number
of times safely — both the shell's own teardown and the shutdown coordinator
call it, frequently at once. It writes no escape sequence: OpenTUI's `destroy()`
owns the sequences and this area owns when they run. A renderer that never
started still registers a restoration, which reports that there was nothing to
give back rather than leaving the path silent. A second renderer in one process
is refused as the defect it is, and is reported as `internal` rather than as an
unavailable dependency — nothing was missing.

`src/tui/shell.compiled.test.ts` runs the real `dist/falryn` on a pseudo-terminal
allocated through libc's `openpty`, and asserts on the bytes the terminal
received rather than on anything the program says about itself: the shell draws
its interface at the terminal's real size, `SIGINT` exits `130` through Falryn's
own governance, a `--timeout` exits `124`, and both paths emit the sequences
that show the cursor, reset the scroll region, and turn bracketed paste off. It
reports itself skipped rather than passed when `dist/falryn` is unbuilt or the
platform has no `openpty`.

`integration` joined `RUNTIME_EMITTED_CATEGORIES`, so exit code `5` is now
reachable: a renderer that could not start is a dependency this run needed and
did not have. `dist/falryn` grew from 64,568,930 to 75,054,050 bytes — the
OpenTUI native library and the React reconciler are now genuinely part of what
ships, which is the deliberate change #22's byte-identical result was measuring
the absence of.

The shell has a visual vocabulary and a frame, delivered by
[#24](https://github.com/yogeshprasad098/falryn/issues/24).

Themes are data. Four variants — dark, light, monochrome, high contrast — are
authored at full colour depth in `src/tui/theme/palette.ts`, and every lower
depth is *derived* rather than authored again: a colour is snapped to the
nearest entry of the 256-colour or 16-colour palette, so the bytes Falryn emits
name a colour the terminal already has and there is nothing left for it to
reinterpret. At `none` a token resolves to `null` rather than to a grey, which
is what stops colour-only meaning surviving into a terminal that has no colour.
Every token resolves at every depth in every variant, checked exhaustively.

No status is ever only a colour. Each carries a symbol *and* a word, and
`distinguishableWithoutColor` holds that every pair stays distinct in Unicode,
conservative Unicode, and ASCII. `uncertain` reads "unconfirmed" rather than
"failed": the runtime distinguishes a failure from an effect nobody observed,
and the interface may not blur what the exit table separates. Contrast is
checked against both the base and the elevated surface, with a higher floor for
high contrast and a lower one for `ignored` — the single token whose job is to
recede, and which is held to the ordinary floor in high contrast anyway.

Layout classes are a pure function of measured cells: `compact`, `standard`,
`wide`, or a notice naming the size the terminal needs. The class is selected
from the *terminal*, while the tree is drawn into the region the renderer gives
it — in `split-footer` those differ by most of the window, and selecting from
the drawn region would make every session compact on a terminal with room to
spare. Row space is shared by need before weight, so a short branch name does
not cost a long workspace path the room it was not going to use.

The frame is `AppShell`, `WorkspaceHeader`, `StatusLine`, an overlay host, and
the help and command-palette routes it mounts. Each field of the header carries
its own condition — known, partial, loading, empty, error, cancelled, or
unavailable — and today three of the four are `unavailable` on every real run
with the reason attached, because no producer of sessions, models, or Git state
exists. Values that come from outside Falryn are escaped before they are drawn,
so a workspace path cannot forge a line.

Motion is a two-step transition rather than a tween, and the reason is
verification: OpenTUI's timelines advance from the renderer's own frame loop,
which a test renderer does not run, so a tweened reveal could not be driven to
its final frame in a test — and an animation nothing can assert completing is an
overlay that might never open. Reduced motion maps the duration to zero, so the
first committed frame is already final rather than the first frame of a very
fast animation. It is on by request, on a dumb terminal, and in CI.

`FALRYN_THEME` selects a variant and `FALRYN_MOTION=off` removes transitions,
beside `FALRYN_TUI` from #23. Refusing colour does not reduce motion: they are
different requests.

Every declared screen mode starts, which [#351](https://github.com/yogeshprasad098/falryn/issues/351)
fixed. `split-footer`, `alternate-screen`, and `main-screen` each construct a
renderer; before the fix only the first did, because the configuration paired
`capture-stdout` with every mode and OpenTUI rejects that pairing outside
`split-footer` during construction. The practical effect was that any terminal
with fewer than ten rows — the point where mode selection falls back to
`alternate-screen` — exited `5` instead of opening a shell, and both non-default
`FALRYN_TUI` modes did the same on any terminal. The output mode is now derived
from the screen mode through `capturesStdout`, which had been written, exported,
and tested with no product caller.

A renderer failure now carries its cause onto the diagnostic line rather than
only the sentence saying one occurred. The detail is the bounded, redacted one
the error already held; the raw thrown value still never reaches a handle.

Three checks were added for the class of defect rather than the instance: a
construction test over every declared mode, a compiled run on a terminal too
short for a footer and one per override mode, and a control asserting that
`capturesStdout` has a product caller at all.

The shell is operable from the keyboard, delivered by
[#26](https://github.com/yogeshprasad098/falryn/issues/26).

**Before this, it could not be left.** A terminal in raw mode has `ISIG`
disabled, so pressing Ctrl+C sends the byte `0x03` to stdin and raises no
`SIGINT` — and nothing consumed it. The only way out of a running shell was
killing the process from another window, while the status line said `^C exit`.
Underneath that sat a second silent failure: `createOpenTuiKeymap` returns a
keymap with no binding parsers registered, so the first `registerLayer` threw
inside a React effect where nothing surfaced it. `createDefaultOpenTuiKeymap` is
the constructor that works.

A command is the stable identity. Each declares an id, a title, a description, a
context, a default binding or an explicit `null`, and an availability predicate
that says *why* when the answer is no. Today five commands run — exit, help, the
palette, and focus movement — and the rest are listed, discoverable, and
answered: "the composer is not focused", "nothing is running to cancel". Commands
whose concept does not exist at all, like task inspection, are omitted rather
than listed as unavailable. The ids are `reference/KEYBOARD-SHORTCUTS.md`'s, so
the published table and the palette name the same things.

Bindings are grouped into layers by context and resolved by priority, so a
narrower scope wins only while its surface exists — `escape` closes an overlay
when one is open and reports that there is nothing to cancel when none is. A
conflict is a refusal naming both command ids rather than a last-registration
race, and `app.exit` and `overlay.close` cannot be unbound: they are the two ways
out of a full-screen interface.

Focus is a logical path rather than a component pointer, so it survives a
resize, an overlay opening and closing, and a region going away — moving to the
region that took its place rather than back to the top. Every region carries a
label, because an indicator that is not colour-only needs words.

Help and the palette are rendered from the registry rather than a maintained
table, showing each command's effective binding and its unavailability reason.
Both bound their content to the rows they have: an overlay in `split-footer`
grows the footer while it is open and restores it after, because the default
six-row live region left a help panel one row to draw twenty commands into — and
a terminal does not clip, it overdraws.

The palette's search accepts typed input and narrows the list through
`searchCommands`, the registry's own matcher
([#364](https://github.com/yogeshprasad098/falryn/issues/364)). It had not
before: the matcher existed, was tested, and had no product caller, so the
palette was handed every row and a literal empty query and typing narrowed
nothing. The query lives on the open-overlay route rather than beside it, which
is what makes "closing the palette clears the search" true by construction —
closing replaces the route, so there is nowhere a stale query can survive. The
search field reuses the composer's editing model rather than growing a second
text input, and it counts as a focused text control, so the bare
single-character bindings are withheld while it is open and `?` can be searched
for.

A second defect in the same function is fixed with it. The palette computed a
row budget, a truncation flag, and the rows to show, and then recomputed the
budget inline and discarded all three — losing the row reserved for the "N more"
line. A truncated palette therefore asked for one row more than the panel had,
and because the panel does not grow, two command rows landed on top of each
other and reached the screen spliced together. That is what the standing
`noUnusedVariables` warning on that file was pointing at.

The budget is no longer clamped up to a minimum either, which is what made the
overdraw reachable at all: `Math.max(1, rows - 1)` promises a row the caller may
not have given. `OverlayHost` caps its height while the reveal transition runs,
so the palette is handed a single row on every open where motion is not reduced —
and with a one-row budget the search line is the whole of it. The palette now
spends that row on the query, adds the notice only when a row remains for it, and
says "too little room to list them" rather than "N more" when nothing was shown,
because "more" is only true beside something.

The empty-result line is keyed off what *matched* rather than off what fits. The
two are different answers — "your search found nothing" and "there was no room to
show what it found" — and keying off the second reports the first when it is
false: during the reveal a full command list rendered "Nothing matches that."
directly above its own "24 more" line. The rendered checks measure the rows
actually drawn at every budget, because the panel's height is identical either
way and a count of the panel cannot see a collision inside it.

The same shape was one level up, and
[#366](https://github.com/yogeshprasad098/falryn/issues/366) removed it there.
The overlay host reserved three rows and clamped what remained to
`Math.max(1, height - 3)`, so at the reveal's three-row step it handed the route
a row the border and the dismissal hint had already spent — and the search line
landed on the hint, reaching the screen as `Esceclosesathiscommands.` on every
overlay open where motion is not reduced, for help as well as the palette. The
host now measures the split instead: the border is subtracted, the way out is
paid before the content, and a panel with no room left hands the route zero.

The route is hidden rather than unmounted when nothing fits. A route is not only
what it draws — the palette's search holds a keyboard subscription while it is
mounted — so dropping it for the length of the transition would discard whatever
was typed into an overlay a key had just opened.

The transition's own steps are asserted now, not only its final frame. The
defect survived a full rendered suite because every helper waited for the content
to settle before looking, which is exactly the state that was correct.

Paste is classified before it reaches anything: small text inline, large text as
a bounded preview, and binary, over-long, or invalidly encoded content refused
with the reason. A paste never runs a command.

The keyboard journey is proved twice — through a real renderer with a real
keymap, and against the shipped `dist/falryn` on a pseudo-terminal, where Ctrl+C
now exits `0` with the terminal restored and `?` draws the command table.

A transcript exists as a contract, delivered by
[#354](https://github.com/yogeshprasad098/falryn/issues/354), and as a rendered
surface over it, delivered by
[#355](https://github.com/yogeshprasad098/falryn/issues/355).

**Nothing produces a block yet.** The surface is real and the projection it
renders is empty on every run, because no agent loop, provider, or tool runner
emits an event that becomes one. The activity and status projections
([#358](https://github.com/yogeshprasad098/falryn/issues/358)) do not exist. What
a user sees today is the transcript's empty state, which names a command the
build actually runs; every other behavior below is exercised against fixtures and
a real renderer rather than against live output.

A transcript block is a semantic object, not a log line. Sixteen kinds are
declared as a closed union, and **five of them have a producer**: `notice`,
`turn-outcome`, `model-outcome`, `tool-request`, and `tool-result`, derived from
the eight runtime event kinds that exist. The other eleven — model text and
reasoning, tool progress, process stream and exit, file change, repository
activity, task progress, artifact, and diagnostic — are declared and exercised by
fixtures only, because no agent loop, provider, tool runner, or process boundary
emits them. A test asserts the count of five, so a sixth producer cannot appear
without this file being wrong.

Every block the reducer produces is `ordinary`: the runtime's events carry no
payload, so nothing sensitive or secret reaches it. The `sensitive` and `secret`
classes are constructed by fixtures — for the same reason as the eleven
producerless kinds, and so the transcript surface has something to render them
against. A test asserts the reducer's output is all `ordinary`, so the first
payload-carrying event has to revisit it rather than inherit the default.

**A status is not an outcome.** `status` says whether a block is still changing;
it never says whether anything succeeded. Only the kinds that carry a
`TerminalOutcome` report one, reused from the runtime rather than re-declared, and
a tool result, a process exit, and a turn outcome stay three separate facts with
nothing aggregating them into a fourth.

Truncation, redaction, and omission are three values rather than one boolean.
Truncation carries exact byte, line, and result counts and always names a route;
redaction and omission carry a reason and may honestly have no route at all,
because content that was withheld or never collected has nowhere to expand to.

Identity is the anchor, not the kind, so a tool call that is running and the same
call once it has finished are one block that changed rather than two rows. A
block keeps its first-appearance position through any number of revisions, and a
block that has settled refuses a later revision and counts it instead of
reopening a finished call. Folding is frame-independent: every split point of a
revision run is checked, so what a user sees does not depend on when a producer
flushed.

Sequence gaps, repeats, and out-of-order arrivals are detected per stream and
reported on the projection rather than smoothed over — a transcript with a hole
in it and a note about the hole is more useful than a seamless wrong one. The
transcript is deliberately **not** in the domain's `PROJECTION_NAMES`: that union
names projections this build persists, and nothing stores a transcript cursor.

The reducer's **structural** output for a fixed event run — which blocks exist,
their anchors, kinds, statuses, and outcomes — is recorded as a literal snapshot
beside a declared generation, so the two can only change together. Summary
wording is deliberately outside that boundary and both the module and the test
say so: a snapshot pinning every sentence would fail on a typo fix and teach
everyone to update it without reading it. The cost is a resumed transcript that
may mix wordings, which is cosmetic; a structural change is not, which is why
that is the half enforced. A boundary control asserts the area imports from the domain and
nowhere else, reads no clock and no randomness, writes no second escaping rule
or outcome vocabulary, declares no second session read model, and exports no
expansion route that nothing produces.

### The transcript surface

The surface is the primary region: `AppShell` mounts `TranscriptView` where a
placeholder line used to sit. That placeholder said "Nothing is running yet" and
named no action; the empty state that replaced it is built from the live command
rows, so it cannot advertise a key that does nothing. A compiled check asserts it
on the shipped `dist/falryn` over a pseudo-terminal.

**A collapsed block's height does not depend on the width.** The collapsed form
is at most two rows, each truncated rather than wrapped, so placing the window
over a long history is a sum over numbers instead of a wrap of every block's
text. Only blocks the reader has expanded are measured by wrapping, through the
bounded text cache that #24 delivered and nothing had used until now. A rendered
check mounts ten thousand blocks into a 24-row terminal and asserts the number of
renderables in the tree stays under two hundred and within four of the same frame
over a hundred blocks — OpenTUI's own `ScrollBox` is deliberately not used,
because its viewport culling skips render calls while still mounting a renderable
per item.

**A reader who scrolls away is not pulled back.** The anchor is a closed union of
two states — following the latest, or pinned to a named block at a row offset
inside it — so arriving blocks move the content under a following anchor and
leave a pinned one untouched. Because the pin names a *block* rather than a row
number, a resize re-wraps the content and changes that block's height without
changing which block is being read; an overlay does not touch the state at all.
Unseen activity is reported as a count with the key that follows the latest
again, and `transcript.jumpToLatest` is registered in the command registry rather
than bound ad hoc.

Truncation, redaction, and omission render as three notices with three different
leading nouns and three different status tokens, so they stay distinguishable on
a monochrome terminal — which is the only test of "visibly distinct" worth
passing. Each carries a route or the sentence explaining why there is none, and
the route is placed before the byte and line counts so a narrow terminal clips
the quantity rather than the action. A secret block's content is refused a second
time by the surface rather than trusted to have been withheld upstream, and its
summary is still drawn, because a withheld block is not an invisible one.

Every expansion route the projection can return now resolves to a registered
command, and a control walks the union to prove it. Two of those commands —
opening an artifact and showing diagnostics — are registered as unavailable with
their own reasons, because no artifact viewer or diagnostics view exists; the
surface says so instead of offering a key. Searching the transcript is
unavailable for the same reason and was not delivered here.

One latent defect surfaced and was fixed: every binding declared as `enter` was
never dispatched, because the key parser's canonical name is `return`, so a layer
registered under `enter` never matched. `transcript.expand` and the composer's
two bindings now use the parser's own names.

The surface holds no content and no persisted scroll state. Its state is block
keys — what is expanded, what is selected, and where the anchor is — and full
content is read from the projection every time it is drawn, so a revised block
cannot be rendered from a stale copy. Boundary controls assert all of this,
including that the surface re-derives no part of the block model it is given.

What is **not** delivered by the surface: no dashboard, artifact viewer, or diff
viewer. Duration is reported as a block's age relative
to the transcript's newest block rather than as an elapsed time, because a block
carries one timestamp that a revision replaces — the start of a tool call is not
in the projection, and reporting one would be a number the surface invented.

### Scrollback commits in `split-footer`

Finalized transcript entries reach the terminal's own scrollback through one
adapter, `src/tui/scrollback.ts`, mounted by `AppShell` through a seam that draws
nothing ([#356](https://github.com/yogeshprasad098/falryn/issues/356)). A
boundary control asserts that no other module in the interface area calls
`writeToScrollback` or `createScrollbackSurface`, so the path above the footer is
narrow by check rather than by convention.

**One FIFO, asserted rather than assumed.** OpenTUI's renderer already owns an
ordered queue that captured stdout and programmatic scrollback commits share.
The adapter adds no second queue and no second ordering rule, and the tests read
what reached the terminal through the test renderer's external-output recorder
against a real `split-footer` renderer with stdout capture — including a case
that writes to the captured handle between two commits and asserts the three land
in the order they were produced.

**Once, and never out of order.** An entry commits exactly once, and only when
every entry before it already has. Scrollback is append-only and outlives the
process, so an entry that overtook an unfinished one would sit in the wrong place
permanently; an unfinished entry therefore holds everything behind it, and the
report names which one. Entries that were seen mid-stream commit through
`createScrollbackSurface` and copy their rows out only after `settle()`, while an
entry that arrived final is written atomically through `writeToScrollback`. Both
paths are serialized through one chain, so a settling entry cannot be overtaken
by the atomic entry enqueued behind it.

The adapter is keyed to the renderer rather than owned by the component that
drives it. OpenTUI's React root remounts the whole tree on every `render()` call,
and an adapter that started again with an empty set would write the session into
scrollback a second time beneath itself.

What a commit contains differs from what the reader sees, and each difference is
because scrollback is durable: entries are committed expanded, never marked
selected, and carry no relative time — an age is true for a minute and then is a
permanent lie that nothing repaints. A secret block is still refused its content.
Every committed line is sanitized whether or not its row was flagged untrusted,
because the flag says where text came from and not where it is going.

In `alternate-screen` and `main-screen` the adapter is a no-op, consulted through
`reservesFooter` on every commit rather than once at construction, because
renderer mode is application state. OpenTUI's scrollback APIs throw rather than
degrade when the mode is wrong, and a refused commit is reported instead of
propagated, so one entry that could not land is not a shell that stops drawing.

Nothing produces a transcript yet, so no entry is committed in a real session.
The behavior is exercised by mounting the shell with a projection.

### The composer

The composer is a real control: it accepts multiline Unicode text, keeps a
history, preserves a draft, and resolves every submission through one declared
port ([#357](https://github.com/yogeshprasad098/falryn/issues/357)). The editing
model, the history, and the state machine are plain data with a pure reducer, so
graphemes, draft survival, and snapshot immutability are asserted without a
terminal.

**Positions are grapheme indices, never code-point offsets.** A cursor counting
code points lands inside a combining sequence, a flag, or a joined emoji, and a
backspace there deletes half a character and leaves a fragment the user never
typed. Every index counts what the domain's own segmentation returns, and the
text is rebuilt by joining those, so an index cannot name a position that is not
a character boundary. `Intl.Segmenter` is the segmenter, in one place, because a
second one would be a second answer to what a character is.

**A submission takes a frozen snapshot in the transition that starts it.** Later
edits reach the next submission and never the one in flight. In this build every
submission resolves `unavailable` through the port, with a reason naming
[#33](https://github.com/yogeshprasad098/falryn/issues/33) and a repair route
that is a registered command id — and the draft is left exactly where the user
left it. Discarding the input is the failure a composer exists to prevent, and a
stub agent loop behind the button would be a second answer to what happens to a
turn.

**History never stores a secret.** Content that reads like a credential is not
remembered at all — not redacted, not masked, absent. History is the one place a
prompt outlives the moment it was typed. The signal is the same weak one paste
classification already owns, used here for a refusal to store, where the failure
mode is forgetting something harmless rather than keeping something dangerous. A
recall sets the current text aside and returns it on the way back, so pressing up
is reversible.

Attachments, artifact references, command completion, suggestion, and including a
large paste are declared with the reason each is missing and reported in one line
under the composer. None of them is half-built: a large paste is classified,
bounded, and described rather than inserted, and there is no attachment control
that accepts a file and drops it.

Two decisions came out of measuring the keymap rather than reading about it. A
layer that claims a key means the focused control never sees it, so while the
composer has focus, bindings whose key is one bare character are not registered —
otherwise `?` bound to help makes a question mark impossible to type into a
prompt. The rule is narrow: every modified and named binding keeps working, so
`ctrl+c` and `escape` are never withheld, and the withheld command stays listed
and reachable from the palette. And the `composer` keymap context is active on
**focus** rather than on existence, because the composer's layer outranks the
transcript's and the two share `up` and `down`.

The composer's height is reserved by the layout rather than chosen by the view,
and its chrome is a fixed two rows. The transcript sizes its own window from what
is left, so the two numbers come from one function: a composer that drew one row
more than the layout reserved overdrew the transcript's last line, which is a
defect this delivery hit and fixed rather than a hypothetical.

Nothing can answer a prompt, so no submission is ever accepted in a real session.
The accepted path is exercised by handing the runtime a port that accepts.

### Activity, status, and projection recovery

The activity rail projects the semantic state the runtime actually owns, and the
status line projects one health level from it
([#358](https://github.com/yogeshprasad098/falryn/issues/358)). Both are pure
data derived in `src/presentation/activity/`; the rail is the one persistent
contextual surface a `wide` layout gets, and narrower layouts draw none rather
than a squeezed one.

**Nothing declares a second vocabulary.** `ScopeStatus`, `TerminalOutcome`, and
`EffectCertainty` are the runtime's and are used unchanged. Every outcome the
runtime declares reaches a distinct status token, and the check for
"distinguishable" runs on a monochrome terminal, where colour is unavailable to
break a tie — the walk is over the runtime's own exported list, so a kind added
later cannot fall through to a default. An unconfirmed effect outranks the
outcome that carried it: a scope can complete while something in its subtree left
an effect nobody observed, and drawing that as success is the failure the outcome
vocabulary exists to prevent. `cancelling` is its own state rather than a flavour
of cancelled, because work asked to stop that has not acknowledged is still
running.

**Health is a precedence, not an aggregate.** Shutting down, then an unconfirmed
effect, then a failure, then a refusal or expiry, then a cancellation, then live
work, then idle. A run with three completed scopes and one uncertain effect is
not "mostly fine", and an average would bury the one fact a reader has to act on.
`unknown` is a real level: a build with no runtime attached reports it rather
than reporting idle, because nothing running and nothing able to tell us are
different statements. It is projected once, by the layer that has every report,
so the rail and the status line cannot disagree — two components each deriving a
level from overlapping inputs is exactly how a status line says "idle" beside a
rail showing a failure.

**Resubscription is a fold from a cursor.** The cursor is a scope event's own
`order`, monotonic across the whole tree; a wall-clock position could not
separate two events in the same millisecond, and a cursor that could not would
replay one or drop one on every resume. Two properties make a resume safe and
both are asserted: applying a suffix to a projection equals folding the whole
sequence from nothing, and applying an overlapping range twice changes nothing.
An overlap is skipped rather than refused, because a resubscribing view cannot
compute the slice a refusal would make it responsible for. A cursor whose
generation does not match exactly is rebuilt rather than resumed from, in both
directions.

That resubscription does not restart the runtime is enforced structurally rather
than promised: the projection area holds no scope tree, scheduler, or shutdown
coordinator, and a boundary control asserts it cannot name one. A second control
asserts no ephemeral view state — focus, scroll, animation — is written anywhere
that outlives the process.

The rail keeps every live entry and a bounded tail of settled ones, and reports
how many it is not showing. Live work is never evicted to make room for finished
work.

Nothing produces a scope event into a view yet: there is no agent loop attached
to the shell, so a real run reports `unknown` and an empty rail. The behavior is
exercised by folding fixture event sequences and mounting the shell with the
resulting projection.

The compiled file is a development bootstrap artifact. It is not a supported
Falryn product binary or release. A separate compiled probe confirmed that a
`SIGINT` delivered to a Bun standalone executable reaches the runtime lifecycle,
cancels the root scope, and runs all ten shutdown phases to a `completed`
outcome. That probe remains manual; the storage smoke check described above is
the first automated compiled-executable check, and it runs under `bun run ci`
rather than `bun run check`, because `bun run check` does not build.

## Not implemented

No end-user product behavior has been implemented. In particular, the
repository does not yet provide:

- the shutdown participants other than the scheduler drain, the artifact
  finalize, the event-store quiesce, the projection checkpoint, the storage
  close, and the terminal restore — child-process termination registers from its
  own owner, and that owner does not exist yet;
- watching configuration sources, and writing configuration files. Nothing in
  v0.1 runs long enough to observe a live reload and nothing sets a value, so a
  watcher and a serializer would be scaffolding with no caller. Refresh is an
  explicit call carrying the complete diff, classification, and publish path;
- writing a credential *into* a store. The keychain adapter reads and deletes;
  nothing creates an entry, because the flow that would — interactive
  authentication — is [#35](https://github.com/yogeshprasad098/falryn/issues/35).
  A credential is placed in the keychain by the user today;
- any composition of the credential resolver. The stores, the resolver, and the
  host command runner exist and are tested, and `src/main.ts` constructs none of
  them, so no real run resolves a credential. The first consumer is #35;
- any *producer* of a session, turn, model attempt, invocation, or event. The
  tables, the typed repositories, the durable event store, and the projection
  cursor all exist and are composed, and nothing in a real run starts a session
  or opens a turn, because the agent loop that would is
  [#33](https://github.com/yogeshprasad098/falryn/issues/33) and later. Also
  absent: usage accounting and provider routing on a model attempt, which arrive
  with the model path, and read-connection pooling, which stays undecided until
  there are enough real read paths to measure;
- any command, human, JSON, JSONL, or terminal rendering of those records. The
  shared `SessionView` shape exists so a renderer does not have to restate it;
  the renderers are [#16](https://github.com/yogeshprasad098/falryn/issues/16)
  and [#21](https://github.com/yogeshprasad098/falryn/issues/21);
- a projection registry. One projection is maintained and its name is a closed
  union of one; a registry for a single member would be a framework built for
  one caller. Deterministic replay, fork, rewind, and reachability garbage
  collection over these rows are each owned elsewhere and none is implemented;
- any *producer* of an artifact. The table, the repository, the store, the blob
  adapter, and the `finalize-artifacts` participant all exist and are composed,
  and nothing in a real run ingests bytes, because the tools and providers that
  would are later work. Also absent from this area: reachability garbage
  collection, export, import, replay, viewers, and the provenance graph, each
  owned by [#15](https://github.com/yogeshprasad098/falryn/issues/15),
  [#116](https://github.com/yogeshprasad098/falryn/issues/116),
  [#117](https://github.com/yogeshprasad098/falryn/issues/117),
  [#120](https://github.com/yogeshprasad098/falryn/issues/120), or
  [#121](https://github.com/yogeshprasad098/falryn/issues/121);
- any composition of the configuration loader into a running program.
  `src/main.ts` constructs no loader, so no configuration file is read on a real
  run;
- any composed use of the local-data service beyond storage. `src/main.ts`
  resolves roots, registers `sqliteState`, and prepares the `state` root, so
  that one directory is created on a real run. Retention reporting, removal
  planning, guarded execution, and reconciliation exist and are tested, and
  nothing calls them on a real run, so nothing is measured or removed. The
  owners that will register the remaining ownership classes — memory,
  extensions — do not exist, and each is reported as unregistered rather than
  assumed absent;
- the command surfaces that would show a reset or uninstall plan and collect its
  confirmation. This area produces the plan and the typed outcome; rendering
  them and asking is the CLI's;
- headless product behavior beyond `config` and `doctor`, or anything the
  OpenTUI application shows. The command tree, global options, help, version,
  the process boundary beneath them, and all four output projections are real;
  what is absent is commands to render. The shell's *lifecycle* is real — it
  launches, owns one renderer, and restores the terminal — and what it renders
  is a frame with nothing in it: a workspace header, an empty primary region, and
  a status line. Since #24 the theme, layout classes, primitives, overlay host,
  and frame composites are real. What is absent is content and interaction —
  `TranscriptView`, `Composer`, and `ActivityRail` are
  [#25](https://github.com/yogeshprasad098/falryn/issues/25), and the keymap,
  focus routing, and command registry are
  [#26](https://github.com/yogeshprasad098/falryn/issues/26). The overlay routes
  open on their keys since #26, the palette lists every command with its
  binding and its availability, and since
  [#364](https://github.com/yogeshprasad098/falryn/issues/364) typing narrows
  that list. No producer of
  sessions or turns exists, so a JSON Lines run today carries the short
  lifecycle a `config` or `doctor` command produces rather than a model turn.
  Since [#345](https://github.com/yogeshprasad098/falryn/issues/345) a CLI
  invocation does cancel and does time out, and both terminal records are
  proven against observed runs in source and compiled mode.
  Also absent: every command group whose capability does not exist, shell
  completion, and hidden or deprecated command policy beyond its declaration;
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
- **Current parent outcome:** [#21 Deliver the OpenTUI application shell](https://github.com/yogeshprasad098/falryn/issues/21), in progress with #22, #23, #24, and #26 landed. [#16 Deliver the CLI and headless foundation](https://github.com/yogeshprasad098/falryn/issues/16) remains in progress with #17, #18, #19, and #20 landed.
- **Next planning action:** verify [#25](https://github.com/yogeshprasad098/falryn/issues/25). Every required child has landed — #354 the transcript block model, #355 the surface that renders it, #356 the scrollback commit path, #357 the composer, #358 the activity and status projections, and #364 the palette's reachable search, which parent verification raised as the one criterion no child had delivered — so what remains is the parent's own integrated acceptance.

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
