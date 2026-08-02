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
per-source reports, and diagnostics. Rendering it for humans or machines is
#18's and #19's.

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

Observed on 2026-08-01:

```text
bun run check  PASS  (Biome, tsc --noEmit, and bun test)
bun run build  PASS  (Bun standalone executable compiled to dist/falryn)
bun run ci     PASS  (quality, tsc --noEmit, build, then bun test)
```

`bun run ci` now builds before it tests, so `src/main.compiled.test.ts` runs
against a real `dist/falryn`: the standalone executable opens, migrates, and
closes a database under a temporary state root, leaves one file, carries its
migration bookkeeping and every product table into the binary at schema version
3, and reopens the same database on a second run. Without a build the check
reports itself as skipped rather than passing on an executable that does not
exist.

One limitation observed by that check: the process lingers for one full shutdown
phase grace after its work is done. The delay is in the lifecycle owner rather
than in storage — a bare `createRuntimeLifecycle` plus `requestShutdown` shows
the same wait with no database composed — and it is tracked as
[#316](https://github.com/yogeshprasad098/falryn/issues/316) rather than fixed in
a data change.

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
  finalize, the event-store quiesce, the projection checkpoint, and the storage
  close — child-process termination and terminal restoration each register from
  their own owner and neither of those owners exists yet;
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
