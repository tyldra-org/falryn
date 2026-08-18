# Current state

This file is Falryn's sole concise implementation-status owner. It records what
exists and has been verified in the `falryn` repository. It does not duplicate
the product design or GitHub roadmap.

Last reconciled: **2026-08-18**

## Where to look

| Question | Canonical owner |
| --- | --- |
| What should Falryn become? | [`falryn-docs`](https://github.com/tyldra-org/falryn-docs) and its [documentation map](https://github.com/tyldra-org/falryn-docs/blob/main/DOCUMENTATION-MAP.md) |
| What is planned, active, blocked, or complete? | [Falryn Roadmap](https://github.com/orgs/tyldra-org/projects/1), milestones, parent issues, native subissues, and linked pull requests |
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
- repository-owned quality, type-check, test, and compiled-build commands;
- a repository-owned GitHub Actions workflow at `.github/workflows/ci.yml` that
  triggers for pull requests and pushes to `main`, installs
  the manifest-selected Bun version with the frozen lockfile, runs separate
  quality, type-check, build, and test gates on GitHub-hosted
  `ubuntu-latest`, runs the macOS suites on `macos-latest`, and runs the Windows
  source baseline and compiled CLI smoke on `windows-latest`; and
- a Bun standalone compilation target at `dist/falryn`.

The workflow's first pull-request run in
[#411](https://github.com/tyldra-org/falryn/pull/411) passed every gate on
the baseline Linux runner. Both the baseline and macOS arm64 compiled-smoke
jobs passed in [#412](https://github.com/tyldra-org/falryn/pull/412): the
selected executable reported `darwin`, `arm64`, and compiled mode while its
CLI, migrations, embedded OpenTUI assets, and pseudo-terminal paths ran. This
is a development qualification, not product platform support, installation,
signing, update, or release readiness.

The offline repository-integrity gate introduced by
[#32](https://github.com/tyldra-org/falryn/issues/32) runs from
`bun run check` and the baseline CI job after the frozen Bun install. Its
TypeScript tool records the admitted direct runtime and development dependencies
with exact versions, SPDX license expressions, and canonical source
repositories, then checks the manifest, lock integrity entries, installed
package metadata, lifecycle hooks, and declared patches against that policy.
It also declares `src/main.ts` through `bun run build` to `dist/falryn` as the
sole current generated output, requiring that destination to remain ignored and
untracked. This is an offline direct-admission boundary, not a transitive SBOM,
registry or vulnerability scan, signing system, or legal-compliance claim.

The domain contracts introduced by
[#2](https://github.com/tyldra-org/falryn/issues/2) add `src/domain/` with
one public entrypoint at `src/domain/index.ts`:

- branded identities for workspace, session, turn, model attempt, invocation,
  capability, event, trace, stream, idempotency key, sequence, configuration
  generation, PTY session, managed service, service generation, and process
  capture, each with a
  boundary parser that reports a code rather than the rejected value;
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
[#4](https://github.com/tyldra-org/falryn/issues/4) adds `ClockPort`,
`SignalPort`, the deadline model, the cancellation scope contracts, and the
shutdown phase and participant contracts to `src/domain/`, plus two new source
areas:

- `src/application/` — the cancellation scope tree, nested immutable runtime
  contexts, the interruption escalation policy, the shutdown coordinator, and
  the lifecycle that composes them, behind `src/application/index.ts`;
- `src/integrations/` — Bun host adapters behind their domain ports, including
  the process-signal adapter, behind `src/integrations/index.ts`.

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
  stays visible from above whatever order the scopes settled in. A bounded
  ancestor-chain tombstone remains after eviction so a late effect can still
  fold upward, capped at the same 1,000 as retained terminals. The lifecycle
  event log is bounded with the number of dropped events reported rather than
  truncating silently.

The scheduling engine introduced by
[#3](https://github.com/tyldra-org/falryn/issues/3) adds the work-unit,
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
[#5](https://github.com/tyldra-org/falryn/issues/5) adds `FalrynError`,
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
[#7](https://github.com/tyldra-org/falryn/issues/7) adds the configuration
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
consumed by [#10](https://github.com/tyldra-org/falryn/issues/10) — root
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
[#8](https://github.com/tyldra-org/falryn/issues/8) adds the source,
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
[#9](https://github.com/tyldra-org/falryn/issues/9) adds `CredentialStorePort`,
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
  [#35](https://github.com/tyldra-org/falryn/issues/35) and is neither
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
  [#47](https://github.com/tyldra-org/falryn/issues/47) will own. A
  model-requested credential read is not a supported path.

The supervised command foundation delivered by
[#69](https://github.com/tyldra-org/falryn/issues/69) extends the same
`CommandRunnerPort` without turning it into a product process tool. Its
implementation remains split by ownership: `src/domain/process.ts` owns the
request modes, bounds, path-shape rule, and exhaustive outcomes;
`src/integrations/host-commands.ts` is the only Bun `spawn` adapter; and
`src/integrations/host-commands.test.ts` qualifies the real non-PTY boundary.

Its verified behavior:

- **direct argv is shell-free.** An omitted or explicit `mode: "argv"` request
  passes an absolute executable and the exact argument vector as separate
  process arguments. Shell metacharacters and variable references remain
  literal argument text. Direct requests accept at most 32 arguments;
- **Bash is deliberate, not inferred.** A `mode: "bash"` request names its
  absolute Bash interpreter and carries one UTF-8-bounded command string. The
  adapter invokes it with `--noprofile --norc -c`, so shell syntax exists only
  when the request selected Bash and startup files cannot add hidden work;
- **the child boundary is narrow and bounded.** An optional absolute `cwd`,
  complete supplied environment, non-negative timeout, disabled stdin, and
  output limit are validated before spawn. Script and captured stdout are
  capped at 64 KiB; the environment is capped at 64 entries and 32 KiB. The
  host checks existence and executability, while workspace capability owners
  remain responsible for binding a directory to a workspace;
- **terminal facts remain typed.** Successful and non-zero exits are
  `exited` with the exact exit code and stdout. Excess output, timeout,
  cancellation, invalid request shape, and spawn failure remain distinct
  outcomes. Spawn failure codes never echo executable, cwd, arguments, command,
  or environment values;
- **stderr cannot block the child or cross the boundary.** The adapter drains
  stderr to completion while retaining no text, so a noisy child does not
  deadlock and tool or credential diagnostics cannot accidentally quote
  sensitive command data. Hush reduction of captured facts is owned by
  [#72](https://github.com/tyldra-org/falryn/issues/72). Confirmation and
  product tool registration are later work. Process-tree stop for this runner is owned by
  [#73](https://github.com/tyldra-org/falryn/issues/73). Ordered observation and
  artifact spillover for non-credential commands are owned by
  [#71](https://github.com/tyldra-org/falryn/issues/71).

The PTY and managed-service foundation delivered by
[#70](https://github.com/tyldra-org/falryn/issues/70) adds
`src/domain/process-session.ts` and the Bun adapter
`src/integrations/host-process-sessions.ts`, both exported through the existing
domain and integrations entrypoints. It remains an internal capability boundary:
no provider, UI, or model path receives a Bun subprocess or terminal handle, and
no product process tool is registered yet.

Its verified behavior:

- **PTY requests are explicit and bounded.** An absolute executable, exact argv,
  supplied environment, optional absolute cwd, dimensions, terminal name,
  UTF-8 encoding, and replay budget are validated before allocation. The host
  adapter supports copied input/output bytes, attach/detach, bounded replay,
  resize, SIGINT, termination escalation, EOF, ordered lifecycle events, exit
  facts, and an `uncertain` state when termination cannot be confirmed;
- **managed services have typed lifecycle policy.** Readiness is immediate or
  an output marker on a declared stream, idle shutdown is disabled or bounded,
  restart windows are bounded, and input is serialized through a pipe. stdout
  and stderr are drained separately into bounded per-generation replay windows;
- **generations prevent stale effects.** A crash either starts a new branded
  service generation or reports `no-restart-policy` /
  `restart-budget-exhausted`; sends and stops carrying an old generation fail
  as `stale-generation`;
- **resource and cleanup limits are visible.** Active PTYs and services are
  capped at 32 and 16, inactive retained sessions at 128 and 64, writes and
  replay at 64 KiB, and readiness observation at 64 KiB. Managed shutdown
  escalates SIGTERM to SIGKILL and reports `shutdown-timeout` when cleanup
  remains unconfirmed. Durable persistence, product-tool registration, and
  CLI/TUI/model projection are later work. Process-tree stop for PTY and
  managed services is owned by [#73](https://github.com/tyldra-org/falryn/issues/73).
  Hush reduction of captured facts is owned by
  [#72](https://github.com/tyldra-org/falryn/issues/72). Artifact spillover for
  non-PTY observation is owned by
  [#71](https://github.com/tyldra-org/falryn/issues/71);
- **the boundary is tested against real processes.** Focused domain and host
  tests cover validation, PTY write/resize/reattach/termination behavior,
  readiness, serialized input, restart generations, idle shutdown, bounded
  replay, no-restart policy, and the repository's artifact-byte boundary.

The process-output capture foundation delivered by
[#71](https://github.com/tyldra-org/falryn/issues/71) adds
`src/domain/process-capture.ts` and the Bun adapter
`src/integrations/host-process-capture.ts`, exported through the existing
domain and integrations entrypoints. It is the observation path for non-PTY
commands: `CommandRunnerPort` remains credential-safe and still discards
stderr. No product process tool is registered, and Hush does not run.

Its verified behavior:

- **stdout and stderr are ordered observations.** Copied chunks carry a merged
  observation order and a per-stream order. The report keeps a bounded inline
  preview, exact byte counts, UTF-8 or binary encoding, truncation, line-limit
  facts, exit code, signal, duration, and the stop that ended the run
  (`exited`, `timed-out`, `cancelled`, `capture-exceeded`, or `uncertain`);
- **limits are declared and enforced.** Inline previews default to 64 KiB,
  total capture and artifacts to 1 MiB (capped at 8 MiB), lines to 16 KiB, and
  queued chunks to 64 KiB. Without an artifact store, exceeding inline, line,
  queue, encoding, or total bounds stops the child as `capture-exceeded`;
- **exact overflow spills through ArtifactStorePort.** Overflow and invalid
  UTF-8 are ingested as `origin: capture` with copied bytes. A committed
  artifact keeps the exact stream; ingest failure is `uncertain` with
  `artifact-ingest-failed` rather than a successful truncated result;
- **the credential runner is unchanged.** This port never becomes the
  keychain/command path, never exposes a raw subprocess, and does not perform
  Hush reduction or CLI/TUI/model projection. Kill-stage recording and
  process-tree stop are owned by
  [#73](https://github.com/tyldra-org/falryn/issues/73);
- **the boundary is tested against real processes.** Focused domain tests cover
  validation, merged order, inline limits, spillover, invalid UTF-8, and ingest
  failure. Host tests cover dual-stream capture, artifact spill, timeout, and
  invalid executables on POSIX.

The Hush command-output reduction foundation delivered by
[#72](https://github.com/tyldra-org/falryn/issues/72) adds `src/domain/hush.ts`,
exported through the existing domain entrypoint. It is a pure reduction over a
finished `ProcessCaptureReport` plus the structured command that produced it:
no spawn, kill, pipes, or host adapter. No product process tool, CLI, TUI, or
model projection is registered.

Its verified behavior:

- **terminal facts are copied, not rewritten.** The result keeps executable/argv
  or Bash command, cwd, exit code, signal, duration, stop kind, original byte
  counts, truncation, encoding, and capture artifact handles. The child
  environment is never copied into the projection;
- **family and reducer are chosen from argv, not by executing output.** The
  normalized executable basename and first subcommand or Bash token select a
  family; output shape is only a fallback for unknown executables. Reducer ids
  are at subcommand grain (`git.diff`, `git.status`, `files.rg`, `generic`,
  `safe.passthrough`) and versioned `hush.v1`;
- **specialized families project structure; unknown commands stay generic.**
  `git.diff` keeps per-file `path: +N -M` stats and drops hunk bodies;
  `git.status` groups porcelain paths by directory; search groups matches by
  path; listing and summary families cap repetitive lines. An expected-family
  miss uses generic reduction; reducer failure returns a raw bounded projection
  plus expansion handles rather than dropping the command result;
- **reductions are bounded and must not grow.** Reduced text defaults to 8 KiB
  and is capped at 64 KiB. A specialized or generic projection is kept only
  when it is smaller than the original inline bytes; otherwise Hush returns
  exact passthrough. Expansion uses #71 inline capture and artifact handles,
  not Loom;
- **the boundary is tested in the domain.** Focused tests cover family
  selection from argv versus output text, git.diff stats, git.status grouping,
  rg path grouping with artifact expansion, expected-family miss, generic
  fallback with stderr, binary omission, timed-out facts, listing caps with
  important patterns, and passthrough fidelity.

The process-tree cancellation foundation delivered by
[#73](https://github.com/tyldra-org/falryn/issues/73) adds
`src/domain/process-tree.ts` and the Bun adapter
`src/integrations/host-process-tree.ts`, wired through the command, capture,
and session host adapters. POSIX children start in their own session so the
leader PID is the process-group ID. Cancellation and deadlines signal that
owned group, then the leader, then SIGKILL after a bounded grace. PTY spawn
does not set `detached`, because a controlling terminal is required; group
then leader signaling still applies. Windows has no process-group primitive
here and is not claimed as qualified. No product process tool, CLI, TUI, or
model projection is registered.

Its verified behavior:

- **stop targets the owned tree, not only the leader.** A grandchild that
  survives SIGTERM to the leader PID is reaped by group escalation. Default
  grace is 500 ms and is capped at 5 s. Falryn never signals PID 1 or itself;
- **capture reports record kill stage.** `none`, `terminate`, `kill`, or
  `unconfirmed` is copied onto `ProcessCaptureReport`. CommandOutcome kinds
  stay `timed-out` / `cancelled` / `output-exceeded`. Unconfirmed descendants
  are `uncertain` rather than a silent success;
- **detachment stays explicit.** #70 attach/detach is unchanged; otherwise
  shutdown owns cleanup. Pipes keep draining while the tree is stopped;
- **the boundary is tested against real processes.** Domain tests cover stage
  transitions. POSIX host tests spawn a HUP-ignoring grandchild, prove
  leader-only SIGTERM leaves it running, then assert group escalation reaps
  it. Capture timeout records `terminate` or `kill`.

The process quoting, platform, truncation, and interruption fixture matrix
delivered by [#74](https://github.com/tyldra-org/falryn/issues/74) adds
`src/integrations/host-process-fixtures.test.ts` over the existing #69–#73
ports. It does not register a product process tool or change spawn/kill policy.

Its verified behavior:

- **quoting is mode-explicit.** Direct argv keeps metacharacters as one literal
  argument; Bash mode parses a deliberate command string. The same hostile text
  is not a shell line unless `mode: "bash"` selected the interpreter;
- **platform limits are named.** `ownedTreeSpawnOptions().detached` is true
  only off `win32`. Windows skips `/bin` and process-group fixtures and is not
  claimed as a job-object host;
- **truncation is a typed outcome.** Command overflow is `output-exceeded`,
  not returned truncated text. Capture without an artifact store stops as
  `capture-exceeded` with a truncated inline prefix and no artifact;
- **interruption stays distinct from timeout.** Abort before spawn and abort
  during a run are `cancelled`; a deadline is `timed-out`. Disabled stdin
  makes `cat` exit instead of hanging. Capture abort records `cancelled` and a
  kill stage. PTY SIGINT can end a session;
- **capture does not inherit undeclared environment.** Large dual streams keep
  both sides and a merged observation order.

The read-only Git observation foundation delivered by
[#76](https://github.com/tyldra-org/falryn/issues/76) adds `src/domain/git.ts`
and the host adapter `src/integrations/host-git.ts`. It discovers a repository
from an absolute start path and observes status, diff, log, and blame. Git runs
through `ProcessCapturePort` with a supplied environment and structured argv.
No product Git tool is registered. This slice does not stage, commit, fetch,
or rewrite history.

Its verified behavior:

- **discovery records identity.** Worktree root, Git dir, common dir, HEAD or
  unborn/detached state, branch, upstream, ahead/behind, superproject,
  sparse-checkout, Git version, remotes, and an observation timestamp. Nested
  start paths resolve to the containing worktree; a nested repository is
  discovered from its own root;
- **status is porcelain v2.** Index, worktree, untracked, optional ignored, and
  unmerged/conflict entries. Merge/rebase/cherry-pick/revert/bisect is named
  when Git reports the corresponding ref. Fields are `observed`, `unavailable`,
  or `truncated`;
- **diff, log, and blame are bounded observations.** Truncation is a typed
  fact. Remote URLs drop embedded credentials. An already-aborted request
  starts no git process;
- **the child environment is supplied.** `GIT_TERMINAL_PROMPT=0` and
  `core.hooksPath=/dev/null`. Failures distinguish `not-a-repository`,
  `unsafe-ownership`, `lock-contention`, `cancelled`, `timed-out`, and spawn
  failure. Stage, commit, fetch, pull, push, and sync are
  [#283](https://github.com/tyldra-org/falryn/issues/283).

The patch Git-awareness slice from
[#77](https://github.com/tyldra-org/falryn/issues/77) lets `PatchPort` consume
that observation. When `GitPort` is omitted, preview and apply keep `git`
`absent` and behave as #66/#67. When wired, they observe status from the
workspace root:

- **a missing repository is not a patch failure.** `not-a-repository` stays
  `absent`;
- **in-progress operations refuse the plan.** `merge`, `rebase`,
  `cherry-pick`, `revert`, and `bisect` are `git-operation`. Unmerged paths
  are `git-conflict`. The current file is preserved;
- **dirty overlapping targets are named, not refused.** Ordinary, rename, and
  untracked paths on a clean operation are listed in `dirtyTargets` and may
  still apply;
- **HEAD can be a plan precondition.** `expectedGitHead` is the Git oid, not
  filesystem `PathEntry.revision`. Mismatch is `git-head-mismatch`. Apply
  rechecks immediately before writes; a repository that vanishes after the
  first look is `git-unavailable`;
- **truncated status fails closed** when a target is not in the observed
  entries.

Validated by `src/domain/workspace-patch.test.ts` and
`src/application/workspace-patch.test.ts`. Product Git/patch tools remain
later.

The safe branch and worktree slice from
[#78](https://github.com/tyldra-org/falryn/issues/78) extends `GitPort` with
create/switch/delete branch and worktree add/list/remove. Mutations recheck
identity first. `--force`, `-D`, stash, and discard-changes are never passed.

Its verified behavior:

- **in-progress Git operations refuse mutation.** Merge, rebase, cherry-pick,
  revert, and bisect are `operation-in-progress`. Optional `expectedHead`
  mismatch is `head-mismatch`;
- **switch and delete stay recoverable.** `git switch` never discards local
  changes. `git branch --delete` never uses `-D`; unmerged names are
  `not-merged`. The current branch is `checked-out`;
- **worktrees are listed and scoped.** Porcelain records path, HEAD, branch or
  detached, locked, and prunable. Add never uses `--force`. A branch already
  checked out elsewhere is `checked-out`. Remove refuses dirty/untracked
  content and the main worktree.

Validated by `src/domain/git.test.ts` and `src/integrations/host-git.test.ts`.
Product Git tools and worktree owner-task persistence remain later.

The checkpoint slice from
[#79](https://github.com/tyldra-org/falryn/issues/79) records index and tracked
worktree trees plus optional included untracked blobs under
`refs/falryn/checkpoints/`. Restore previews first and stops when HEAD moved,
the snapshot is truncated, or an included untracked path collides.

Its verified behavior:

- **create and list stay off the user index.** Snapshots use a temporary index
  plus `hash-object`/`commit-tree`/`update-ref`. Unlisted untracked files are
  counted as excluded and are not restored;
- **restore is previewed.** `planRestore` names index and worktree changes.
  HEAD movement, truncated snapshots, and untracked collisions are
  `restore-ambiguous`. In-progress operations remain `operation-in-progress`;
- **rollback never force-cleans.** Restore uses `git read-tree` and
  `git restore --worktree` without `--force`, `reset --hard`, `clean`, or
  stash. Missing included untracked files are recreated; existing different
  content is refused.

Validated by `src/domain/git.test.ts` and `src/integrations/host-git.test.ts`.
Product Git tools and worktree owner-task persistence remain later.

The commit-planning slice from
[#80](https://github.com/tyldra-org/falryn/issues/80) inventories Git status
and recent subjects, then returns cohesive groups, drafted messages, a
validation summary, and provenance. It never stages or commits.

Its verified behavior:

- **planning is advice.** `planCommits` pairs source with tests, lockfiles with
  `package.json`, and same-directory leftovers. Ignored files are omitted.
  Unmerged and secret-looking paths stay unassigned;
- **provenance names the baseline.** Planner version, `git-status-log` source,
  `model: null`, HEAD, and truncation are recorded. In-progress operations are
  `operation-in-progress`;
- **the worktree is unchanged.** Planning does not `git add`, `git commit`,
  stash, or force-update.

Validated by `src/domain/commit-plan.test.ts` and
`src/integrations/host-git.test.ts`. Product Git tools remain later.

The stage, commit, and sync slice from
[#283](https://github.com/tyldra-org/falryn/issues/283) mutates Git only
through explicit `GitPort` methods. Pathspecs are required. Secret-looking
paths are not staged. Pull and sync fast-forward only. Force, rebase, stash,
amend, and hook bypass are never passed.

Its verified behavior:

- **stage and unstage take explicit paths.** `git add -- <paths>` never uses
  `-A` or `.`. Secret-looking paths are `secret-path`. Unstage may restore a
  secret path from the index with `git restore --staged`;
- **commit is subject-only.** Empty index is `empty-index`. A staged secret
  path is `secret-path`. Subjects cannot invent `#N` or version tokens. User
  hooks run; hook failure is `hook-failed`. Signing stays repo-configured;
- **fetch, pull, push, and sync stay recoverable.** Fetch never prunes or
  force-updates. Pull refuses missing upstream and dirty/unmerged trees, then
  `merge --ff-only`. Push names the current branch and never force-updates.
  Sync fetches, fast-forwards when behind and clean, pushes when ahead, and
  reports `diverged` when both. Detached HEAD is `invalid-request`. Credential
  failure is `authentication`.

Validated by `src/domain/git.test.ts` and `src/integrations/host-git.test.ts`.
Product Git tools, autocommit, and executing a commit plan remain later.

`bun run check` passed with 3,240 tests passing and 14 skipped.
Platform-specific PTY and process-capture tests are skipped on Windows, while
the compiled qualification suites remain owned by CI.

**macOS is the qualified keychain target.** Linux and Windows report
`unsupported` with a stated reason and spawn nothing; qualifying them is
[#220](https://github.com/tyldra-org/falryn/issues/220). The
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
[#10](https://github.com/tyldra-org/falryn/issues/10) adds `FileSystemPort`,
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
[#296](https://github.com/tyldra-org/falryn/issues/296) connects those
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
[#299](https://github.com/tyldra-org/falryn/issues/299) makes that ordering
observable rather than silent: the scheduler no longer discards the refusal, and
`ScopeTree.recordLateEffect` folds the late effect into every surviving ancestor
using the same upward fold a scope performs when it settles normally. The settled
scope's own terminal outcome is never rewritten, and the scheduler warns —
naming the unit, the scope, and the effect — whenever a late effect demands
inspection.
[#305](https://github.com/tyldra-org/falryn/issues/305) extends that fold past
eviction: the tree keeps a bounded ancestor-chain tombstone
(`MAX_EVICTED_TOMBSTONES`, the same 1,000 as the retained-terminal window) so a
unit that terminates after its scope was evicted still updates surviving
ancestors' `subtreeEffect` and `requiresInspection`. Eviction policy is
unchanged — live scheduled units do not block eviction — and the settled scope's
own node is not restored.

Two remaining limitations of that wiring:

- the drain polls every 10 ms through `ClockPort` rather than waiting on a
  quiescence signal, because the scheduler reports a running count and publishes
  no such signal. The poll is bounded and deterministic under a manual clock and
  carries no correctness risk; and
- a late effect whose eviction tombstone has also been trimmed is reported but
  not attributed. The diagnostic still names the unit and the effect; there is
  no ancestor chain left to fold into.

**One `RuntimeEvent` kind now has a production producer.** The configuration
loader appends `configuration.generation.changed` whenever it publishes a
generation, through the in-memory store #2 shipped. A durable store now exists
beside it — see the persistence section below — and nothing composes the two
together yet, because the loader is not composed into a running program either.
The remaining seven kinds describe sessions, turns, model attempts, and
capability invocations, and the runtime backbone still has none of those
concepts — their first producers are
[#33](https://github.com/tyldra-org/falryn/issues/33) for sessions and
turns and
[#40](https://github.com/tyldra-org/falryn/issues/40) for model and
capability kinds. Inventing scope or scheduler event kinds to fill the gap would
create events with no consumer.

**Falryn has one database.**
[#12](https://github.com/tyldra-org/falryn/issues/12) adds `SqliteConnectionPort`
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
[#13](https://github.com/tyldra-org/falryn/issues/13) add the production
schema and everything that reads and writes it:

- migration `0001` is the first production step. It creates `sessions`, `turns`, `model_attempts`,
  `invocations`, `events`, and `projection_cursors` as `STRICT` tables, plus the
  four indexes the listings below actually use. It is non-destructive, so it
  takes no backup. There is no `workspaces` table: a session carries
  `workspace_id` as an identity column with no foreign key, because the
  workspace record is owned by
  [#55](https://github.com/tyldra-org/falryn/issues/55) and
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
[#14](https://github.com/tyldra-org/falryn/issues/14) adds large and binary
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
([#121](https://github.com/tyldra-org/falryn/issues/121)); startup recovery
of interrupted writes and export foundations
([#15](https://github.com/tyldra-org/falryn/issues/15)); corruption and
missing-blob detection
([#120](https://github.com/tyldra-org/falryn/issues/120)); viewers and
rendered previews
([#117](https://github.com/tyldra-org/falryn/issues/117)); and the complete
typed artifact API and provenance graph
([#116](https://github.com/tyldra-org/falryn/issues/116)).

The startup recovery introduced by
[#319](https://github.com/tyldra-org/falryn/issues/319) establishes what an
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
[#320](https://github.com/tyldra-org/falryn/issues/320) turn a selection of
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
are owned by [#118](https://github.com/tyldra-org/falryn/issues/118) and
[#119](https://github.com/tyldra-org/falryn/issues/119).

The seams closed by
[#323](https://github.com/tyldra-org/falryn/issues/323) complete two of
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

The test-only harness introduced by
[#31](https://github.com/tyldra-org/falryn/issues/31) exercises the real
readers for `falryn.runtime-event`, `falryn.configuration`, and
`falryn-export/1` against current, additive-future, required-future, and
synthetic-secret malformed inputs. Its source-level negative control discovers
every `*fixtures.ts` and `*fixtures.tsx` module and refuses imports from product
source, while test and fixture support remain available. The harness is not
exported by a product entrypoint and makes no schema-contract or runtime claim.

The integrated persistence walk added by
[#325](https://github.com/tyldra-org/falryn/issues/325) demonstrates the
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
[#326](https://github.com/tyldra-org/falryn/issues/326) turns "resource
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
- **A relative regression comparison is local-only.**
  [#415](https://github.com/tyldra-org/falryn/issues/415) and
  [#418](https://github.com/tyldra-org/falryn/issues/418) delivered the
  measurement and compare tooling (`bun run measure`, `bun run benchmark:compare`,
  and `tools/benchmark-regression.ts`). CI no longer runs that gate: shared-runner
  variance made an advisory job expensive without earning a required check.
  Locally, a comparison builds each exact revision, completes one fixed
  same-revision settling pass immediately before every report in two temporally
  symmetric brackets on one machine: base-first, candidate-first, candidate-second,
  base-second, base-third, candidate-third, candidate-fourth, and base-fourth. The
  outer bracket pools the first and last report of each revision; the inner
  bracket pools the middle pair, so both brackets have both relative orders and
  the same temporal centre. The report profile
  collects 101 migrations, 250 transaction writes, 1,024 range reads, and 21
  compiled-startup samples. Before timing, it discards 21 migrations, 64 turns,
  and 1,024 range reads in that same Bun process, so its p95 is neither one
  cold-run maximum nor a precondition from another process; every ordered array
  and metric warm-up count stays in the artifact. With a fresh
  `FALRYN_MEASURE_REPORT` path, the existing measurement suite atomically writes
  its test-only report only after every real-owner measurement completed; an
  unavailable compiled executable/pseudo-terminal, malformed destination, failed
  measurement, or incomplete suite fails without a report. Each `v4` report
  records its revision, ordered trial, completed settling-pass count, and
  per-metric same-process warm-up sample count. The comparator accepts only
  matching schema, platform, architecture, Bun version, dataset revision/state,
  warm-up/sample count. For each bracket, it pools the two same-revision raw
  sample arrays that span both relative orders before calculating p50 and p95;
  the two pooled base aggregates and two pooled candidate aggregates are the
  same-revision controls. Both controls must remain non-regressing in both
  directions under the same p50-and-p95 rule, and both balanced base/candidate
  brackets must agree. It gates migration time, transaction latency, range-read
  latency, and startup to first draw. A selected metric is a regression when
  both p50 and p95 are at least 50% slower; the gate rejects only when both
  balanced brackets report one. A one-sided control or bracket tail remains a
  bounded diagnostic; a two-sided control regression, missing, malformed,
  incompatible, incomplete-settling, or disagreeing data is a nonzero
  inconclusive result.
  The eight reports are temporary artifacts, never product/runtime/tracked
  output; pooling is a fixed, auditable statistic, not a conditional retry or
  threshold bypass.
  Ordinary CI exposes format, Biome quality, TypeScript, direct-dependency
  integrity, and Bun advisory-audit jobs separately. GitHub-hosted
  `ubuntu-latest` runs the full Linux source and compiled CLI suites;
  `macos-latest` runs the full macOS suite, compiled CLI, and pseudo-terminal
  suites; and `windows-latest` runs the Windows baseline for report-destination
  safety, source ownership, bootstrap, build identity, and platform-root
  behavior, plus a compiled CLI smoke against a `bun-windows-x64` executable
  that must report `win32 x64` and compiled mode. It detects host-path, root,
  and packaging differences only: it is not a shell, terminal, installer,
  signing, or release qualification. The Windows jobs make no pseudo-terminal
  claim, because that suite allocates a pseudo-terminal through libc's
  `openpty` and stays a POSIX qualification.
  Database size, contention, throughput, cadence, memory, and shutdown remain
  diagnostic observations rather than newly invented budgets. Because the base
  predates report emission, CI overlays only this PR's test-only report harness
  into its disposable checkout after building the base source and executable;
  that harness still imports the base data and terminal owners and cannot enter
  the already-built artifact.
- **One platform.** macOS is the only qualified target; measuring on it
  qualifies no other, and a second platform is
  [#220](https://github.com/tyldra-org/falryn/issues/220).
- **Nothing was tuned.** This issue measures. A number that turns out to be bad
  is a new issue, not a silent rewrite.
- **Ungated, `bun test` reports five skipped tests from this module** rather than
  the single one the plan anticipated: Bun records each test inside a false
  `describe.if` as skipped, and the module keeps one explicitly skipped test that
  names `bun run measure`. The measurement is visibly absent either way, which is
  the point.

The process boundary introduced by
[#20](https://github.com/tyldra-org/falryn/issues/20) adds
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
[#17](https://github.com/tyldra-org/falryn/issues/17) makes `falryn` a real
executable. It adds the yargs tree, global options, dispatch, the
`CommandResult` contract, a service factory, and the `config`, `data`, and `doctor`
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
- **only `config`, `data`, and `doctor` are declared.** Every other group named in
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
  [#344](https://github.com/tyldra-org/falryn/issues/344) a source that
  exists and could not be read is reported rather than silently skipped, which
  is described below;
- **`doctor` describes without creating.** It names each root and the database
  path, and reads the database with `create: false` — so asking whether one
  exists never creates it. A fresh root reports `absent`; after a bootstrap it
  reports the schema version it carries. Since
  [#342](https://github.com/tyldra-org/falryn/issues/342) it also probes
  each root's *viability*, which is described below;
- **`--version` names the build**: version, Bun, platform, architecture, and
  whether the run is source or compiled, detected from the `$bunfs` module root
  a standalone executable mounts; and
- **the CLI area restates nothing it consumes.** Controls assert it authors no
  SQL, imports no database driver, touches no filesystem module directly,
  declares one parser, and writes no second precedence, redaction, or
  profile-name rule.

The human and quiet projections introduced by
[#18](https://github.com/tyldra-org/falryn/issues/18) render that result.
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

`config`, `data`, and `doctor` produce results in v0.1, so the renderer is
exercised against those payloads plus fixtures covering the outcome, certainty,
and failure matrix. It has not been proven against a rich command surface.

The machine projections introduced by
[#19](https://github.com/tyldra-org/falryn/issues/19) complete the four
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
[#342](https://github.com/tyldra-org/falryn/issues/342) added after
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
[#344](https://github.com/tyldra-org/falryn/issues/344) added after
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
[#345](https://github.com/tyldra-org/falryn/issues/345) added after
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
[#22](https://github.com/tyldra-org/falryn/issues/22). `react` is `19.2.8`
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

The shell's renderer configuration is explicit: every interactive run uses
`screenMode: "alternate-screen"` with `externalOutputMode: "passthrough"`.
OpenTUI restores the user’s original main-screen scrollback on `destroy()`.
`exitOnCtrlC: false` with `exitSignals: []` installs no `SIGINT` or `SIGTERM`
listener at all, measured beside a default renderer that installs one of each,
so signal handling stays entirely with `src/cli/invocation-scope.ts`.
`createCliRenderer` itself costs about 4 ms; the compiled *process* starts about
170 ms slower than `bun run`, which is the standalone executable's own cost and
not the renderer's.

The interactive shell exists, delivered by
[#23](https://github.com/tyldra-org/falryn/issues/23). `falryn` with no
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

**The interactive shell can be configured**
([#390](https://github.com/tyldra-org/falryn/issues/390)). Until now it
could not: a run that opened the shell read no settings at all, so a key
declared in `src/config/keys.ts` had no way to reach anything the interface
does. `src/cli/shell-configuration.ts` is the path, and it runs *after* the
launch decision and *before* the renderer — after, because the property that a
declined run constructs nothing is worth keeping and this must not spend it;
before, because the diagnostic handle is an ordinary terminal until a renderer is
up and not one afterwards, which is the same reason the unrecognized-override
notice is written where it is.

The refusal control is now two factories rather than one: a renderer that throws
if called, and a service provider that throws if asked. A declined run reaching
either would be a run that built a registry, a loader, and a data layout to
discover it should not have.

Every outcome that is not a usable generation follows one rule. `load` answers
five ways; two carry a record and its `values` open the shell, and the other
three report on the diagnostic handle and hand back `registry.defaults()`, which
the registry documents as complete by construction. A shell that refused to open
over a settings file would be the worse failure — it strands a user with no way
to correct the file that stranded them.

One rule, three sentences, because only one of the three means the user's
configuration was bad. `rejected` is composition failing, and its sentence comes
from `fromConfigurationIssues`, so it is the one `config show` would have printed
for the same issue; no rejected value reaches it, because none of the fourteen
issue variants carries one. `publish-failed` is composition *succeeding* and the
generation failing to be recorded, so it says the configuration was valid and
could not be recorded, and carries the outcome's `code` — the only detail
available to act on. `cancelled` says the load was stopped, which is not a
failure of anything.

All three are reachable on a first load, `publish-failed` included: the loader's
`unchanged` branch is guarded on there being a previous generation, so a first
load falls through to appending the generation event, where an unwritable or
full state root fails. This was first written claiming `rejected` was the only
one reachable there, which gave the other two a sentence telling a user with a
perfectly good settings file that it could not be loaded. Verification of
[#395](https://github.com/tyldra-org/falryn/pull/395) found it.

What crosses into the shell is `ConfigurationValues` — values, not a service, so
nothing in the interface can reach back for a key that was never resolved, and
`src/tui` keeps importing from `src/domain` alone. Precedence is not restated:
the launch path passes the same `configurationOverridesFor` map and the same
profile a command passes, so `falryn --verbose` means one thing either way.

Nothing reads a key yet. This is the path, not a setting, and the first
interface key arrives with
[#392](https://github.com/tyldra-org/falryn/issues/392).

The capability record in `src/tui/capabilities.ts` extends the domain's facts
and recomputes none of them: colour, character repertoire, TTY status, and size
are carried verbatim from `terminalCapabilities()`. What it adds is dumb,
multiplexer, remote, and CI hints derived from the environment, the documented
`FALRYN_TUI` override, and — once a renderer exists — the facts only a renderer
can report. It carries a generation and its detection provenance, so "not
observed yet" stays distinguishable from "not supported". `FALRYN_TUI` accepts
`off`; a value this build does not understand is reported and then ignored rather
than treated as a refusal, so a typo cannot lock a user out. An interactive run
always uses the alternate screen.

Four OpenTUI defaults are overridden, each for a reason #22 measured or the
architecture already owns: `exitOnCtrlC: false` and `exitSignals: []` leave
interrupt and signals with `src/application/interruption.ts` and
`createProcessSignalPort`, `consoleMode: "disabled"` keeps diagnostics on the
stderr boundary, and mouse reporting is gated rather than left at OpenTUI's
default of on.

**The interface takes pointer input, and only where it is wanted**
([#392](https://github.com/tyldra-org/falryn/issues/392),
[#393](https://github.com/tyldra-org/falryn/issues/393)). OpenTUI's
textarea owns primary-press focus and placement, collapsed selections, drag
selection, and pointer auto-scroll. Falryn neither maps a terminal cell to text
nor stores a second cursor, anchor, range, geometry, or drag model.

Falryn's one pointer-specific rule is a pure, transient repeated-press sequence
driven by the composed invocation clock. A second primary press at one `x`/`y`
cell no more than 400 ms after the first invokes the textarea's native word
motions; the third invokes its native logical-line motions; the fourth begins a
new first-press cycle. A different cell, backward clock, non-primary press, or
drag clears the sequence. The first press remains native placement, so
wide-character, punctuation, CJK, and drag behavior retain the renderable's
semantics.

Turning reporting on takes text selection away from the terminal emulator:
dragging selects inside Falryn, and the emulator's own selection needs a
modifier bypass that differs per emulator. That cost is paid by every user of
the default, so it is a declared setting rather than a consequence.
`interface.pointer.enabled` is the `interface` group's first key — the group was
proposed until something read it — it defaults to on, and `FALRYN_POINTER` is
the escape hatch that needs no settings file. `coerce` accepts exactly `true`
and `false` for a boolean, so `FALRYN_POINTER=0` is an invalid value reported as
an issue rather than read as off, and the documentation says so.

**There is no terminal mouse capability, and the plan for this assumed there
was.** #392 was planned around creating the renderer with reporting off,
refreshing the record, and enabling it once the record said the terminal had a
mouse. `TerminalCapabilities` declares no such field — kitty keyboard, colour,
unicode, focus tracking, sync, bracketed paste, hyperlinks, OSC 52, remote,
multiplexer, and no mouse — and `observeRenderer` records `mouse:
renderer.useMouse`, which is this program's own setting reflected back. Gating on
it would have been circular and the feature would never have enabled once. So
the gate is the two things that are real: the user asked for it, and the terminal
is not a dumb one. The launch decision has already refused every run whose
handles are not a terminal, so a renderer only exists where there is one to
report into. The ordering the plan called for, and the restoration-report
divergence it would have required, both went away with the capability that was
never there.

The shell reads exactly one key. `ShellRunRequest` carries the resolved values
from [#390](https://github.com/tyldra-org/falryn/issues/390) and
`src/tui/shell.tsx` projects one boolean out of them; `src/tui` imports nothing
from `src/config`. Anything that is not `true` is off, absence included — a
caller that composed no service graph resolved no configuration, and turning a
user's terminal selection over to Falryn is not something to infer from a
missing value. `src/config/keys.test.ts` asserts the registry declares the path
the interface reads, because the string lives in two places.

`alternate-screen` is the sole delivered interactive mode. It gives the shell
the complete viewport and keeps stdout in passthrough mode; transcript rows stay
inside the live interface and are not committed to terminal scrollback.

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

The walk is driven a step at a time now
([#375](https://github.com/tyldra-org/falryn/issues/375)), so both overlays
are opened *and* closed, the composer is typed into and its submission answered,
and the terminal is resized under the running shell. Each step returns the bytes
it drew, because a pseudo-terminal's transcript is cumulative: "Help" stays in it
forever once the overlay has been open, so asserting that something closed needs
the step and not the whole run. A step can also carry more than one frame — a
resize repaints at the old size before re-laying out at the new one — so the
assertion is on the frame the step settled on, found by splitting on the
synchronized-update sequence.

Compiled steps can also be fed through `@xterm/headless`
([#384](https://github.com/tyldra-org/falryn/issues/384)) so an assertion can
name the screen a terminal would show — which row a string landed on, and
whether two exclusive region marks shared a cell — rather than only the bytes
that were emitted. The emulator is a `devDependency` reached from
`src/tui/emulated-screen-fixtures.ts` alone and held out of every shipping
graph; a synthetic overlapping transcript fails the mixed-mark check, and the
compiled walk asserts the empty shell's header, primary, and status landmarks
do not share a row. The same walk also requalifies the activity rail against the
status line at 157×70 and the widths either side of it
([#385](https://github.com/tyldra-org/falryn/issues/385)).

Resizing goes through `stty`, which was measured rather than chosen: `ioctl` is
variadic, and calling it through Bun's fixed-arity FFI segfaults the process on
arm64, exactly as this file's own comment predicted. `stty` reaches
`TIOCSWINSZ` from a real C program, and the size change is verified by reading
it back. The kernel signals the foreground process group of a *controlling*
terminal and a spawned child has none, so the walk delivers the `SIGWINCH` the
kernel would have; that half is the operating system's, not Falryn's. At 44
columns the shell drops the header's labels for their values and puts them back
when the terminal grows, which is the layout class following the terminal rather
than latching.

Restoration is asserted on every path the walk drives, through one function
rather than a copy of the loop per check — the copies are how three of the four
new paths first shipped asserting an exit status and nothing about the terminal
they left behind. Removing `renderer.destroy()` from the restoration path fails
ten of the walk's checks.

The negative a check names is chosen by measuring rather than by reading. The
first version of the help check asserted that a closed overlay had not drawn
`"Close overlay"` — a real command title, but one the help list truncates before
reaching at thirty rows, so it appeared in neither the open state nor the closed
one and the check passed against nothing. The panel's own title discriminates:
pointed at the step that opened the overlay it fails, where the old predicate
passes. The compiled walk already uses that measured negative; the rendered
interaction suite now does too
([#381](https://github.com/tyldra-org/falryn/issues/381)), including the palette
route's `"Commands"` mark.

A row that could not run reports itself skipped and never as an empty passing
check. With `dist/falryn` absent the file reports fourteen skips where it
reported one — the shared interrupt run was started while the `describe` body
was evaluated, which `describe.if(false)` still does, so it threw and the
remaining checks were never registered at all. With `stty` unavailable the
resize row and its explanation are both skips, and the run drops from twelve
passing checks to eleven rather than substituting a green tick for the row.

`integration` joined `RUNTIME_EMITTED_CATEGORIES`, so exit code `5` is now
reachable: a renderer that could not start is a dependency this run needed and
did not have. `dist/falryn` grew from 64,568,930 to 75,054,050 bytes — the
OpenTUI native library and the React reconciler are now genuinely part of what
ships, which is the deliberate change #22's byte-identical result was measuring
the absence of.

The shell has a visual vocabulary and a frame, delivered by
[#24](https://github.com/tyldra-org/falryn/issues/24).

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

Layout classes are a pure function of the full measured viewport: `compact`,
`standard`, `wide`, or a notice naming the size the terminal needs. Row space is
shared by need before weight, so a short branch name does not cost a long
workspace path the room it was not going to use.

The frame is `AppShell`, `WorkspaceHeader`, `StatusLine`, an overlay host, and
the help and command-palette routes it mounts. Each field of the header carries
its own condition — known, partial, loading, empty, error, cancelled, or
unavailable — and today three of the four are `unavailable` on every real run
with the reason attached, because no producer of sessions, models, or Git state
exists. Values that come from outside Falryn are escaped before they are drawn,
so a workspace path cannot forge a line.

Overlay reveal is driven by OpenTUI's `useTimeline`, so animation lifecycle
and frame scheduling stay with the renderer. The route remains mounted while its
container reveals, preserving focused-control state. Reduced motion skips the
timeline and renders the final dimensions on the first committed frame; it is
enabled by request, for a dumb terminal, and in CI.

`FALRYN_THEME` selects a variant and `FALRYN_MOTION=off` removes transitions,
beside `FALRYN_TUI` from #23. Refusing colour does not reduce motion: they are
different requests.

The sole interactive renderer configuration constructs an alternate-screen
session with passthrough stdout. Both its in-memory construction test and the
compiled pseudo-terminal walk assert that it enters and restores the alternate
screen; no unused screen-mode fallback remains reachable.

A renderer failure now carries its cause onto the diagnostic line rather than
only the sentence saying one occurred. The detail is the bounded, redacted one
the error already held; the raw thrown value still never reaches a handle.

Three checks were added for the class of defect rather than the instance: a
construction test over every declared mode, a compiled run on a terminal too
short for a footer and one per override mode, and a control asserting that
`capturesStdout` has a product caller at all.

The shell is operable from the keyboard, delivered by
[#26](https://github.com/tyldra-org/falryn/issues/26).

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

Help and the palette are rendered from the command registry rather than a
maintained table, showing each command's effective OpenTUI binding and its
unavailability reason. The keymap bridge declares commands and context bindings
through OpenTUI's `useBindings`; help derives effective bindings from
`useActiveKeys`, and palette selection executes the selected command through
`runCommand`. Falryn still validates registry conflicts and controls which
semantic contexts are active, but it no longer reimplements binding resolution.

Help content lives in a focused OpenTUI `<scrollbox>`, which owns viewport
clipping and keyboard scrolling. The command palette uses OpenTUI `<input>` for
its query and `<select>` for option selection, descriptions, navigation, and
scroll indicators. Falryn owns only the route query, command filtering, and
dispatch. Closing the palette replaces the route and therefore clears the query
by construction.

While the palette input is focused, background transcript and composer contexts
are absent. Up and Down are forwarded to the select renderable because the input
keeps terminal focus; selection state and movement still remain OpenTUI's. The
composer's submit and newline bindings are advertised by the keymap but pass
through to the focused textarea, preventing an application layer from consuming
Enter or Shift+Enter before the built-in editor can act.

The renderer explicitly requests Kitty keyboard modifier reporting. OpenTUI's
textarea owns Command/Super line and buffer movement and Option/Alt word
movement, including Shift selection variants. Legacy terminal aliases remain
compatible: `ctrl+a` / `ctrl+e` move to line boundaries, and
`ctrl+home` / `ctrl+end` move to draft boundaries. This matters in terminals
such as Ghostty that translate Command+Left/Right before the application sees
the key; Falryn no longer reinterprets that translated `ctrl+a` as Select All.
Command+A remains OpenTUI's Super+A Select All binding when the terminal reports
Super directly.

A rendered check settles on what was painted rather than on a non-empty
buffer ([#372](https://github.com/tyldra-org/falryn/issues/372)). A test
renderer's buffer before anything draws into it is `U+0A00` in every cell, not
whitespace, so the old `frame.trim() !== ""` accepted it as a finished frame
whenever a capture won the race against the first paint — about one full-suite
run in four. The random failure was the mild half: an unpainted buffer also
satisfies a negative assertion, and one check in that file asserted only a
negative, so on those runs it passed against nothing. The predicate now requires
a painted buffer, the helper throws instead of handing back the last capture,
and the negative-only check names something that must be present as well.

Every rendered check now mounts through one harness
([#374](https://github.com/tyldra-org/falryn/issues/374)). Nine test files
each declared their own live-renderer list, teardown hook, mount, and settle;
that is why #372's correction reached one of them and left the other eight
settling by a fixed flush count. `src/tui/harness.tsx` owns all four, and
teardown is a `using` disposable rather than an `afterEach` — Bun evaluates an
imported module once for the whole run, so a hook registered there would have
covered whichever file loaded first and nothing else. Disposal unmounts the
React tree with `flushSync` before destroying the renderer, which makes a
released subscription observable immediately instead of on a later tick, and
`src/tui/harness.test.tsx` asserts destruction, unmounting, and release with a
deliberately leaked renderer as the negative control. `bun test src/tui` fell
from 65.6s to about 49s, because settling now stops when the frame stops
changing instead of always sleeping eighty milliseconds.

Text is checked through a painted frame and not only against a string. The
arithmetic in `src/domain/text-display.ts` was proved against strings; measuring
it against a buffer found two things. #377 corrected zero-width-joiner emoji:
`displayWidth`, truncation, and wrapping now keep the grapheme whole and measure
it with Bun's renderer-equivalent width primitive, so `U+1F469 U+200D U+1F4BB`
is two cells, as OpenTUI's painted three- and four-column frames prove. #378
made status messages use `Line`'s untrusted-text boundary too, so controls are
escaped before their existing width truncation; painted normal and minimum-size
frames prove the raw sequence never reaches the renderer.

The frame no longer overlaps itself on a short terminal
([#368](https://github.com/tyldra-org/falryn/issues/368)). The overlay host
sized its panel against a two-row reserve — the header and the status line — that
was written before the composer sat between them, while the transcript sized
itself with `primaryRows`, which does subtract the composer. The two regions
disagreed by three rows, so on a twelve-row terminal and below the panel drew
over the composer's notice, and at six rows the status line arrived spliced into
the panel's bottom border as `i━Ready━━━━━━━┛` — the one row an overlay is
promised never to cover. Both regions now measure with the same function, and a
control refuses a second opinion about what the frame costs.

Where the primary region cannot seat a border and a way out, the overlay draws
one plain line naming what is open and how to leave rather than a panel. `Panel`
draws its two border rows whatever height it is given, so asking for one is
asking for an overdraw; drawing nothing instead would make the key that opened
the overlay look broken. An overlay costs the composer's rows now, so a panel of
a given size needs a terminal three rows taller than it did.

Paste is classified before it reaches anything: small text inline, large text as
a bounded preview, and binary, over-long, or invalidly encoded content refused
with the reason. A paste never runs a command.

The keyboard journey is proved twice — through a real renderer with a real
keymap, and against the shipped `dist/falryn` on a pseudo-terminal, where Ctrl+C
now exits `0` with the terminal restored and `?` draws the command table.

Terminal resource behavior and qualification are recorded by
[#376](https://github.com/tyldra-org/falryn/issues/376). `bun run measure`
gates six measurements outside the ordinary fast checks: compiled startup to
first draw and native render cadence, plus harness input latency under stream
load, event-loop delay, long-transcript memory growth, and renderer shutdown.
Each result names its platform, dataset, sample count, state, and distribution;
no performance threshold is asserted. A mounted burst check proves that
coalescing preserves every declared terminal outcome and fails under a negative
control that drops one terminal event. `src/tui/matrix-fixtures.ts` declares
the machine-readable row owners, and the boundary test proves each named test
still exists without claiming that the inventory itself ran those tests.

The current compiled *pseudo-terminal* qualification is scoped to macOS arm64.
The compiled *CLI* smoke now also runs on Linux x64 and Windows x64, where the
Windows job builds a `bun-windows-x64` executable and asserts the identity it
reports. Terminal behavior on Linux and Windows, other operating systems and
architectures, suspend/resume,
clipboard, RTL/mixed text, and multiplexer/remote sessions remain explicitly
unqualified; the companion terminal document records the emulator metadata,
interaction limitations, and manual-session boundary.

A transcript exists as a contract, delivered by
[#354](https://github.com/tyldra-org/falryn/issues/354), and as a rendered
surface over it, delivered by
[#355](https://github.com/tyldra-org/falryn/issues/355).

**Nothing produces a block yet.** The surface is real and the projection it
renders is empty on every run, because no agent loop, provider, or tool runner
emits an event that becomes one. The activity rail and the status line are a
separate case and no longer share it: they are fed from the scope tree and the
shutdown coordinator the invocation already composed
([#358](https://github.com/tyldra-org/falryn/issues/358) built the
projection, [#370](https://github.com/tyldra-org/falryn/issues/370)
connected it). What a user sees in the transcript today is its empty state,
which names a command the build actually runs; every other behavior below is
exercised against fixtures and a real renderer rather than against live output.

A transcript block is a semantic object, not a log line. Sixteen kinds are
declared as a closed union, and **five of them have a producer**: `notice`,
`turn-outcome`, `model-outcome`, `tool-request`, and `tool-result`, derived from
the eight runtime event kinds that exist. The other eleven — model text and
reasoning, tool progress, process stream and exit, file change, repository
activity, task progress, artifact, and diagnostic — are declared and exercised by
fixtures only, because no agent loop, provider, tool runner, or process boundary
emits them. A test asserts the count of five, so a sixth producer cannot appear
without this file being wrong.

An unrecognized kind is never mapped onto one of those sixteen.
[#250](https://github.com/tyldra-org/falryn/issues/250) admits it as a typed
`unknown` fallback: Falryn-owned summary, bounded observed kind, no copied
payload, and no inferred outcome. `unknown` is not a seventeenth semantic
producer kind.

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
text. [#251](https://github.com/tyldra-org/falryn/issues/251) keeps those sums
in a prefix-sum index, so the visible range is a binary search rather than a
walk, and `reconcileHeights` rematerializes only a changed suffix: a 10_000-block
append or last-block revision examines the new or changed heights, not the
unchanged prefix. Off-window collapsed blocks stay counted, not built into rows.
Only blocks the reader has expanded are measured by wrapping, through the
bounded text cache that #24 delivered and nothing had used until now. A rendered
check mounts ten thousand blocks into a 24-row terminal and asserts the number of
renderables in the tree stays under two hundred and within four of the same frame
over a hundred blocks — OpenTUI's own `ScrollBox` is deliberately not used,
because its viewport culling skips render calls while still mounting a renderable
per item.

**Stream paints wait; input does not.** Folding still runs on every event.
[#252](https://github.com/tyldra-org/falryn/issues/252) adds a publish gate
between that fold and a React commit: display-only activity updates share a
one-frame cadence, while a command, a composer edit, a palette query, a newly
cancelling lifecycle, a shutdown change, or a new terminal outcome publishes
immediately and takes any held stream snapshot with it. Time comes from the
invocation `ClockPort`, not from `Date.now` or a second `requestAnimationFrame`.
A burst of openings paints fewer times than events; swallowing a terminal
outcome still fails the mounted oracle. The live shell still does not feed
`reduceTranscript` — that remains later.

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
command, and a control walks the union to prove it. Opening an artifact stays
unavailable with its own reason, because no artifact viewer exists.
[#254](https://github.com/tyldra-org/falryn/issues/254) makes showing
diagnostics the same overlay as `transcript.inspect` when the selected block is
a tool, process, reasoning, or error entry and carries a non-completed outcome.
The inspector is a view over facts the block already carries: it does not infer
success from output text, does not occupy the wide layout's activity rail, and
does not persist after close. A secret block stays inspectable — summary and
kind visible, payload withheld. Fixture kinds without a live producer remain
inspectable from the shared corpus. Searching the transcript is still
unavailable and was not delivered here.

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
viewer, and no inspection of user-input, model-text, file-change, repository,
task-progress, notice, artifact, unknown, or outcome-only kinds. Duration is
reported as a block's age relative
to the transcript's newest block rather than as an elapsed time, because a block
carries one timestamp that a revision replaces — the start of a tool call is not
in the projection, and reporting one would be a number the surface invented.

### Transcript lifetime

Transcript projections render inside the alternate-screen interface for the
session lifetime. Falryn does not write to the terminal's main-screen scrollback
or capture stdout as a second transcript path. Nothing produces a transcript
entry in a real session yet; mounted-surface tests continue to protect its
in-screen projection.

### The composer

The composer is a real control: it accepts multiline Unicode text, keeps a
history, preserves a draft, and resolves every submission through one declared
port ([#357](https://github.com/tyldra-org/falryn/issues/357)). The editing
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
[#33](https://github.com/tyldra-org/falryn/issues/33) and a repair route
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

Attachments, including a large paste, and explicit `@` mentions are real
([#278](https://github.com/tyldra-org/falryn/issues/278)). Composer state holds
typed handles — kind, identity, status, counts, digest — never paste or file
bytes. A held-out preview paste can be included from the palette; the body
stays on a session payload port so include does not re-read the clipboard.
`@path` tokens resolve through the workspace path binder; TOCTOU re-stat at
submit marks changed, stale, or inaccessible files. Unresolved or blocking
attachments refuse send with a repair route. Command completion, suggestion
popups, and a retained artifact catalog remain declared with the reason each
producer is missing. Explicit prompt enhancement is a palette command
([#279](https://github.com/tyldra-org/falryn/issues/279)): local normalization
returns an editable proposal bound to the draft revision, accept is the only
replacement, and a model path is `unavailable` until a provider exists. It
never submits. [#253](https://github.com/tyldra-org/falryn/issues/253)
keeps held-out paste as a notice-sized record: preview and refused pastes do
not retain the clipboard body on composer state, the two chrome rows do not
claim to be showing lines they cannot draw, and secret-shaped held-out paste is
marked rather than refused. Mounted backspace removes a combining cluster, a
regional-indicator flag, and a ZWJ sequence as one character each — OpenTUI
owns that motion; Falryn does not keep a second grapheme editor.

**The composer is OpenTUI's `TextareaRenderable`**
([#399](https://github.com/tyldra-org/falryn/issues/399)). The draft, the
cursor, the selection, the scrolling, and every motion over them belong to the
renderable, reached through the `<textarea>` element `@opentui/react` exposes.
Falryn supplies the frame, the two chrome rows, and only its narrow product
policies.

When its native selection is non-empty, the composer passes the resolved
semantic `selection` background and `foreground` tokens to that renderable and
the first fixed chrome row says `Selection active`
([#397](https://github.com/tyldra-org/falryn/issues/397)). The range can
span multiple drawn lines and the renderer retains its cursor at the selection
focus. At no-colour depth Falryn omits those colour props and keeps the words,
leaving OpenTUI to paint its fallback rather than inventing a grey. Rendered
checks drive the textarea's native keyboard and pointer selection paths, inspect
styled spans and the cursor coordinate, cover an explicit multi-line range,
monochrome, and collapse; the normal repository checks and compiled build pass
for this change.

[#393](https://github.com/tyldra-org/falryn/issues/393) adds native
double-press word selection and triple-press logical-line selection without
adding a Falryn selection model. Its pure click-sequence policy receives only
the invocation clock and terminal cell; the view performs the documented native
motions after OpenTUI has placed and focused the textarea. Rendered controls
compare word starts, middles, ends, punctuation, and CJK plus first, middle,
final, and empty logical lines with the same native sequences, while a
multi-line drag remains native and resets the count.

**Why, and it is not an off-by-one.** The cursor was drawn in the wrong cell on
a real terminal — a row above the draft and a cell short of the text. The
composer drew its own rows and then re-derived where the cursor belonged from a
box origin, a display-width sum, and a window offset. The specific fault:
`setCursorPosition` is **one-based**, and the placement wrote `screenX + cell`
and `screenY + row`, which are the renderable's **zero-based** coordinates.

Every check agreed with it. The rendered checks compared *differences* between
two cursor positions, where a constant offset cancels; the one absolute check
compared the cursor against the same zero-based row the code had used. The
0→1 behaviour had even been measured during #386 and written up as "the renderer
clamps `x` to a minimum of one" — the evidence was in hand and filed under the
wrong explanation. Correcting the base would have left Falryn maintaining a
coordinate the renderable already computes, which is the arrangement that
produced the divergence, so the arrangement went instead.

**Deleted:** `composer/geometry.ts` and its checks, `useCursorPlacement`, the
hand-written motion matcher, and the boundary control naming the mapping. #386,
#391, #392's coordinate half, and #387 are superseded in whole or in part — work
that merged this week. Each was a second implementation of something the
renderable owns.

**What stayed Falryn's.** History recall, through `onKeyDown`: a focused
renderable runs its key listener before its own handling and honours
`preventDefault()`, so at the draft's edge the event is claimed and a recall
dispatched, and anywhere else the textarea moves the cursor. `up` and `down`
lost their registry bindings for this to work — measured, not assumed: with them
bound the keymap claimed the key first and the cursor never moved a line at all.
The commands stay listed and reachable from the palette. And paste, because a
paste too large to inline is classified and refused before the renderable would
insert it; `usePaste` runs ahead of renderable handlers and `preventDefault()`
stops them.

**The required check is on a real terminal**, because the defect was invisible
to every other kind. The compiled artifact is driven on a pseudo-terminal and
the cursor-position sequence the terminal received is compared against the one
that preceded the typed text — both read from the transcript, neither computed.
It was validated by reintroducing the defect, and the first attempt failed to
reproduce it: placing the cursor by hand *beside* the renderable still passes,
because the renderable places it again afterwards. The faithful mutant
suppresses the renderable's own cursor and writes a zero-based coordinate, and
that one fails.

**Non-inline pastes are visible.** The composer classifies a paste before the
renderable sees it. Preview-sized and refused input stays out of the buffer and
the second status row explains what happened, so a missing payload cannot look
like a frozen terminal. The notice says the paste was not inserted; it does not
claim the chrome is showing a preview the two reserved rows cannot hold.

**Text editing belongs to OpenTUI.** The React `<textarea>` owns the buffer,
cursor, selection, wrapping, scrolling, and text motion. Falryn extends
`defaultTextareaKeyBindings` only with documented `TextareaAction` values for
Home, End, buffer bounds, and selection. The only behavioral seam is submission
history: `onKeyDown` intercepts bare Up or Down at the corresponding draft edge
and otherwise lets the focused textarea handle the key.

The deleted editor reducer and geometry modules no longer duplicate OpenTUI.
Falryn stores the textarea's reported plain text for submission and recovery,
but it does not maintain a second cursor, selection, viewport, grapheme-motion,
or screen-coordinate model. Cursor placement is therefore emitted by the same
renderable that paints the text, including on wide and joined characters.

The composer's height is reserved by the layout rather than chosen by the view,
and its chrome is a fixed two rows. The transcript sizes its own window from what
is left, so the two numbers come from one function: a composer that drew one row
more than the layout reserved overdrew the transcript's last line, which is a
defect this delivery hit and fixed rather than a hypothetical.

Nothing can answer a prompt, so no submission is ever accepted in a real session.
The accepted path is exercised by handing the runtime a port that accepts.

### Confirmations and sensitive input

[#255](https://github.com/tyldra-org/falryn/issues/255) adds a focused
confirmation overlay and a protected secret field. The sheet is a named overlay
route on every layout class — it is not the wide layout's activity rail — and
it projects one immutable intent: operation, exact target, why confirmation is
needed, expected effect, alternatives (cancel, plus preview/narrow/export named
as unavailable), once-only scope, and expiry. Domain policy already binds a
confirmation id to capability + normalized input
([#50](https://github.com/tyldra-org/falryn/issues/50)); the TUI records
accept, refuse, or stale against that identity and does not execute tools.

`confirmation.accept` and `confirmation.deny` stay unbound in the registry. The
sheet binds labelled keys to *this* confirmation (`y`/`n` when there is no
secret field; Return to accept while a secret field is capturing). Palette
dispatch still works while a prompt is pending. Escape on the sheet refuses.
Opening help or the palette keeps the pending identity; Escape there restores
the sheet rather than accepting. A changed fingerprint leaves the bound
question on screen and makes accept unavailable.

Secret prompts use a dedicated masked control because installed OpenTUI Input
has no password echo. The value lives in a process ref — not in the overlay
route, composer draft or history, transcript, notices, or clipboard. The frame
draws a bullet (or ASCII asterisk) per grapheme. Paste into the field is
captured and masked, never forwarded to the composer. Empty secret cannot
accept. Nothing produces a live confirmation or credential write in a real
session yet; the port is fixture-driven, like inspection before a live turn.

### Context, model, session, and resource controls

[#256](https://github.com/tyldra-org/falryn/issues/256) adds a focused overlay
for session, model, context, and resource facts. The sheet is a named overlay
route on every layout class — it is not the wide layout's activity rail — and
it projects catalogs the application port supplies. Session and model panels
list those options; Return records a process-local cursor and updates the
header. Context and resource panels list labelled facts (token/byte/item
budgets; scopes/memory/usage). Empty lists name the gap. A cursor whose id has
vanished is an error, not a reused label.

`session.switch`, `model.select`, `context.show`, and `resource.show` are
palette commands with no default key. `session.new` is listed and unavailable
(`no session producer yet`): creating a durable session is
[#33](https://github.com/tyldra-org/falryn/issues/33). Escape closes the sheet
and restores a pending confirmation rather than accepting it. Nothing is
written to SQLite and no provider is called. A real interactive run still
passes an empty catalog; fixtures drive the lists, like inspection and
confirmation before a live turn.

### Activity, status, and projection recovery

The activity rail projects the semantic state the runtime actually owns, and the
status line projects one health level from it
([#358](https://github.com/tyldra-org/falryn/issues/358)). Both are pure
data derived in `src/presentation/activity/`; the rail is the one persistent
contextual surface a `wide` layout gets, and narrower layouts draw none rather
than a squeezed one. The rail is height-bounded and clips to the rows the layout
reserved; its empty state and overflow notice cannot both appear for the same
budget, and the notice is drawn only beside at least one counted entry
([#385](https://github.com/tyldra-org/falryn/issues/385)).

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

The shell reads the runtime it is running inside
([#370](https://github.com/tyldra-org/falryn/issues/370)). Until then the
projection was correct, fixture-proved, and unreached: `reduceActivity` and
`resubscribeActivity` had no product caller, the rail rendered the empty value,
and the status line reported that no runtime was attached while the shell was
holding a shutdown coordinator its own health module counts as attached — the
same shape as #364's unreachable matcher, except that this one stated something
untrue rather than merely doing nothing.

The scope tree and the coordinator reach the projection through a feed of three
read-only questions: the events so far, a subscription, and what the shutdown
coordinator says. A view holding the tree could cancel a scope, and a status
line able to stop work is one that eventually stops the wrong work; a boundary
control names the two modules allowed to see a `ScopeTree` and refuses any
component reaching a mutating method.

Subscribing and staying subscribed call different functions. The first read is a
resubscription — resume from the cursor, or rebuild past one recorded under
another generation — and every read after it folds onto the projection already
held, because `resubscribeActivity` starts from an empty entry set by design and
calling it twice would discard everything applied in between.

What a real run now reports is the runtime's own answer rather than `unknown`:
the tree's root scope and the invocation under it are both live, so a resting
session says two operations are running and drops to one when the invocation
settles. The scheduler, the queue, and the configuration generation are still
absent and still reported as absent — the honesty #358 built, applied to the
real answer.

Nothing produces an agent, provider, or tool-runner scope yet, so what the rail
shows is the shell's own lifecycle rather than work a user asked for. The richer
sequences are exercised by folding fixture events through the same adapter.

The compiled file is a development bootstrap artifact. It is not a supported
Falryn product binary or release. A separate compiled probe confirmed that a
`SIGINT` delivered to a Bun standalone executable reaches the runtime lifecycle,
cancels the root scope, and runs all ten shutdown phases to a `completed`
outcome. That probe remains manual; the storage smoke check described above is
the first automated compiled-executable check, and it runs under `bun run ci`
rather than `bun run check`, because `bun run check` does not build.

The provider boundary introduced by
[#34](https://github.com/tyldra-org/falryn/issues/34) adds a new source area at
`src/providers/` behind `src/providers/index.ts`. It owns the
`falryn.provider-boundary` schema family (`schemaVersion` `1`): normalized
model requests and messages, provider stream event kinds, failure vocabulary,
public model roles / work intents, Zod parsers that report path/code only, and
the `ProviderAdapterPort` surface. The area imports `src/domain` and Zod only.

Its verified behavior:

- a request carries branded `requestId` / `providerId` / `modelId`, bounded
  messages and tool definitions, an output contract, budgets, and role metadata;
  unknown keys and empty message lists are refused;
- stream events are a closed discriminated union (`request-started`, text and
  reasoning deltas, tool-call delta and proposal, usage, provider metadata,
  finished, error) with one-based sequence and terminal detection;
- usage provenance distinguishes provider-reported values, estimates, and
  unknown — missing usage is not treated as zero;
- diagnostic redaction replaces bearer tokens and api-key shaped text wholesale;
- a deterministic in-memory adapter streams success, scripted failure, and
  pre-aborted cancellation without network, credentials, or a vendor SDK; and
- boundary controls keep providers off CLI/TUI/SQLite/SDK imports and keep
  domain modules from importing providers.

No live vendor adapter, OAuth browser flow, remote HTTP discovery against a
real network, or agent-loop consumer is shipped. Those remain later
authentication write/OAuth and agent-loop work.

The provider authentication, profile configuration, and capability discovery
slice from [#35](https://github.com/tyldra-org/falryn/issues/35) extends
`src/providers/` with:

- immutable `ProviderProfile` values (adapter kind, endpoint, credential
  reference, timeouts, enabled models, discovery policy) parsed by Zod, with
  plaintext credentials refused without echoing secrets;
- authentication snapshots (`unconfigured`, `resolving`, `ready`, and failure
  states) established through the existing `SecretResolverPort` so secrets are
  visible only inside the resolve callback and never retained on the snapshot;
- local credential removal that reports remote provider revocation separately
  (remote remains `not-attempted` until OAuth adapters exist);
- static model capability catalogs from enabled models, plus an injectable
  remote discovery port with provenance/expiry (deterministic double for tests,
  no live vendor HTTP); and
- `openProviderSession` as the public vertical entry that combines profile, auth,
  and discovery into one typed outcome.

The stream normalization slice from
[#36](https://github.com/tyldra-org/falryn/issues/36) adds
`ProviderStreamAssembler` and `normalizeProviderStream` in `src/providers/`:

- one-based sequence integrity and request/attempt identity checks;
- fragmented text and reasoning assembly for model-facing continuation, with
  declared size bounds;
- tool-call delta assembly into validated JSON-object proposals;
- usage aggregation that preserves provenance and leaves missing usage as
  `null` rather than zero;
- termination on duplicate terminals, incomplete tool calls, malformed tool
  JSON, and missing terminal events, with structural diagnostics that never
  echo payloads; and
- an async normalizer that yields accepted events and returns an exhaustive
  finished/failed terminal.

Live vendor stream parsers and agent-loop consumption remain later issues.

The model roles, intent routing, compatibility, and fallback slice from
[#37](https://github.com/tyldra-org/falryn/issues/37) extends `src/providers/`
with:

- `ModelPolicy` / `RoleRoute` types and Zod parse (`parseModelPolicy`), including
  reasoning effort, budgets, ordered fallbacks, and vision/advisor/compact `use`
  flags;
- the design-table default intent → role map (`DEFAULT_INTENT_ROLE_MAP`);
- `resolveModelRoute` / `resolveNextFallback`: explicit selection, intent-mapped
  or role-policy primary routes, catalog capability filtering, and ordered
  fallback with a visited-set non-recursion proof; and
- a `RoutingReceipt` on every selection (role, intent, selection reason, required
  capabilities, provider/model, reasoning, fallback position, budgets, catalog
  generation/provenance).

The specialized role support slice from
[#38](https://github.com/tyldra-org/falryn/issues/38) extends that library path
with:

- `resolveSpecializedRole` / requirement defaults in `role-support.ts` for
  vision `use: fallback | always | off` (image escalation; fail closed when
  off or unconfigured), compact `use: evaluated | off` for compression/memory,
  and fast-edit/read defaults (`tools` / `streaming` as appropriate);
- reasoning-effort binding surfaced on routing receipts and helpers for
  deep/plan thinking workloads (no live vendor thinking streams); and
- `resolveModelRoute` applying those defaults before catalog compatibility.

Live health/circuit scoring, cost pricing, vendor adapters, and agent-loop
consumption remain later.

The provider contract / conformance slice from
[#39](https://github.com/tyldra-org/falryn/issues/39) adds
`src/providers/provider-conformance.test.ts` and extends the deterministic
fixture adapter so the public `src/providers/index.ts` boundary is exercised
without live vendor HTTP:

- request translation and schema reject paths that never echo secrets;
- classified `ProviderFailure` scripts (authentication, rate-limit, timeout,
  invalid-request, provider-safety) with explicit retryability;
- pre-start and mid-stream cancellation, plus timeout classification;
- fragmented text/reasoning/tool JSON assembly through `normalizeProviderStream`,
  finish reasons, and usage provenance that keeps missing usage as `null`
  (never invented zeros);
- missing-terminal adapter-defect handling;
- discovery catalog provenance and modality fields via static/remote doubles;
- routing receipts with ordered non-recursive fallback; and
- diagnostic redaction for bearer/api-key shaped text.

Opt-in live network tests stay out of `bun run check`. No new Bun compiled
provider packaging was added; existing compiled probes cover other boundaries.

The session and turn state-machine slice from
[#41](https://github.com/tyldra-org/falryn/issues/41) adds domain transition
tables and in-memory coordinators without prompt composition, provider streams,
tool loops, retry/fallback policy, or durable turn-event persistence:

- `src/domain/session-lifecycle.ts` — bootstrap → ready → active-turn /
  recovering → draining → closed with named commands and schema-versioned
  observations;
- `src/domain/turn-machine.ts` — UNIFIED-RUNTIME turn phases through
  evaluating-completion, exhaustive terminal outcomes, cancellation during
  capability execution → `uncertain`, and recovery under a new runtime
  generation; and
- `src/application/session-runtime.ts` / `turn-coordinator.ts` as the public
  in-memory entry points.

The deterministic prompt-composition slice from
[#42](https://github.com/tyldra-org/falryn/issues/42) adds pure provider-neutral
request assembly for the turn loop's `assembling-context` stage without live
provider streaming, tool execution, retry/fallback, or durable turn-event
persistence:

- `src/domain/prompt-composition.ts` — fixed section-role precedence (product
  invariants through Brief), structured tool definitions, stable ordering,
  budget/exclusion receipt, exhaustive typed outcomes for missing/empty/
  oversized/unavailable/budget-exceeded pieces, and a canonical form for
  identity; and
- `src/application/prompt-composer.ts` — digests that canonical form through an
  injected `ContentHasherPort` and binds compose to a named turn identity.

Validated by `src/domain/prompt-composition.test.ts` and
`src/application/prompt-composer.test.ts` under `bun run check`.

The provider-stream consumption slice from
[#43](https://github.com/tyldra-org/falryn/issues/43) adds the agent-loop
consumer that pulls normalized provider streams with ordering and backpressure,
without tool execution, retry/fallback, or durable turn-event persistence:

- `src/application/provider-stream-consumer.ts` — consumes adapter events through
  existing `normalizeProviderStream` / `ProviderStreamAssembler` (sequence
  integrity from #36), admits them into a bounded queue that coalesces
  display-only text/reasoning deltas and rejects semantic overflow (no unbounded
  buffer), drives the turn coordinator from `assembling-context` /
  `awaiting-model` into `handling-model-event`, and returns exhaustive typed
  outcomes (`finished`, `failed`, `malformed`, `cancelled`, `timed-out`,
  `partial`, `backpressure-rejected`, `turn-error`); tool proposals leave the
  turn active at `handling-model-event` for the tool-call loop.

Validated by `src/application/provider-stream-consumer.test.ts` under
`bun run check`, using the deterministic provider adapter fixtures.

The iterative tool-call slice from
[#44](https://github.com/tyldra-org/falryn/issues/44) executes validated tool
proposals with cancellation and bounded loops, without retry/fallback policy or
durable persist/replay:

- `src/domain/tool-pipeline.ts` — provider-neutral proposals, immutable catalog
  descriptors with effect class and Zod input schemas, bind/validate that fails
  closed on unknown tools, malformed input, duplicates, and queue bounds, plus
  exhaustive per-invocation outcomes and effect folding;
- `src/application/tool-call-loop.ts` — drives the turn coordinator through
  `executing-capability` (and optional `cycle-to-model` iterations), executes
  only through a narrow `ToolRunnerPort`, aborts in-flight tools and awaits
  cleanup before reporting, enforces max iterations / concurrency / per-iteration
  queue bounds, and returns exhaustive typed loop outcomes (`completed`,
  `cancelled`, `timed-out`, `failed`, `uncertain`, `denied`, `malformed`,
  `unavailable`, `partial`, `bound-exceeded`, `turn-error`).

Validated by `src/domain/tool-pipeline.test.ts` and
`src/application/tool-call-loop.test.ts` under `bun run check`, using
deterministic catalog and runner doubles.

The retry/fallback/refusal/partial/terminal slice from
[#45](https://github.com/tyldra-org/falryn/issues/45) classifies attempt
failures and settles turns with bounded retry and non-recursive fallback,
without durable persist/replay:

- `src/domain/attempt-policy.ts` — provider-neutral attempt facts, exhaustive
  classification (`completed`, `refusal`, `partial`, `cancelled`, `timed-out`,
  `uncertain`, `failed`, `may-retry-same`, `may-fallback`), action decisions
  composed with `evaluateRetry`, and mapping onto turn-machine terminals;
- `src/application/turn-attempt-policy.ts` — orchestrates visible attempt
  identity, bounded same-route retry with backoff, `#37` `resolveNextFallback`
  with a visited set (no route recursion), typed refusal/partial outcomes, and
  turn recovery under a new generation between settled attempts; runners are
  injected (`AttemptRunnerPort`) so stream/tool loops stay behind the seam.

Validated by `src/domain/attempt-policy.test.ts` and
`src/application/turn-attempt-policy.test.ts` under `bun run check`, using
deterministic route catalogs and scripted attempt runners.

The persist/replay slice from
[#46](https://github.com/tyldra-org/falryn/issues/46) records turn lifecycle
facts through the existing event-store path and rebuilds turn views without
repeating effects:

- `src/domain/turn-events.ts` — stable fact identity (event id + idempotency
  key), builders onto the closed runtime-event union, pure `reduceTurnEvents`,
  and `classifyTurnReplay` for empty / corrupt / rebuilt streams via
  `inspectReplay`;
- `src/application/turn-event-journal.ts` — appends facts through
  `EventStorePort` (duplicate receipts on retry), discovers stream sequence,
  and returns exhaustive replay outcomes (`rebuilt`, `empty`, `turn-missing`,
  `corrupt`, `partial`, `cancelled`, `store-error`) without calling providers
  or tool runners; optional journal wiring on `turn-attempt-policy` records
  turn/attempt terminals as facts.

Validated by `src/domain/turn-events.test.ts`,
`src/application/turn-event-journal.test.ts`, and the journal wiring case in
`src/application/turn-attempt-policy.test.ts` under `bun run check`.

The tool manifest and capability-registry slice from
[#48](https://github.com/tyldra-org/falryn/issues/48) defines stable tool
identities, manifests, schemas, capability kinds, and effect classes for one
immutable catalog generation (parent [#47](https://github.com/tyldra-org/falryn/issues/47)):

- `src/domain/tool-registry.ts` — `ToolIdentity` encode/decode into branded
  `CapabilityId` (`source:namespace/name@version`), Zod validation of untrusted
  `ToolManifestDocument` values (no rejected field values in errors), trusted
  `ToolManifest` / `ToolRegistryEntry` construction with input and output Zod
  schemas, and `createToolRegistry` that fails closed on duplicate catalog
  names, duplicate capability ids, and non-builtin shadowing of builtins; the
  registry exposes a `ToolCatalog` for the existing #44 bind path;
- effect classes remain the closed `observation | mutation | external |
  interactive` union from `work.ts`, declared on every manifest.

Validated by `src/domain/tool-registry.test.ts` (including a bind-path seam
into `bindToolProposals`) under `bun run check`.

The validate-and-normalize-before-dispatch slice from
[#49](https://github.com/tyldra-org/falryn/issues/49) takes raw tool proposals,
validates them against the #48 registry manifests/schemas, and produces an
immutable dispatch-ready form (parent [#47](https://github.com/tyldra-org/falryn/issues/47)):

- `src/domain/tool-invocation.ts` — `validateAndNormalizeInvocations` fails
  closed on unknown tools, malformed arguments/schema input, duplicate or
  invalid call ids, queue bounds, unsupported platform/version, input byte
  limits, and illegal path arguments; normalizes path-like fields; projects to
  the #44 `BoundToolInvocation` shape via `toBoundToolInvocation` without
  executing tools.

Validated by `src/domain/tool-invocation.test.ts` (including a registry → bind
seam) under `bun run check`.

The policy / effect-classification / focused-confirmation slice from
[#50](https://github.com/tyldra-org/falryn/issues/50) decides allow, deny, or
require focused confirmation on each #49 dispatch-ready invocation before any
schedule or execute stage (parent [#47](https://github.com/tyldra-org/falryn/issues/47)):

- `src/domain/tool-policy.ts` — classifies the closed #44/#48 effect classes into
  confirmation posture; `evaluateToolPolicy` fails closed on deny lists and
  invalid effects; consequential classes (`mutation`, `external`, `interactive`)
  require a confirmation id bound to capability + normalized input fingerprint;
  `resolveFocusedConfirmation` / `authorizeToolInvocation` report observed
  confirmation status separately from requested intent and never claim an
  execution effect at this stage (`effect: "none"` until later runners run).

Validated by `src/domain/tool-policy.test.ts` under `bun run check`.

The schedule / execute / cancel / timeout / join slice from
[#51](https://github.com/tyldra-org/falryn/issues/51) runs
policy-authorized invocations through the existing scheduler and a narrow
`ToolRunnerPort` (parent [#47](https://github.com/tyldra-org/falryn/issues/47)):

- `src/domain/tool-schedule.ts` — `planToolSchedule` fails closed on empty
  batches, duplicates, unknown nested edges, cycles, and queue bounds, then
  maps each `PolicyAuthorizedInvocation` onto a `WorkUnit` with declared
  conflict keys, dependencies, and join policy (`all` | `fail-fast` |
  `partial`);
- `src/application/tool-work-scheduler.ts` — `createToolWorkScheduler` executes
  only through `ToolRunnerPort`, serializes conflict keys, joins dependents,
  cancels and times out in-flight work, and reports exhaustive per-invocation
  outcomes without claiming a completed mutation after abort. Lifecycle hook
  points are #53 (`tool-hooks.ts` / `tool-hook-runner.ts`).

Validated by `src/domain/tool-schedule.test.ts` and
`src/application/tool-work-scheduler.test.ts` under `bun run check`.

The typed result / uncertainty / diagnostics / artifact-handle slice from
[#52](https://github.com/tyldra-org/falryn/issues/52) assembles a
`CapabilityResult` after that execution (parent
[#47](https://github.com/tyldra-org/falryn/issues/47)):

- `src/domain/tool-result.ts` — `assembleCapabilityResult` validates output
  against the trusted result schema, requires committed required artifacts for
  `completed`, stops a completion claim on persistence failure, keeps effect
  status when capture overflows, and distinguishes a contained process exit
  from tool-result status; `projectCapabilityResult` builds a bounded redacted
  model view without replacing the canonical envelope;
- `src/application/tool-result-envelope.ts` — `envelopeToolResult` applies the
  runtime `SensitiveValueRedactor` at that projection seam. Product adapters,
  artifact-store ingest, and TUI/CLI wiring remain later owners.

Validated by `src/domain/tool-result.test.ts` and
`src/application/tool-result-envelope.test.ts` under `bun run check`.

The lifecycle hook-point slice from
[#53](https://github.com/tyldra-org/falryn/issues/53) exposes named
capability-invocation points without execution bypasses (parent
[#47](https://github.com/tyldra-org/falryn/issues/47)):

- `src/domain/tool-hooks.ts` — built-in TypeScript registration only;
  `before-capability-invocation` is fail-closed and `after-capability-invocation`
  is fail-open; the immutable envelope carries ids, generations, deadline,
  recursion/re-entry, and validated payload, never a runner or secrets;
  transform key conflicts fail visibly; `ToolLifecycleFact` notifications do
  not widen `EVENT_KINDS`;
- `src/application/tool-hook-runner.ts` — runs ordered hooks against the clock
  timeout budget. A pre deny/timeout/throw does not invoke `ToolRunnerPort`.
  Post decisions cannot rewrite completed, failed, cancelled, timed-out, or
  uncertain terminals.

Validated by `src/domain/tool-hooks.test.ts`,
`src/application/tool-hook-runner.test.ts`, and
`src/application/tool-pipeline-seam.test.ts` under `bun run check`.

The workspace path bind slice from
[#55](https://github.com/tyldra-org/falryn/issues/55) keeps tool paths inside
one explicit workspace root (parent
[#54](https://github.com/tyldra-org/falryn/issues/54)):

- `src/domain/workspace-path.ts` — `bindWorkspacePath` resolves workspace-relative
  logical paths against a `LocalPath` root, refuses `..` escape, prefix tricks,
  NUL, and unscoped absolute paths, and never echoes rejected text;
- `src/application/workspace-path.ts` — `createWorkspacePathBinder` re-checks
  `FileSystemPort.realPath` so a symlink cannot leave the root. Missing paths
  keep the lexical bind. Listing is #280. Glob discovery is #62. Text search is
  #63. Index query is #64. Index builders remain later work.

Validated by `src/domain/workspace-path.test.ts` and
`src/application/workspace-path.test.ts` under `bun run check`.

The workspace listing slice from
[#280](https://github.com/tyldra-org/falryn/issues/280) stats, lists one
directory, and walks a tree inside that same root:

- `src/domain/workspace-listing.ts` — entry, limit, hidden-name, and truncation
  contracts;
- `src/application/workspace-listing.ts` — `createWorkspaceListing` binds the
  caller path, uses `FileSystemPort.stat` / `list` without reading bytes, never
  descends through a symlink, and stops on entry or depth budgets.

Validated by `src/domain/workspace-listing.test.ts` and
`src/application/workspace-listing.test.ts` under `bun run check`.

The bounded path and glob discovery slice from
[#62](https://github.com/tyldra-org/falryn/issues/62) finds workspace paths by
include/exclude glob without reading file bytes (parent
[#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-glob.ts` — gitignore/ripgrep-shaped glob compile and
  match, hidden/kind/exclude filters, match/walk/depth limits, and typed
  malformed glob/limit errors that never echo rejected text;
- `src/application/workspace-discovery.ts` — `createWorkspaceDiscovery` binds
  the start path, reuses `createWorkspaceListing.walk`, never descends through
  a symlink, and truncates with `match-limit`, `entry-limit`, or `depth-limit`.

Validated by `src/domain/workspace-glob.test.ts` and
`src/application/workspace-discovery.test.ts` under `bun run check`. Text
search is #63. Index query is #64. Index builders, `read_many` glob
expansion, and product search tools remain later work.

The bounded text-search slice from
[#63](https://github.com/tyldra-org/falryn/issues/63) finds literal and regex
matches inside that same root (parent
[#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-search.ts` — query compile, glob filters, match/walk/
  depth/output budgets, 1-based line/column hits, and typed malformed errors
  that never echo rejected text;
- `src/application/workspace-search.ts` — `createWorkspaceTextSearch` prefers
  supervised `rg` through `CommandRunnerPort` when an absolute executable is
  supplied (`--no-config`, `--no-ignore`, empty environment, no `PATH`). Spawn
  failure or an omitted executable uses a TypeScript walk+read fallback that
  never invokes `rg`. Hidden and binary files are off unless requested. Descent
  never follows a symlink. Engine and fallback reason are visible.

Validated by `src/domain/workspace-search.test.ts` and
`src/application/workspace-search.test.ts` under `bun run check`. Index query
is #64. Index builders, patches, ignore-file consumption, `read_many` glob
expansion, and product search tools remain later children.

The bounded structural and derived-index query slice from
[#64](https://github.com/tyldra-org/falryn/issues/64) queries one atomic index
generation inside that same root (parent
[#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-index.ts` — structural/lexical queries, glob filters,
  lifecycle states, per-hit freshness, match budgets, and typed malformed
  errors that never echo rejected text;
- `src/application/workspace-index.ts` — `createWorkspaceIndexQuery` reads an
  injectable `WorkspaceIndexPort` snapshot, binds every hit, and compares
  `PathEntry.revision` so a stale index can guide discovery without being
  presented as current evidence. Absent, building, corrupt, and unavailable
  generations are typed errors. Descent never follows an escaping index path.

Validated by `src/domain/workspace-index.test.ts` and
`src/application/workspace-index.test.ts` under `bun run check`. Semantic
retrieval is #65. Index builders, watchers, Tree-sitter, SQLite FTS
persistence, patches, and product search tools remain later work.

The bounded semantic retrieval and context-pack search slice from
[#65](https://github.com/tyldra-org/falryn/issues/65) ranks index records
inside that same root (parent
[#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-retrieval.ts` — lexical/structural/semantic scores,
  hybrid fusion that keeps those scores separate, privacy destinations,
  diversity, bounded context-pack assembly, and typed malformed errors that
  never echo rejected text;
- `src/application/workspace-retrieval.ts` — `createWorkspaceRetrieval` reads
  the #64 index generation, optionally scores an injectable `EmbeddingPort`
  plus embedding corpus, falls back to deterministic lower tiers when
  embeddings are unavailable, destination-denied, mismatched, or below
  baseline, and freshness-tags hits like #64. Remote embedding requires
  opt-in. Live providers, vector persistence, the context planner, and product
  tools remain later work.

Validated by `src/domain/workspace-retrieval.test.ts` and
`src/application/workspace-retrieval.test.ts` under `bun run check`. Index
builders, watchers, Tree-sitter, SQLite FTS persistence, and product search
tools remain later work.

The evidence-candidate admission slice from
[#82](https://github.com/tyldra-org/falryn/issues/82) defines the planner's
admitted evidence contract (parent
[#81](https://github.com/tyldra-org/falryn/issues/81)):

- `src/domain/context-evidence.ts` — stable `EvidenceId`, source kind, origin,
  workspace/scope, inline or artifact payload, byte/token estimates, freshness,
  sensitivity, trust, fidelity, lineage, relationships, retrieval cost, and
  exact-source / expansion handles;
- admission refuses malformed, unsupported, oversized, restricted, missing
  exact-source, fidelity-upgrade, and wrong-workspace candidates with a typed
  reason that never echoes rejected text;
- stale freshness stays `stale`. Exact-source fidelity requires a digest
  handle. Expansion never upgrades extractive or lossy fidelity. `#65`
  `ContextPack` remains a retrieval-pack input, not this type.

Validated by `src/domain/context-evidence.test.ts` under `bun run check`.
Pack composition exists for #85. Expansion/cache exists for #86. The planner
and product context tools remain later work.

The context budget slice from
[#83](https://github.com/tyldra-org/falryn/issues/83) reserves provider output
and tool-framing tokens before filling admitted evidence (parent
[#81](https://github.com/tyldra-org/falryn/issues/81)):

- `src/domain/context-budget.ts` — total token/byte/item/latency caps, per-item
  and per-source-class limits, model/support/local destinations, and
  insufficient-context recoveries;
- output and tool framing are reserved first. Under pressure, duplicates are
  removed, expansion-bearing items are deferred, and extractive/lossy
  projections are dropped before overflow is omitted. Excerpts are not
  rewritten. Restricted and destination-ineligible items never enter the fill;
- estimated tokens are never mixed with provider-reported counts.

Validated by `src/domain/context-budget.test.ts` under `bun run check`.
Pack composition exists for #85. Expansion/cache exists for #86. The planner
and product context tools remain later work.

The context ranking slice from
[#84](https://github.com/tyldra-org/falryn/issues/84) scores admitted evidence
and returns a stable ordered selection (parent
[#81](https://github.com/tyldra-org/falryn/issues/81)):

- `src/domain/context-rank.ts` — instruction/source-kind priority, origin query
  match, freshness, trust, fidelity, pinning, recent use, workspace match,
  relationship, destination eligibility, inverted retrieval/token cost, and
  per-origin diversity;
- query matching uses origin only. Explanations list contributing signals and
  never echo origin or payload text. Selected order is the caller order for
  `#83` budget fill;
- pack composition exists for #85. Expansion/cache exists for #86. The planner
  and product context tools remain later work.

Validated by `src/domain/context-rank.test.ts` under `bun run check`.
The planner and product context tools remain later work.

The context pack composition slice from
[#85](https://github.com/tyldra-org/falryn/issues/85) ranks, budgets, then
emits a bounded planner pack with citations and uncertainty (parent
[#81](https://github.com/tyldra-org/falryn/issues/81)):

- `src/domain/context-compose.ts` — `composeContextPack` assigns `primary` to
  the first included item and `support` to later items. Citations record id,
  origin, source kind, freshness, original fidelity, and exact-source or
  expansion handles. Uncertainty is a closed set (`stale`, `inferred`,
  `untrusted`, `extractive`, `lossy`, `narrowed`, `insufficient`);
- support inline text over the excerpt bound is truncated on a UTF-8 boundary
  and never claims exact-source. Primary payloads and artifact payloads are
  not rewritten. `#65` `ContextPack` remains a retrieval-pack input;
- rank and budget omissions are forwarded without echoing origin or payload.
  Expansion/cache exists for #86. The planner and product context tools remain
  later work.

Validated by `src/domain/context-compose.test.ts` under `bun run check`.
The planner and product context tools remain later work.

The context expansion and cache slice from
[#86](https://github.com/tyldra-org/falryn/issues/86) verifies exact-source or
expansion handles, reuses keyed projections, and invalidates on digest,
generation, strategy, configuration, destination, or lost-artifact changes
(parent [#81](https://github.com/tyldra-org/falryn/issues/81)):

- `src/domain/context-expand.ts` — `expandContextEvidence` hashes supplied
  bytes through `ContentHasherPort`. A complete verified retrieve is
  `exact-source`; a bounded range is `bounded-excerpt` and never claims
  exact-source. Stale freshness stays `stale`. Restricted content is refused
  and never cached;
- cache keys include digest, generation, strategy version `expand.v1`,
  configuration, destination, offset, length, and max bytes. Digest mismatch
  and quarantined artifacts refuse as `checksum`; missing or reserved bytes
  refuse as `unavailable`. Errors never echo payload;
- Loom manifests, workspace-file expansion (#59), the planner, and product
  context tools remain later work.

Validated by `src/domain/context-expand.test.ts` under `bun run check`.
The planner and product context tools remain later work.

The context scenario inspection slice from
[#87](https://github.com/tyldra-org/falryn/issues/87) classifies admitted
evidence for large-repository overflow, long-session conversation pressure,
stale labels, and conflicting same-origin items (parent
[#81](https://github.com/tyldra-org/falryn/issues/81)):

- `src/domain/context-inspect.ts` — `inspectContextEvidence` reports
  digest-mismatch or freshness-mismatch conflicts by branded id, lists stale
  ids, marks a full `MAX_EVIDENCE_BATCH` as `at-limit`, and flags
  `longSession` at 16 conversation items. Oversized batches refuse without
  dropping items. Reports never echo origin or payload and never merge
  conflicting facts or rewrite stale to live;
- child-seam scenarios in `src/domain/context-engine.test.ts` run admit,
  inspect, rank, budget, compose, and expand together. Rank-limit omissions
  are the continuation for a partial ranking;
- Loom manifests, the planner, and product context tools remain later work.

Validated by `src/domain/context-inspect.test.ts` and
`src/domain/context-engine.test.ts` under `bun run check`.
The planner and product context tools remain later work.

The bounded full-file write and grouped mutation slice from
[#281](https://github.com/tyldra-org/falryn/issues/281) creates or replaces
UTF-8 files inside that same root (parent
[#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-write.ts` — create/replace operations, newline policy,
  digest and revision preconditions, overlap/case-collision detection,
  fail-before-effect vs best-effort policy, per-target outcomes, and typed
  malformed errors that never echo rejected text;
- `src/application/workspace-write.ts` — `createWorkspaceWriter` binds paths,
  refuses escaping symlinks and non-files, creates missing parents for
  `create`, and writes through `FileSystemPort.writeBytes`. The host adapter
  stages a sibling temporary file, fsyncs, and renames. Mid-apply IO failure
  leaves already-applied targets in place; it does not claim rollback.

Validated by `src/domain/workspace-write.test.ts`,
`src/application/workspace-write.test.ts`, and
`src/integrations/host-filesystem.test.ts` under `bun run check`. Product
filesystem tools remain later work.

The bounded move, copy, trash, and remove slice from
[#282](https://github.com/tyldra-org/falryn/issues/282) mutates paths inside
that same root (parent [#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-mutate.ts` — move/copy/remove/trash operations,
  overwrite `error`/`replace`/`merge`, recursive-tree limits, preview plan
  identity, per-entry outcomes, and typed malformed errors that never echo
  rejected text;
- `src/application/workspace-mutate.ts` — `createWorkspaceMutator` binds
  source and destination, refuses escaping dest symlinks and into-self moves,
  previews the exact affected paths, and applies through
  `FileSystemPort.renameEntry` or copy-verify-remove on `cross-device`. Trash
  is a move into an explicit in-workspace directory; there is no OS Recycle
  Bin adapter. Recursion stays in application; the port still has no
  `removeRecursive`. Cancellation keeps already-applied effects. Mid-apply IO
  failure reports partial and unscheduled remaining outcomes and does not
  claim rollback.

Validated by `src/domain/workspace-mutate.test.ts`,
`src/application/workspace-mutate.test.ts`, and
`src/integrations/host-filesystem.test.ts` under `bun run check`. Undo of
move/copy/trash/remove and product filesystem tools remain later work.

The bounded patch hunk preview and apply slice from
[#66](https://github.com/tyldra-org/falryn/issues/66) edits existing files
inside that same root (parent
[#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-patch.ts` — structured hunks (`path`, 1-based
  `oldStart`, exact `oldLines`/`newLines`), digest and filesystem-revision
  preconditions, exact-range-text matching that never relocates a hunk,
  preview plan identity, overlapping-hunk refusal, existing-file newline
  preservation, and typed malformed/conflict errors that never echo rejected
  patch text;
- `src/application/workspace-patch.ts` — `createWorkspacePatcher` (`PatchPort`)
  binds existing files, refuses escaping dests and non-files, previews
  per-hunk ready/conflict headers, and writes staged bytes through
  `FileSystemPort.writeBytes`. Apply revalidates `expectedPlanId`. Grouped
  plans use `fail-before-effect` (default) or `best-effort`. A conflict
  preserves the current file and returns a bounded current-line excerpt.
  Cancellation keeps already-applied targets.

Validated by `src/domain/workspace-patch.test.ts` and
`src/application/workspace-patch.test.ts` under `bun run check`. Git-aware
dirty-tree and conflict preconditions are verified for #77. Product filesystem
tools remain later work.

The bounded patch rollback, changed-region read, and safety-test slice from
[#67](https://github.com/tyldra-org/falryn/issues/67) continues that same root
(parent [#61](https://github.com/tyldra-org/falryn/issues/61)):

- `src/domain/workspace-patch.ts` — best-effort rollback status
  (`not-attempted` / `complete` / `partial` / `failed`), `rolled-back` items,
  `rollback-failed` reasons (`concurrent-change` / `io-failure` / `cancelled`),
  and half-open changed-region reads that never dump whole files;
- `src/application/workspace-patch.ts` — mid-apply IO failure restores
  captured preimages in reverse only when the current digest still matches the
  applied file. Cancellation keeps already-applied targets and does not roll
  them back. `readChangedRegions` rebinds the path and reads exact workspace
  bytes. Rollback is never claimed as guaranteed.

Validated by `src/domain/workspace-patch.test.ts` and
`src/application/workspace-patch.test.ts` under `bun run check`. Git-aware
dirty-tree and conflict preconditions are verified for #77. Undo of
move/copy/trash/remove and product filesystem tools remain later work.

The workspace file-read slice from
[#56](https://github.com/tyldra-org/falryn/issues/56) reads one file or a
bounded concurrent batch inside that same root:

- `src/domain/workspace-read.ts` — numbered lines, line/byte ranges, newline
  facts, read budgets, and bounded binary-byte reads;
- `src/application/workspace-read.ts` — `createWorkspaceReader` binds paths,
  follows in-root symlinks, provides text and binary-byte reads, refuses
  oversized/non-files, and runs `readMany` with canonical dedupe, aggregate
  bytes, and bounded concurrency. Shared source provenance and bounded
  expansion are recorded by #59 below.

Validated by `src/domain/workspace-read.test.ts` and
`src/application/workspace-read.test.ts` under `bun run check`.

The symbol and changed-region reader slice from
[#492](https://github.com/tyldra-org/falryn/issues/492) normalizes derived
language evidence and verifies current source inside that same root:

- `src/domain/language-read.ts` — bounded symbol/changed-region requests,
  provider-neutral locations, document identity, backend generations,
  confidence/fallback, diagnostics, dependencies, omissions, and typed
  unsupported, unavailable, stale, malformed, cancelled, and capped outcomes;
- `src/application/language-read.ts` — `createLanguageReader` keeps the backend
  behind an injectable port, rebinds every returned path, and uses
  `createWorkspaceReader` for exact symbol and changed-region source ranges.
  Provider discovery, Git/open-buffer adapters, and product tool registration
  remain later work. Language-server process lifecycle is #89 below.

Validated by `src/domain/language-read.test.ts` and
`src/application/language-read.test.ts` under `bun run check`.

The language-server lifecycle slice from
[#89](https://github.com/tyldra-org/falryn/issues/89) supervises stdio LSP
processes through the managed-service port:

- `src/domain/language-server.ts` — lifecycle states, initialize/shutdown
  contracts, Falryn-owned Content-Length JSON-RPC framing, limits, and typed
  failure reasons (missing executable, spawn failure, initialize failure,
  malformed transport/response, timeout, crash, restart exhaustion, shutdown
  timeout, cancellation, capacity, stale generation);
- `src/application/language-server.ts` — `createLanguageServerSupervisor`
  starts a managed `lsp` service with immediate readiness, completes
  `initialize` / `initialized`, exposes negotiated capabilities, and performs
  `shutdown` / `exit` plus managed stop. Document sync, feature requests,
  edits-as-patches, and indexes remain later children of #88. Official
  `vscode-jsonrpc` packages remain selected-with-probe and are not in the
  lockfile yet.

Validated by `src/domain/language-server.test.ts`,
`src/application/language-server.test.ts`, and
`src/application/language-server.host.test.ts` (real Bun stdio fixture) under
`bun run check`.

The language-server document synchronization slice from
[#90](https://github.com/tyldra-org/falryn/issues/90) extends that supervisor:

- `src/domain/language-server-sync.ts` — open/change/save/close and
  workspace-folder validation, incremental/full text apply, dynamic capability
  registration parsing, and open-document capacity bounds;
- `src/application/language-server.ts` — `openDocument`, `changeDocument`,
  `saveDocument`, `closeDocument`, and `changeWorkspaceFolders` send the
  matching LSP notifications; stale versions, duplicate opens, and not-ready
  sync fail with typed reasons; `client/registerCapability` /
  `unregisterCapability` are answered and tracked. Feature requests,
  edits-as-patches, and indexes remain later children of #88.

Validated by `src/domain/language-server-sync.test.ts` and the document-sync
cases in `src/application/language-server.test.ts` under `bun run check`.

The language-server feature-request slice from
[#91](https://github.com/tyldra-org/falryn/issues/91) extends that supervisor:

- `src/domain/language-server-features.ts` — hover, definition, references,
  document symbols, completion, and publishDiagnostics parsing with capacity
  caps;
- `src/application/language-server.ts` — `hover`, `definition`, `references`,
  `documentSymbols`, `completion`, and `diagnostics` over open documents;
  method-not-found maps to `unsupported`; diagnostics notifications are stored
  and emitted.

Validated by `src/domain/language-server-features.test.ts` and the feature
cases in `src/application/language-server.test.ts` under `bun run check`.

The language-server edits-as-patches slice from
[#92](https://github.com/tyldra-org/falryn/issues/92) extends that supervisor:

- `src/domain/language-server-edits.ts` — WorkspaceEdit/TextEdit parsing,
  format/rename/codeAction request validation, URI→workspace path mapping, and
  conversion into `ParsedPatchPlan` targets with stale-version and overlap
  rejection; code-action commands are deferred;
- `src/application/language-server.ts` — `formatDocument`, `rename`, and
  `codeActions` request the matching LSP methods and return patch plans without
  applying them or executing commands.

Validated by `src/domain/language-server-edits.test.ts` and the edit cases in
`src/application/language-server.test.ts` under `bun run check`.

The rebuildable SQLite workspace-index slice from
[#93](https://github.com/tyldra-org/falryn/issues/93) builds lexical and symbol
records into a dedicated index database:

- `src/domain/workspace-index-build.ts` — extract symbols/headings/chunks and
  assemble an atomic generation with capacity limits;
- `src/data/workspace-index-schema.ts` / `workspace-index-store.ts` — SQLite
  schema + `openWorkspaceIndexStore` implementing `WorkspaceIndexPort` and
  generation rebuild;
- `src/application/workspace-index-build.ts` — `createWorkspaceIndexBuilder`
  persists a rebuilt generation for the existing #64 query seam.

Validated by `src/domain/workspace-index-build.test.ts` and
`src/data/workspace-index-store.test.ts` under `bun run check`.

The optional-intelligence qualification slice from
[#94](https://github.com/tyldra-org/falryn/issues/94) admits embeddings and
structural parsing only when they clear cheaper lexical/symbol baselines:

- `src/domain/language-intelligence-qualify.ts` — `qualifyEmbeddings` /
  `qualifyStructuralParsing` with typed skip reasons (`unavailable`, `denied`,
  `below-baseline`, `not-justified`, `disabled`);
- `src/domain/workspace-retrieval.ts` — hybrid scoring uses the embeddings
  qualifier against `SEMANTIC_BASELINE` before admitting semantic ranks;
- `src/domain/workspace-index-build.ts` / `src/application/workspace-index-build.ts`
  — optional `StructuralParserPort` runs only after structural qualification;
  build reports count used vs skipped parses. Live Tree-sitter and embedding
  providers remain injectable later work.

Validated by `src/domain/language-intelligence-qualify.test.ts`,
`src/domain/workspace-retrieval.test.ts`, and
`src/application/workspace-index-build.test.ts` under `bun run check`.

The debug-adapter supervision slice from
[#96](https://github.com/tyldra-org/falryn/issues/96) owns DAP lifecycle and
request/response transport over `ManagedServicePort`:

- `src/domain/debug-adapter.ts` — Content-Length DAP framing, initialize /
  disconnect contracts, limits, and typed failure reasons;
- `src/application/debug-adapter.ts` — `createDebugAdapterSupervisor` drives
  `starting → initializing → ready → disconnecting → stopped`, exposes generic
  `request`, and surfaces adapter events. Launch/attach/breakpoints remain #97.

Validated by `src/domain/debug-adapter.test.ts`,
`src/application/debug-adapter.test.ts`, and
`src/application/debug-adapter.host.test.ts` under `bun run check`.

The debug-session lifecycle slice from
[#97](https://github.com/tyldra-org/falryn/issues/97) owns launch/attach,
versioned breakpoints, threads, and stack frames:

- `src/domain/debug-adapter-session.ts` — session mode/target state, breakpoint
  and stack/thread parsing, stopped-generation contracts;
- `src/application/debug-adapter.ts` — `setBreakpoints`, `configurationDone`,
  `launch` / `attachTarget`, `threads`, `stackTrace`, and `continueExecution`
  with stale-generation rejection.

Validated by `src/domain/debug-adapter-session.test.ts` and the session cases
in `src/application/debug-adapter.test.ts` under `bun run check`.

The debug scopes/variables/evaluation slice from
[#98](https://github.com/tyldra-org/falryn/issues/98) owns stopped-generation
scopes, redacted variable and evaluate projections, mutation-aware evaluate
contexts, and bounded DAP output capture:

- `src/domain/debug-adapter-session.ts` — scope/variable/evaluate/output
  parsers, sensitivity heuristics, and model/support redaction helpers;
- `src/application/debug-adapter.ts` — `scopes`, `variables`, `evaluate`, and
  `recentOutputs` on the session snapshot.

Validated by the #98 cases in `src/domain/debug-adapter-session.test.ts` and
`src/application/debug-adapter.test.ts` under `bun run check`.

The debug termination and cleanup slice from
[#99](https://github.com/tyldra-org/falryn/issues/99) owns target terminate,
DAP cancel, disconnect process cleanup, and detach uncertainty:

- `src/domain/debug-adapter-session.ts` — target-exit parsing, disconnect /
  terminate / cancel request validation, and disconnect outcome contracts;
- `src/application/debug-adapter.ts` — `terminate`, `cancel`, idempotent
  `disconnect` with pending cancellation and managed-process stop,
  `detach-uncertain` on unacknowledged detach.

Validated by the #99 cases in `src/domain/debug-adapter-session.test.ts` and
`src/application/debug-adapter.test.ts` under `bun run check`.

The debug artifact and confirmation slice from
[#100](https://github.com/tyldra-org/falryn/issues/100) owns focused confirmation
for consequential DAP actions and bounded session artifact capture:

- `src/domain/debug-adapter-capture.ts` — confirmation request/resolve helpers
  and JSON session artifact encoding with sensitivity labeling;
- `src/application/debug-adapter.ts` — `prepareConfirmation`,
  `captureSessionArtifact`, and confirmation gates on mutating evaluate,
  terminate, and terminating disconnect.

Validated by `src/domain/debug-adapter-capture.test.ts` and the #100 cases in
`src/application/debug-adapter.test.ts` under `bun run check`.

The Brief response-style slice from
[#102](https://github.com/tyldra-org/falryn/issues/102) projects verbosity policy
immediately before inference without choosing evidence, summarizing files, or
compressing incoming context:

- `src/domain/brief.ts` — user/session/interface/default precedence, auto
  verbosity that records the selected level, a strict byte cap, Zod validation
  at the untrusted policy boundary, refusal of task evidence and hidden tool
  calls, refusal of secret-shaped guidance, required-fact preservation at every
  verbosity, concise/expanded snapshots of the same semantic outcome, and a
  receipt for policy source, dimensions, size, placement, and provider-cap
  modification; custom guidance that would overflow is omitted rather than
  dropping required facts; and
- `src/application/brief.ts` — redacts style notes, binds projection to a turn
  identity, and maps the result onto the prompt-composition `brief` section.

Product CLI/TUI Brief controls and Loom product wiring remain later #101 children.
Validated by `src/domain/brief.test.ts` and `src/application/brief.test.ts`
under `bun run check`.

The Hush observation slice from
[#103](https://github.com/tyldra-org/falryn/issues/103) integrates command-family
reduction across shell, Git, test, search, and generic process origins without
registering product tools or creating Loom manifests:

- `src/application/hush.ts` — `createHushIntegrator` captures through the
  injected process-capture port or reduces an already-finished report; origin
  tags select expected families; the capture report is returned unchanged
  beside the Hush projection; model/evidence text is redacted; exact
  passthrough may be admitted as `exact-source`, while reductions and redacted
  text are `deterministic-transform` with an expansion handle and never claim
  exact source.

Validated by `src/application/hush.test.ts` under `bun run check`.

The Loom compress-cache-retrieve slice from
[#104](https://github.com/tyldra-org/falryn/issues/104) commits reversible
segment manifests and retrieves verified members without registering product
tools or implementing product compact-model wiring:

- `src/domain/loom.ts` — `commitLoomManifest` records artifact members with
  digests, protected facts, summaries, and atomic-group recovery;
  `retrieveLoomProjection` verifies digest, scope, retention, and bytes, then
  projects exact, range, head/tail, or search-hits views. Full untruncated
  retrieval is `exact-source`; ranges and omitted head/tail are
  `bounded-excerpt`; search hits are `deterministic-transform`. Restricted
  content is refused and never cached. Cache keys include digest, generation,
  strategy version `loom.v1`, configuration, destination, projection kind, and
  bounds.
- `src/application/loom.ts` — `createLoomPort` ingests members through
  `ArtifactStorePort` and commits a handle only when every required ingest
  succeeds; retrieve loads stored bytes, redacts secret-shaped text, and never
  lets a redacted projection claim exact source. Foreign-scope sharing is
  denied. Manifests are in-memory for this slice.

Validated by `src/domain/loom.test.ts` and `src/application/loom.test.ts`
under `bun run check`.

The structural lossless reducer slice from
[#105](https://github.com/tyldra-org/falryn/issues/105) projects files, diffs,
diagnostics, and tool results without registering product tools:

- `src/domain/structural-reduce.ts` — `reduceStructural` classifies `file`,
  `diff`, `diagnostic`, and `tool` families at version `structural.v1`. JSON
  uses key/schema projection with key, array, and depth caps; tables keep a
  header plus bounded rows; configuration drops comments and blanks; unified
  diffs preserve file order and cap hunks; diagnostics sort errors first and
  never drop every error to keep only warnings; tool envelopes keep status,
  effect, error, artifact ids, and diagnostic codes while walking `value`. A
  projection is kept only when it is smaller than the original bytes; otherwise
  the original is passed through as `exact-source`. Reductions are
  `deterministic-transform` and never claim exact-source. Restricted input is
  refused. Empty or NUL input is refused. Expansion digests the original bytes.
- `src/application/structural-reduce.ts` — `createStructuralReducer` redacts
  secret-shaped text and never lets a redacted projection claim exact-source.
  `structuralToEvidence` admits compact passthrough as `exact-source` and
  reductions as `deterministic-transform` with an expansion handle.

Validated by `src/domain/structural-reduce.test.ts` and
`src/application/structural-reduce.test.ts` under `bun run check`.

The optional compact-model and history checkpoint slice from
[#106](https://github.com/tyldra-org/falryn/issues/106) adds learned compression
and conversation checkpoints without registering product tools or running
fidelity eval:

- `src/domain/compact-model.ts` — `reduceCompact` at version `compact.v1`.
  Evaluated compact-model projections are `extractive-summary` or
  `lossy-synthesis` and never claim exact-source. `off`, unavailable,
  malformed, timed-out, rate-limited, disconnected, refused, empty, oversized,
  or no-savings outcomes fall back to passthrough once; fallback never calls
  the model again. Cancellation and restricted input fail closed. Complete
  passthrough of original bytes is `exact-source`; truncated passthrough is
  `deterministic-transform`.
- `src/domain/history-checkpoint.ts` — `checkpointHistory` records a new
  `HistoryCheckpointId`. Required items (commitments, decisions, unresolved
  questions, task state, tool outcomes, citations, artifacts, uncertainty,
  corrections, skill instruction bodies) stay verbatim. Foldable turn prose may
  use the compact-model lane. The original event identities are listed and the
  event log is not rewritten. Retained sources keep expansion links.
  `retryAfterOverflow` compact-retries once on `prompt-too-long` and fails
  closed on a second consecutive overflow. `previewCompactForSmallerWindow`
  requires a strictly smaller destination window.
- `src/application/compact-lanes.ts` — redacts secret-shaped text and never
  lets a redacted compact-model projection claim exact-source.
  `compactToEvidence` admits passthrough as `exact-source` and model
  projections with an expansion handle.

Validated by `src/domain/compact-model.test.ts`,
`src/domain/history-checkpoint.test.ts`, and
`src/application/compact-lanes.test.ts` under `bun run check`.

The compression evaluation slice from
[#107](https://github.com/tyldra-org/falryn/issues/107) scores Brief, Hush, Loom,
structural, compact-model, and history-checkpoint observations without
registering product tools or calling a live model:

- `src/domain/compression-eval.ts` — `evaluateCompression` at version `eval.v1`.
  Extractive or lossy projections that claim exact-source fail. Missing or
  disagreeing expansion digests fail. Cancelled, restricted, timed-out, and
  stale-cache observations fail closed. Savings subtract overhead and keep one
  token kind. Mixing estimated with provider-reported tokens is refused.
  `evaluateCompressionRun` totals a same-kind batch. Reports contain metrics
  only.
- `src/application/compression-eval.ts` — maps compact, structural, and history
  results onto observations, cancels before scoring, and never puts projection
  text on the report.
- `src/domain/compression-engine.test.ts` — parent seam: compact, structural,
  and history observations scored together.

Validated by `src/domain/compression-eval.test.ts`,
`src/domain/compression-engine.test.ts`, and
`src/application/compression-eval.test.ts` under `bun run check`.

The compact document reader slice from
[#493](https://github.com/tyldra-org/falryn/issues/493) projects bounded exact
workspace text without claiming to be the complete document:

- `src/domain/compact-document-read.ts` — validates outline, explicit range,
  head/tail, and lexical relevant-span requests; classifies source, Markdown,
  configuration, log, and generic text families; extracts deterministic
  heading/symbol paths; and defines omission, budget, and recovery contracts;
- `src/application/compact-document-read.ts` — `createCompactDocumentReader`
  reads through the injected `WorkspaceReader`, preserves bound identity and
  line ranges, applies output budgets, and returns typed empty, partial,
  cancellation, binary, oversized, missing, malformed, and budget-exhausted
  outcomes.

Provider parsing, semantic summarization, product tool registration, and
derived-document interpretation remain later children.
Validated by `src/domain/compact-document-read.test.ts` and
`src/application/compact-document-read.test.ts` under `bun run check`.

The notebook reader slice from
[#494](https://github.com/tyldra-org/falryn/issues/494) parses bounded
versioned `.ipynb` content without executing cells or treating stored output as
fresh:

- `src/domain/notebook-read.ts` — bounded all, index, stable-ID, and cell-range
  requests; notebook format, cell, output, attachment, metadata, diagnostic,
  omission, cancellation, and recovery contracts;
- `src/application/notebook-read.ts` — `createNotebookReader` reads through the
  injected `WorkspaceReader`, preserves notebook/cell/output coordinates,
  execution counts, metadata, bounded MIME previews, attachments, and visible
  malformed/unknown/widget/missing-ID diagnostics.

Output and attachment budgets stop expansion while retaining completed cells.
Kernel execution, artifact spill, mutation, and product tool registration
remain later children. Validated by
`src/domain/notebook-read.test.ts` and
`src/application/notebook-read.test.ts` under `bun run check`.

The PDF reader slice from
[#495](https://github.com/tyldra-org/falryn/issues/495) provides a bounded,
page-aware projection over workspace PDF bytes:

- `src/domain/pdf-read.ts` — explicit page-range and query-selection requests;
  document digest, page count, selected/scanned pages, page/source coordinates,
  extraction, confidence, OCR-required, block, diagnostic, omission, recovery,
  cancellation, and resource-limit contracts;
- `src/application/pdf-read.ts` — `createPdfReader` reads through the injected
  binary-capable `WorkspaceReader`, parses bounded PDF page trees and content
  streams, and keeps text, heuristic tables, links, annotations, and
  embedded-image metadata distinct without invoking OCR or executing content.

Encrypted and malformed documents refuse; unsupported filters, image-only pages,
huge output, decompression-heavy content, cancellation, and page/output/object
budgets remain visible as typed errors, diagnostics, partial results, or
recovery ranges. Validated by `src/domain/pdf-read.test.ts`,
`src/application/pdf-read.test.ts`, `src/application/workspace-read.test.ts`,
and `src/integrations/host-filesystem.test.ts` under `bun run check`.

The image, artifact, and virtual-resource reader slice from
[#58](https://github.com/tyldra-org/falryn/issues/58) adds three explicit
reader seams without registering product tools:

- `src/domain/image-read.ts` and `src/application/image-read.ts` — bounded
  image requests detect PNG, JPEG, GIF, WebP, BMP, and SVG from source bytes;
  preserve media type, dimensions, orientation, color profile, animation,
  loop behavior, and a `sha-256` digest; and return the original encoded visual
  only when source, pixel, frame, metadata, and visual budgets permit it.
  Unsafe SVG, malformed/unsupported formats, cancellation, and partial
  metadata expansion remain visible.
- `src/domain/artifact-read.ts` and `src/application/artifact-read.ts` —
  metadata, bounded preview, and explicit exact-range modes use the injected
  `ArtifactStorePort`, retaining artifact identity, digest, actual offsets,
  returned lengths, and availability errors without touching SQL or blob paths.
- `src/domain/virtual-resource-read.ts` and
  `src/application/virtual-resource-read.ts` — stable non-path resource
  identities use an injected adapter that declares freshness, retention,
  digest, media type, size, and exact-byte availability. Metadata and bounded
  range reads are separate, with identity drift, unavailable bytes, adapter
  failure, overflow, and cancellation typed.

Pixel decoding, OCR, downscaling/format conversion, derived-artifact
materialization, mutation, provider adapters, and product tool registration
remain outside this slice. Validated by
`src/application/image-read.test.ts`,
`src/application/artifact-read.test.ts`, and
`src/application/virtual-resource-read.test.ts` under `bun run check`.

The exact-source, partial-result, limits, and expansion slice from
[#59](https://github.com/tyldra-org/falryn/issues/59) strengthens the shared
workspace reader without registering product tools:

- `src/domain/filesystem.ts` — `PathEntry` carries an adapter-owned revision,
  and `FileSystemPort.readBytesRange` provides bounded positional reads with
  typed range errors. The in-memory filesystem and host adapter implement the
  same contract; host revisions combine inode, size, modification, and change
  metadata.
- `src/domain/workspace-read.ts` — read results preserve requested/resolved
  targets, source identity, revision, original-byte `sha-256` digest, exact
  fidelity, encoding/newline facts, actual ranges, inline byte length,
  completeness, continuation, expansion, and diagnostics. Limits are parsed
  against explicit hard ceilings, and UTF-8, UTF-8 BOM, UTF-16LE, and UTF-16BE
  decoding refuses malformed source rather than inserting replacement text.
- `src/application/workspace-read.ts` — text and binary snapshots read bounded
  inline prefixes, optionally stream the exact source into an injected
  `ArtifactStorePort` under expansion and chunk limits, and retry a changing
  source within a bounded count before returning a typed stale result.
  `readMany` reports aggregate bytes, partial completeness, and whether a limit
  prevented full admission.

Validated by `src/domain/workspace-read.test.ts`,
`src/application/workspace-read.test.ts`, and
`src/integrations/host-filesystem.test.ts` under `bun run check`.

The workspace-reading failure matrix from
[#60](https://github.com/tyldra-org/falryn/issues/60) covers the shared
malformed, stale, binary, large-file, symlink, and cancellation outcomes
without registering product tools:

- `src/application/workspace-path.ts` — a cancelled bind is a typed
  `cancelled` result rather than a filesystem wrap of the adapter abort.
- `src/application/workspace-reading-failure.test.ts` — path bind, listing,
  one-file and multi-file reads, and specialized compact/notebook/PDF/image
  readers share malformed path/limit/range/encoding refusals, stale revisions,
  binary refusals that do not echo secrets, large-file bounds and optional
  artifact expansion, in-root versus escaping symlinks, and cancellation that
  keeps completed `readMany` items.
- `src/application/workspace-reading-host.test.ts` — the same symlink, binary,
  large-file, stale, and cancellation outcomes hold against a real temporary
  directory through `createHostFileSystem`.

Search, `rg` fallback, and product tool registration remain
outside this slice. Validated by
`src/application/workspace-reading-failure.test.ts`,
`src/application/workspace-reading-host.test.ts`,
`src/application/workspace-path.test.ts`,
`src/application/workspace-listing.test.ts`, and
`src/domain/workspace-read.test.ts` under `bun run check`.

## Remaining implementation gaps

The repository now provides end-user behavior for the `config`, `data`, and `doctor`
commands and a working v0.1 OpenTUI shell. The shell owns its renderer, frame,
empty transcript surface, composer, activity rail, status line, overlays, input,
and terminal restoration; it does not yet have a provider, agent loop,
session/turn producer, or live transcript producer. The remaining gaps are:

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
  authentication — is [#35](https://github.com/tyldra-org/falryn/issues/35).
  A credential is placed in the keychain by the user today;
- any composition of the credential resolver. The stores, the resolver, and the
  host command runner exist and are tested, and `src/main.ts` constructs none of
  them, so no real run resolves a credential. The first consumer is #35;
- any *product producer* of a session, turn, model attempt, invocation, or
  transcript event. The
  tables, the typed repositories, the durable event store, and the projection
  cursor all exist and are composed, and nothing in a real run starts a session
  or opens a turn, because the agent loop that would is
  [#33](https://github.com/tyldra-org/falryn/issues/33) and later. Also
  absent: usage accounting and provider routing on a model attempt, which arrive
  with the model path, and read-connection pooling, which stays undecided until
  there are enough real read paths to measure;
- command, human, JSON, JSONL, or terminal rendering for the records described
  above. The shared `SessionView` shape exists so a renderer does not have to
  restate it. The `config`, `data`, and `doctor` commands already use all four headless
  projections, and the OpenTUI shell is delivered as a presentation surface;
  it has no live conversation to render until the producer path owned by
  [#33](https://github.com/tyldra-org/falryn/issues/33) and later work
  exists. The CLI/headless foundation and shell delivery are owned by
  [#16](https://github.com/tyldra-org/falryn/issues/16) and
  [#21](https://github.com/tyldra-org/falryn/issues/21);
- a projection registry. One projection is maintained and its name is a closed
  union of one; a registry for a single member would be a framework built for
  one caller. Deterministic replay, fork, rewind, and reachability garbage
  collection over these rows are each owned elsewhere and none is implemented;
- any *producer* of an artifact. The table, the repository, the store, the blob
  adapter, and the `finalize-artifacts` participant all exist and are composed,
  and nothing in a real run ingests bytes, because the tools and providers that
  would are later work. Also absent from this area: reachability garbage
  collection, export, import, replay, viewers, and the provenance graph, each
  owned by [#15](https://github.com/tyldra-org/falryn/issues/15),
  [#116](https://github.com/tyldra-org/falryn/issues/116),
  [#117](https://github.com/tyldra-org/falryn/issues/117),
  [#120](https://github.com/tyldra-org/falryn/issues/120), or
  [#121](https://github.com/tyldra-org/falryn/issues/121);
- any composition of the configuration loader into a running program.
  `src/main.ts` constructs no loader, so no configuration file is read on a real
  run;
- public local-data behavior beyond `data reset` and `data uninstall`.
  Those command surfaces assemble a complete v0.1 ownership view, always
  render a measured plan first, and only pass a re-derived plan to guarded
  execution when `--confirm` repeats its exact identity. Retention reporting
  and startup reconciliation still have no command surface. The owners that
  will register the remaining ownership classes — memory, extensions — do not
  exist, and each remains reported as unregistered rather than assumed absent;
- headless product behavior beyond `config`, `data`, and `doctor`, or live conversation
  content in the OpenTUI application. The command tree, global options, help,
  version, process boundary, and all four output projections are real. The
  shell is delivered: it renders a workspace header, empty transcript surface,
  multiline composer, activity rail, status line, and overlays, and it handles
  focus, keymap, input, paste, and terminal restoration. No provider, agent
  loop, session/turn producer, or live transcript producer exists yet, so
  submission resolves to `unavailable` and the transcript remains empty.
  Also absent: every command group whose capability does not exist, shell
  completion, and hidden or deprecated command policy beyond its declaration;
-   provider integration beyond the #34–#39 boundary (live vendor adapters,
  OAuth/write flows, network discovery against real endpoints), or product
  workspace/Git/shell tool adapters;
- browser or computer-use capabilities
  (language-server supervision through edits-as-patches and rebuildable SQLite
  lexical/symbol indexes exist for #89–#93; path bind, list/stat/
  walk, bounded file reads, specialized readers, exact-source expansion, the
  shared malformed/stale/binary/large-file/symlink/cancellation matrix, glob
  discovery, bounded text search, derived-index query, writes, mutate, patch
  apply/rollback, supervised argv/Bash, PTY and managed services, process
  capture, Hush reduction, process-tree cancellation, and Git observation plus
  stage/commit/sync exist; product tools are not registered, and Git cannot
  rebase, force-update, or rewrite history);
- context planning, Hush product/CLI/TUI wiring, Loom product wiring, compression,
  index builders, or memory (Brief domain projection exists for #102;
  evidence-candidate admission exists for #82;
  context token/byte/item/latency/sensitivity budgets exist for #83; ranking
  and selection exist for #84; pack composition with citations and
  uncertainty exists for #85; expansion, cache reuse, invalidation, and
  exact retrieval exist for #86; large-repository, long-session, stale, and
  conflicting-evidence inspection exists for #87; Hush domain reduction over
  captured process facts exists for #72; Hush observation across shell, Git,
  test, search, and process output exists for #103; Loom compress-cache-retrieve
  manifests and exact retrieval exist for #104; structural lossless reducers for
  files, diffs, diagnostics, and tools exist for #105; optional compact-model
  and history checkpoint lanes exist for #106; compression fidelity,
  reversibility, latency, and token-savings evaluation exists for #107; none of
  these is wired
  into the planner or product tools);
- MCP, skills, plugin and other hook families, marketplace, agents, jobs, or workflows; or
- an installer, updater, supported platform package, signed release, or support
  channel.

The detailed target contracts for these capabilities live in `falryn-docs`.
Their implementation breakdown lives in GitHub Issues and the Project.

## Planning frontier

- **Live roadmap:** [Falryn Roadmap](https://github.com/orgs/tyldra-org/projects/1)
- **Current release outcome:** [v0.3 Intelligence and Memory](https://github.com/tyldra-org/falryn/issues?q=is%3Aissue%20is%3Aopen%20milestone%3A%22v0.3%20Intelligence%20and%20Memory%22)
- **First parent outcome:** [#1 Establish the unified runtime and lifecycle](https://github.com/tyldra-org/falryn/issues/1)
- **Completed shell parent:** [#21 Deliver the OpenTUI application shell](https://github.com/tyldra-org/falryn/issues/21) is closed and Done. [#16 Deliver the CLI and headless foundation](https://github.com/tyldra-org/falryn/issues/16) is complete.
- **Completed docs reconcile:** [falryn-docs#1](https://github.com/tyldra-org/falryn-docs/issues/1) (Reconcile v0.1 Foundation documentation) is closed and Done via children [#84](https://github.com/tyldra-org/falryn-docs/issues/84)–[#89](https://github.com/tyldra-org/falryn-docs/issues/89); integration landed in [falryn-docs#95](https://github.com/tyldra-org/falryn-docs/pull/95) (`64366c0`).
- **Completed agent turn loop parent:** [#40 Implement the agent turn loop](https://github.com/tyldra-org/falryn/issues/40) is closed and Done. Child [#41 Implement session and turn state machines with exhaustive outcomes](https://github.com/tyldra-org/falryn/issues/41) closed and Done via [PR #461](https://github.com/tyldra-org/falryn/pull/461) (`8c903a4`); docs companion [falryn-docs#102](https://github.com/tyldra-org/falryn-docs/pull/102) (`ccda31d`). Child [#42 Compose system prompts, instructions, tools, and context deterministically](https://github.com/tyldra-org/falryn/issues/42) closed and Done via [PR #463](https://github.com/tyldra-org/falryn/pull/463) (`795341d`); docs companion [falryn-docs#103](https://github.com/tyldra-org/falryn-docs/pull/103) (`63abcb6`). Child [#43 Consume provider streams with ordering and backpressure](https://github.com/tyldra-org/falryn/issues/43) closed and Done via [PR #465](https://github.com/tyldra-org/falryn/pull/465) (`727f3d5`); docs companion [falryn-docs#104](https://github.com/tyldra-org/falryn-docs/pull/104) (`100d7be`). Child [#44 Execute iterative tool calls with cancellation and bounded loops](https://github.com/tyldra-org/falryn/issues/44) closed and Done via [PR #467](https://github.com/tyldra-org/falryn/pull/467) (`bec765b`); docs companion [falryn-docs#105](https://github.com/tyldra-org/falryn-docs/pull/105) (`206e61d`). Child [#45 Implement retry, fallback, refusal, partial, and terminal behavior](https://github.com/tyldra-org/falryn/issues/45) closed and Done via [PR #469](https://github.com/tyldra-org/falryn/pull/469) (`43c5d89`); docs companion [falryn-docs#106](https://github.com/tyldra-org/falryn-docs/pull/106) (`ee56f15`). Child [#46 Persist and replay turn events without repeating effects](https://github.com/tyldra-org/falryn/issues/46) closed and Done via [PR #471](https://github.com/tyldra-org/falryn/pull/471) (`ad05ff5`); docs companion [falryn-docs#107](https://github.com/tyldra-org/falryn-docs/pull/107) (`4f9c02d`). Parent integrated verification passed on `ad05ff5` (97 child-seam tests).
- **Completed tool registry parent:** [#47 Build the unified tool registry and execution pipeline](https://github.com/tyldra-org/falryn/issues/47) is closed and Done. Child [#48 Define tool manifests, schemas, capabilities, effects, and stable identities](https://github.com/tyldra-org/falryn/issues/48) closed and Done via [PR #474](https://github.com/tyldra-org/falryn/pull/474) (`3a297ad`); docs companion [falryn-docs#108](https://github.com/tyldra-org/falryn-docs/pull/108) (`de8c753`). Child [#49 Validate and normalize every invocation before dispatch](https://github.com/tyldra-org/falryn/issues/49) closed and Done via [PR #476](https://github.com/tyldra-org/falryn/pull/476) (`0766b1d`); docs companion [falryn-docs#109](https://github.com/tyldra-org/falryn-docs/pull/109) (`2d2c0fa`). Child [#50 Implement policy, effect classification, and focused confirmation](https://github.com/tyldra-org/falryn/issues/50) closed and Done via [PR #478](https://github.com/tyldra-org/falryn/pull/478) (`823ca6c`); docs companion [falryn-docs#110](https://github.com/tyldra-org/falryn-docs/pull/110) (`7ca9c83`). Child [#51 Schedule, execute, cancel, time out, and join tool work](https://github.com/tyldra-org/falryn/issues/51) closed and Done via [PR #480](https://github.com/tyldra-org/falryn/pull/480) (`2e8238d`); docs companion [falryn-docs#111](https://github.com/tyldra-org/falryn-docs/pull/111) (`ac5315f`). Child [#52 Return typed results, uncertainty, diagnostics, and artifacts](https://github.com/tyldra-org/falryn/issues/52) closed and Done via [PR #482](https://github.com/tyldra-org/falryn/pull/482) (`2c08925`); docs companion [falryn-docs#112](https://github.com/tyldra-org/falryn-docs/pull/112) (`03b762e`). Child [#53 Expose lifecycle events and hook points without execution bypasses](https://github.com/tyldra-org/falryn/issues/53) closed and Done via [PR #484](https://github.com/tyldra-org/falryn/pull/484) (`336cd2c`); docs companion [falryn-docs#113](https://github.com/tyldra-org/falryn-docs/pull/113) (`1656399`). Parent integrated verification passed on `336cd2c` (91 child-seam tests).
- **Completed workspace reading parent:** [#54 Deliver workspace reading and retrieval](https://github.com/tyldra-org/falryn/issues/54) is closed and Done. Child [#55 Implement workspace roots, path normalization, and boundary safety](https://github.com/tyldra-org/falryn/issues/55) closed and Done via [PR #486](https://github.com/tyldra-org/falryn/pull/486) (`46d7685`); docs companion [falryn-docs#114](https://github.com/tyldra-org/falryn-docs/pull/114) (`842f660`). Child [#280 Implement bounded list, stat, and workspace traversal](https://github.com/tyldra-org/falryn/issues/280) closed and Done via [PR #488](https://github.com/tyldra-org/falryn/pull/488) (`b148357`); docs companion [falryn-docs#115](https://github.com/tyldra-org/falryn-docs/pull/115) (`b8f041d`). Child [#56 Implement exact one-file and bounded concurrent multi-file reads](https://github.com/tyldra-org/falryn/issues/56) closed and Done via [PR #490](https://github.com/tyldra-org/falryn/pull/490) (`02c35ea`); docs companion [falryn-docs#116](https://github.com/tyldra-org/falryn-docs/pull/116) (`cbd696d`). Child [#57 Implement symbol, changed-region, document, notebook, and PDF readers](https://github.com/tyldra-org/falryn/issues/57) is closed and Done after integrated verification on `8dea2ea` (2,922 passed, 14 skipped). Child [#492 Implement symbol and changed-region readers](https://github.com/tyldra-org/falryn/issues/492) closed and Done via [PR #497](https://github.com/tyldra-org/falryn/pull/497) (`b188bbb`); docs companion [falryn-docs#117](https://github.com/tyldra-org/falryn-docs/pull/117) (`19f2fb1`). Child [#493 Implement compact document reader](https://github.com/tyldra-org/falryn/issues/493) closed and Done via [PR #499](https://github.com/tyldra-org/falryn/pull/499) (`d47facf`); docs companion [falryn-docs#118](https://github.com/tyldra-org/falryn-docs/pull/118) (`aa02d09`). Child [#494 Implement notebook reader](https://github.com/tyldra-org/falryn/issues/494) closed and Done via [PR #501](https://github.com/tyldra-org/falryn/pull/501) (`6dd7d91`); docs companion [falryn-docs#119](https://github.com/tyldra-org/falryn-docs/pull/119) (`ca3e2e5`). Child [#495 Implement PDF reader](https://github.com/tyldra-org/falryn/issues/495) closed and Done via [PR #503](https://github.com/tyldra-org/falryn/pull/503) (`8dea2ea`); docs companion [falryn-docs#120](https://github.com/tyldra-org/falryn-docs/pull/120) (`f7705a3`). Child [#58 Implement image, artifact, and virtual-resource readers](https://github.com/tyldra-org/falryn/issues/58) closed and Done via [PR #505](https://github.com/tyldra-org/falryn/pull/505) (`011a83d`); docs companion [falryn-docs#121](https://github.com/tyldra-org/falryn-docs/pull/121) (`d77eb6c`). Child [#59 Preserve exact source, partial-result metadata, limits, and expansion](https://github.com/tyldra-org/falryn/issues/59) is delivered via [PR #508](https://github.com/tyldra-org/falryn/pull/508) (`c094c5b`); docs companion [falryn-docs#122](https://github.com/tyldra-org/falryn-docs/pull/122) (`d62f3c7`). Child [#60 Add malformed, stale, binary, large-file, symlink, and cancellation tests](https://github.com/tyldra-org/falryn/issues/60) closed and Done via [PR #509](https://github.com/tyldra-org/falryn/pull/509) (`c00d734`); docs companion [falryn-docs#123](https://github.com/tyldra-org/falryn-docs/pull/123) (`ffa88aa`). Parent integrated verification passed on `c00d734` (163 child-seam tests; `bun run check` 2,963 passed, 14 skipped).
- **Completed search, indexing, and patches parent:** [#61 Deliver search, indexing foundations, and patches](https://github.com/tyldra-org/falryn/issues/61) is closed and Done. Child [#62 Implement bounded path and glob discovery](https://github.com/tyldra-org/falryn/issues/62) closed and Done via [PR #511](https://github.com/tyldra-org/falryn/pull/511) (`5fe59dd`); docs companion [falryn-docs#124](https://github.com/tyldra-org/falryn-docs/pull/124) (`36e5184`). Child [#63 Implement ripgrep-backed text search with a deterministic fallback](https://github.com/tyldra-org/falryn/issues/63) closed and Done via [PR #513](https://github.com/tyldra-org/falryn/pull/513) (`3063c46`); docs companion [falryn-docs#125](https://github.com/tyldra-org/falryn-docs/pull/125) (`557e010`). Child [#64 Implement structural and derived-index query foundations](https://github.com/tyldra-org/falryn/issues/64) closed and Done via [PR #515](https://github.com/tyldra-org/falryn/pull/515) (`219bc6c`); docs companion [falryn-docs#126](https://github.com/tyldra-org/falryn-docs/pull/126) (`7bac04a`). Child [#65 Implement semantic retrieval and context-pack search contracts](https://github.com/tyldra-org/falryn/issues/65) closed and Done via [PR #517](https://github.com/tyldra-org/falryn/pull/517) (`5536a8c`); docs companion [falryn-docs#127](https://github.com/tyldra-org/falryn-docs/pull/127) (`d780ecf`). Child [#281 Implement full-file writes and grouped multi-file mutation](https://github.com/tyldra-org/falryn/issues/281) closed and Done via [PR #519](https://github.com/tyldra-org/falryn/pull/519) (`6859da0`); docs companion [falryn-docs#128](https://github.com/tyldra-org/falryn-docs/pull/128) (`2f5b45e`). Child [#282 Implement move, copy, trash, remove, and cross-device behavior](https://github.com/tyldra-org/falryn/issues/282) closed and Done via [PR #521](https://github.com/tyldra-org/falryn/pull/521) (`ec68a3d`); docs companion [falryn-docs#129](https://github.com/tyldra-org/falryn-docs/pull/129) (`33597d2`). Child [#66 Implement patch proposals, previews, conflict detection, and apply](https://github.com/tyldra-org/falryn/issues/66) closed and Done via [PR #523](https://github.com/tyldra-org/falryn/pull/523) (`63edf05`); docs companion [falryn-docs#130](https://github.com/tyldra-org/falryn-docs/pull/130) (`7c112e8`). Child [#67 Implement rollback, changed-region reads, and patch safety tests](https://github.com/tyldra-org/falryn/issues/67) closed and Done via [PR #525](https://github.com/tyldra-org/falryn/pull/525) (`2091441`); docs companion [falryn-docs#131](https://github.com/tyldra-org/falryn-docs/pull/131) (`9adcac9`). Parent integrated verification passed on `2091441` (128 child-seam tests; `bun run check` 3,099 passed, 14 skipped).
- **Completed shell, PTY, process, and Hush parent:** [#68 Deliver shell, PTY, process, and Hush foundations](https://github.com/tyldra-org/falryn/issues/68) is closed and Done. Child [#69 Implement supervised direct-argv and Bash command execution](https://github.com/tyldra-org/falryn/issues/69) closed and Done via [PR #527](https://github.com/tyldra-org/falryn/pull/527) (`943fbbaf`); companion docs [falryn-docs#132](https://github.com/tyldra-org/falryn-docs/pull/132) (`8df4510`). Child [#70 Implement PTY sessions and long-lived managed process services](https://github.com/tyldra-org/falryn/issues/70) closed and Done via [PR #529](https://github.com/tyldra-org/falryn/pull/529) (`afe53d2b`); companion docs [falryn-docs#133](https://github.com/tyldra-org/falryn-docs/pull/133) (`0b273fba`). Child [#71 Capture ordered output, exits, limits, and artifact spillover](https://github.com/tyldra-org/falryn/issues/71) closed and Done via [PR #531](https://github.com/tyldra-org/falryn/pull/531) (`ac905090`); companion docs [falryn-docs#134](https://github.com/tyldra-org/falryn-docs/pull/134) (`7d7c0a0a`). Child [#72 Implement Hush command-output reducers over exact process facts](https://github.com/tyldra-org/falryn/issues/72) closed and Done via [PR #533](https://github.com/tyldra-org/falryn/pull/533) (`7514dc7e`); companion docs [falryn-docs#135](https://github.com/tyldra-org/falryn-docs/pull/135) (`4a146f66`). Child [#73 Implement process-tree cancellation, deadlines, and cleanup](https://github.com/tyldra-org/falryn/issues/73) closed and Done via [PR #535](https://github.com/tyldra-org/falryn/pull/535) (`b28f1ce8`); companion docs [falryn-docs#136](https://github.com/tyldra-org/falryn-docs/pull/136) (`1a98c9e4`). Child [#74 Add shell quoting, platform, truncation, and interruption fixtures](https://github.com/tyldra-org/falryn/issues/74) closed and Done via [PR #537](https://github.com/tyldra-org/falryn/pull/537) (`8ea3a3ff`); companion docs [falryn-docs#137](https://github.com/tyldra-org/falryn-docs/pull/137) (`ca064620`). Parent integrated verification passed on `8ea3a3ff` (175 child-seam tests; `bun run check` 3,179 passed, 14 skipped).
- **Open falryn v0.1 Foundation product issues:** none remaining.
- **Completed Git, worktree, and checkpoint parent:** [#75 Deliver Git, worktree, and checkpoint tools](https://github.com/tyldra-org/falryn/issues/75) is closed and Done. Child [#76 Implement Git status, diff, log, blame, and repository discovery](https://github.com/tyldra-org/falryn/issues/76) closed and Done via [PR #539](https://github.com/tyldra-org/falryn/pull/539) (`9c19c52a`); companion docs [falryn-docs#138](https://github.com/tyldra-org/falryn-docs/pull/138) (`403d7de0`). Child [#77 Integrate patches with dirty-tree and conflict awareness](https://github.com/tyldra-org/falryn/issues/77) closed and Done via [PR #541](https://github.com/tyldra-org/falryn/pull/541) (`241bfa9d`); companion docs [falryn-docs#139](https://github.com/tyldra-org/falryn-docs/pull/139) (`efa93f53`). Child [#78 Implement safe branch and worktree operations](https://github.com/tyldra-org/falryn/issues/78) closed and Done via [PR #543](https://github.com/tyldra-org/falryn/pull/543) (`3b44dde4`); companion docs [falryn-docs#140](https://github.com/tyldra-org/falryn-docs/pull/140) (`d238cc01`). Child [#79 Implement checkpoints, restore plans, and recoverable rollback](https://github.com/tyldra-org/falryn/issues/79) closed and Done via [PR #545](https://github.com/tyldra-org/falryn/pull/545) (`7d772b67`); companion docs [falryn-docs#141](https://github.com/tyldra-org/falryn-docs/pull/141) (`1f287efe`). Child [#80 Implement commit planning, validation summaries, and provenance](https://github.com/tyldra-org/falryn/issues/80) closed and Done via [PR #547](https://github.com/tyldra-org/falryn/pull/547) (`a7262555`); companion docs [falryn-docs#142](https://github.com/tyldra-org/falryn-docs/pull/142) (`2295d87d`). Child [#283 Implement Git stage, commit, fetch, pull, push, and sync](https://github.com/tyldra-org/falryn/issues/283) closed and Done via [PR #549](https://github.com/tyldra-org/falryn/pull/549) (`8ba0c17d`); companion docs [falryn-docs#143](https://github.com/tyldra-org/falryn-docs/pull/143) (`28a7a158`). Parent integrated verification passed on `8ba0c17d` (67 child-seam tests; `bun run check` 3,240 passed, 14 skipped).
- **Completed context engine parent:** [#81 Implement the context engine and context packs](https://github.com/tyldra-org/falryn/issues/81) is closed and Done. Child [#82 Define evidence candidates, provenance, freshness, and exact-source handles](https://github.com/tyldra-org/falryn/issues/82) closed and Done via [PR #551](https://github.com/tyldra-org/falryn/pull/551) (`1347f91`); companion docs [falryn-docs#144](https://github.com/tyldra-org/falryn-docs/pull/144) (`82ef73b`). Child [#83 Implement token, byte, item, latency, and sensitivity budgets](https://github.com/tyldra-org/falryn/issues/83) closed and Done via [PR #553](https://github.com/tyldra-org/falryn/pull/553) (`8aa155a`); companion docs [falryn-docs#145](https://github.com/tyldra-org/falryn-docs/pull/145) (`a272394`). Child [#84 Rank and select context across tools, index, memory, and conversation](https://github.com/tyldra-org/falryn/issues/84) closed and Done via [PR #555](https://github.com/tyldra-org/falryn/pull/555) (`1ae2f8e`); companion docs [falryn-docs#146](https://github.com/tyldra-org/falryn-docs/pull/146) (`77e1137`). Child [#85 Compose deterministic context packs with citations and uncertainty](https://github.com/tyldra-org/falryn/issues/85) closed and Done via [PR #557](https://github.com/tyldra-org/falryn/pull/557) (`c6eac94`); companion docs [falryn-docs#147](https://github.com/tyldra-org/falryn-docs/pull/147) (`23393f2`). Child [#86 Implement expansion, cache reuse, invalidation, and exact retrieval](https://github.com/tyldra-org/falryn/issues/86) closed and Done via [PR #559](https://github.com/tyldra-org/falryn/pull/559) (`7e4ea9d`); companion docs [falryn-docs#148](https://github.com/tyldra-org/falryn-docs/pull/148) (`86a87d3`). Child [#87 Add large-repository, long-session, stale, and conflicting-evidence scenarios](https://github.com/tyldra-org/falryn/issues/87) closed and Done via [PR #561](https://github.com/tyldra-org/falryn/pull/561) (`4eb3fd7`); companion docs [falryn-docs#149](https://github.com/tyldra-org/falryn-docs/pull/149) (`75bde89`). Parent integrated verification passed on `4eb3fd7` (76 child-seam tests; `bun run check` 3,316 passed, 14 skipped).
- **Completed daily coding TUI parent:** [#249 Deliver the daily coding TUI experience](https://github.com/tyldra-org/falryn/issues/249) is closed and Done. Child [#250 Implement typed transcript blocks and safe unknown-block fallback](https://github.com/tyldra-org/falryn/issues/250) closed and Done via [PR #563](https://github.com/tyldra-org/falryn/pull/563) (`cae315b`); companion docs [falryn-docs#150](https://github.com/tyldra-org/falryn-docs/pull/150) (`0b83a7c`). Child [#251 Implement windowed transcript projection and stable scroll anchors](https://github.com/tyldra-org/falryn/issues/251) closed and Done via [PR #565](https://github.com/tyldra-org/falryn/pull/565) (`53acb21`); companion docs [falryn-docs#151](https://github.com/tyldra-org/falryn-docs/pull/151) (`5990e36`). Child [#252 Implement streaming coalescing with input-priority rendering](https://github.com/tyldra-org/falryn/issues/252) closed and Done via [PR #567](https://github.com/tyldra-org/falryn/pull/567) (`50e343f`); companion docs [falryn-docs#152](https://github.com/tyldra-org/falryn-docs/pull/152) (`167dfa3`). Child [#253 Implement grapheme-aware multiline composer, paste, history, and drafts](https://github.com/tyldra-org/falryn/issues/253) closed and Done via [PR #569](https://github.com/tyldra-org/falryn/pull/569) (`2bd965e`); companion docs [falryn-docs#153](https://github.com/tyldra-org/falryn-docs/pull/153) (`2b87ff0`). Child [#278 Implement typed attachments and context-resource mentions](https://github.com/tyldra-org/falryn/issues/278) closed and Done via [PR #571](https://github.com/tyldra-org/falryn/pull/571) (`275904d`); companion docs [falryn-docs#154](https://github.com/tyldra-org/falryn-docs/pull/154) (`a872022`). Child [#279 Implement editable prompt enhancement without implicit submission](https://github.com/tyldra-org/falryn/issues/279) closed and Done via [PR #573](https://github.com/tyldra-org/falryn/pull/573) (`bc933cd`); companion docs [falryn-docs#155](https://github.com/tyldra-org/falryn-docs/pull/155) (`2bf7fae`). Child [#254 Implement tool, process, reasoning, and error block inspection](https://github.com/tyldra-org/falryn/issues/254) closed and Done via [PR #575](https://github.com/tyldra-org/falryn/pull/575) (`ab39a87`); companion docs [falryn-docs#156](https://github.com/tyldra-org/falryn-docs/pull/156) (`a2fae28`). Child [#255 Implement focused confirmations and protected sensitive input](https://github.com/tyldra-org/falryn/issues/255) closed and Done via [PR #577](https://github.com/tyldra-org/falryn/pull/577) (`97a4767`); companion docs [falryn-docs#157](https://github.com/tyldra-org/falryn-docs/pull/157) (`7fca35f`). Child [#256 Implement context, model, session, and resource controls](https://github.com/tyldra-org/falryn/issues/256) closed and Done via [PR #579](https://github.com/tyldra-org/falryn/pull/579) (`c8f5cbc`); companion docs [falryn-docs#158](https://github.com/tyldra-org/falryn-docs/pull/158) (`db40de9`). Parent integrated verification passed on `c8f5cbc` (`bun run check` 3,444 passed, 14 skipped).
- **Completed late-effect eviction attribution:** [#305 Attribute a late effect whose scope was already evicted](https://github.com/tyldra-org/falryn/issues/305) closed and Done via [PR #581](https://github.com/tyldra-org/falryn/pull/581) (`128ce73`); companion docs [falryn-docs#159](https://github.com/tyldra-org/falryn-docs/pull/159) (`31902e6`).
- **Open falryn v0.2 Core Coding Agent product issues:** none remaining.
- **Completed language intelligence parent:** [#88 Deliver language intelligence and derived indexing](https://github.com/tyldra-org/falryn/issues/88) is closed and Done. Child [#89 Implement language-server supervision, transport, initialization, and shutdown](https://github.com/tyldra-org/falryn/issues/89) closed and Done via [PR #584](https://github.com/tyldra-org/falryn/pull/584) (`7ba7ae4`); companion docs [falryn-docs#173](https://github.com/tyldra-org/falryn-docs/pull/173) (`1ef289d`). Child [#90 Synchronize workspaces, documents, versions, and dynamic capabilities](https://github.com/tyldra-org/falryn/issues/90) closed and Done via [PR #586](https://github.com/tyldra-org/falryn/pull/586) (`8bffb76`); companion docs [falryn-docs#174](https://github.com/tyldra-org/falryn-docs/pull/174) (`6993dde`). Child [#91 Implement diagnostics, hover, definition, references, symbols, and completion](https://github.com/tyldra-org/falryn/issues/91) closed and Done via [PR #588](https://github.com/tyldra-org/falryn/pull/588) (`0f7c049`); companion docs [falryn-docs#175](https://github.com/tyldra-org/falryn-docs/pull/175) (`9036319`). Child [#92 Convert code actions, rename, format, and workspace edits into patches](https://github.com/tyldra-org/falryn/issues/92) closed and Done via [PR #589](https://github.com/tyldra-org/falryn/pull/589) (`6eff081`); companion docs [falryn-docs#176](https://github.com/tyldra-org/falryn-docs/pull/176) (`0591061`). Child [#93 Build rebuildable SQLite lexical and symbol indexes](https://github.com/tyldra-org/falryn/issues/93) closed and Done via [PR #590](https://github.com/tyldra-org/falryn/pull/590) (`3baefca`); companion docs [falryn-docs#177](https://github.com/tyldra-org/falryn-docs/pull/177) (`8454260`). Child [#94 Qualify optional embeddings and structural parsing only when justified](https://github.com/tyldra-org/falryn/issues/94) closed and Done via [PR #591](https://github.com/tyldra-org/falryn/pull/591) (`e703340`); companion docs [falryn-docs#178](https://github.com/tyldra-org/falryn-docs/pull/178) (`789054b`). Parent integrated verification passed on `e703340` (69 child-seam tests).
- **Completed debugging parent:** [#95 Deliver debugging through DAP](https://github.com/tyldra-org/falryn/issues/95) is closed and Done. Child [#96 Implement debug-adapter supervision and request-response transport](https://github.com/tyldra-org/falryn/issues/96) closed and Done via [PR #593](https://github.com/tyldra-org/falryn/pull/593) (`1ea7f60`); companion docs [falryn-docs#179](https://github.com/tyldra-org/falryn-docs/pull/179) (`0b09a59`). Child [#97 Implement launch, attach, breakpoint, thread, and stack lifecycles](https://github.com/tyldra-org/falryn/issues/97) closed and Done via [PR #595](https://github.com/tyldra-org/falryn/pull/595) (`93eefa0`); companion docs [falryn-docs#180](https://github.com/tyldra-org/falryn-docs/pull/180) (`a1ad36b`). Child [#98 Implement scopes, variables, evaluation, and output projections](https://github.com/tyldra-org/falryn/issues/98) closed and Done via [PR #597](https://github.com/tyldra-org/falryn/pull/597) (`cdc379f`); companion docs [falryn-docs#181](https://github.com/tyldra-org/falryn-docs/pull/181) (`aaa6de9`). Child [#99 Implement termination, disconnect, cancellation, and process cleanup](https://github.com/tyldra-org/falryn/issues/99) closed and Done via [PR #599](https://github.com/tyldra-org/falryn/pull/599) (`7dab069`); companion docs [falryn-docs#182](https://github.com/tyldra-org/falryn-docs/pull/182) (`ceb8758`). Child [#100 Capture debug artifacts and add confirmation and fault tests](https://github.com/tyldra-org/falryn/issues/100) closed and Done via [PR #601](https://github.com/tyldra-org/falryn/pull/601) (`3d41e39`); companion docs [falryn-docs#183](https://github.com/tyldra-org/falryn-docs/pull/183) (`b5fd615`). Parent integrated verification passed on `3d41e39` (20 child-seam tests).
- **Active Brief, Hush, Loom parent:** [#101 Implement Brief, Hush, Loom, and compression](https://github.com/tyldra-org/falryn/issues/101) is open and In Progress. Child [#102 Implement Brief as response-style projection without evidence loss](https://github.com/tyldra-org/falryn/issues/102) closed and Done via [PR #632](https://github.com/tyldra-org/falryn/pull/632) (`8b669b3`); companion docs [falryn-docs#193](https://github.com/tyldra-org/falryn-docs/pull/193) (`3828da9`). Child [#103 Integrate Hush across shell, Git, tests, search, and process output](https://github.com/tyldra-org/falryn/issues/103) closed and Done via [PR #634](https://github.com/tyldra-org/falryn/pull/634) (`1ca4435`); companion docs [falryn-docs#194](https://github.com/tyldra-org/falryn-docs/pull/194) (`7fbdd07`). Child [#104 Implement Loom compress-cache-retrieve manifests and exact retrieval](https://github.com/tyldra-org/falryn/issues/104) closed and Done via [PR #636](https://github.com/tyldra-org/falryn/pull/636) (`20595b7`); companion docs [falryn-docs#195](https://github.com/tyldra-org/falryn-docs/pull/195) (`af87619`). Child [#105 Implement structural reducers for files, diffs, diagnostics, and tools](https://github.com/tyldra-org/falryn/issues/105) closed and Done via [PR #638](https://github.com/tyldra-org/falryn/pull/638) (`20523ec`); companion docs [falryn-docs#196](https://github.com/tyldra-org/falryn-docs/pull/196) (`ffa223a`). Child [#106 Implement optional compact-model and history checkpoint lanes](https://github.com/tyldra-org/falryn/issues/106) closed and Done via [PR #641](https://github.com/tyldra-org/falryn/pull/641) (`14c2b96`); companion docs [falryn-docs#199](https://github.com/tyldra-org/falryn-docs/pull/199) (`9bf5ab9`). Child [#107 Evaluate fidelity, reversibility, latency, and token savings](https://github.com/tyldra-org/falryn/issues/107) is delivered in this change. Parent integrated verification passed in this change. Remaining required children: none.
- **Next planning action:** continue via [#108 Implement durable memory and operational learning](https://github.com/tyldra-org/falryn/issues/108). GitHub remains authoritative for ordering.