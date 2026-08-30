# Current state

This is Falryn's public implementation-status page. It reports behavior
verified in the repository; it is not a roadmap or a specification for
unannounced work.

## Available from source

Falryn can be installed from this repository with Bun and run as a terminal
application. The current command surface includes:

| Command | Verified purpose |
| --- | --- |
| falryn | Open the interactive terminal interface on a capable terminal |
| falryn --help / --version | Print usage or build identity |
| falryn run [--mode ask\|plan\|debug\|agent] <prompt> | Run one headless coding turn through the selected execution profile and provider |
| falryn doctor | Run bounded environment and local-storage diagnostics |
| falryn config show / validate / path | Inspect and validate effective configuration |
| falryn provider list / add / use / configure / test / login / logout / remove | Manage local provider profiles and credentials |
| falryn data reset / uninstall | Preview or apply confirmed removal of Falryn-owned local data |
| falryn workspace list / show / save / load | Inspect or persist named workspace sets |
| falryn export | Preview or write a versioned local export package |
| falryn session list / show | List or inspect locally stored sessions |
| falryn artifact list / show / get | Inspect locally stored artifacts |

Commands support human-readable and machine-readable output forms. Results go
to standard output and diagnostics go to standard error.

## Configuration home and local data

Human-authored user configuration defaults to `~/.falryn/falryn.jsonc`, with
profiles under `~/.falryn/profiles/`, user-authored model catalogs under
`~/.falryn/catalogs/`, and named workspace layouts under
`~/.falryn/layouts/`. Project configuration remains
`<workspace>/.falryn/falryn.jsonc`. `FALRYN_CONFIG_DIR` is the explicit user
configuration-root override.

Without that override, Falryn recognizes the previous platform-default
configuration root. Reads select a populated legacy root when `~/.falryn` does
not contain data and do not create or move either path. The first user/profile
configuration write or saved-layout write migrates the complete legacy
directory to `~/.falryn` by rename. If both homes contain data, Falryn reports a
typed conflict and changes neither. When the active workspace is the user's
home, the identical user/project path is read once as user configuration.

This is a configuration-only change. SQLite state and indexes, caches, logs,
temporary ingest, artifacts, and exports keep their platform-native roots.
Credential bytes remain in the operating-system keychain or an explicitly
referenced external source. Help, version, doctor, and configuration inspection
do not create `~/.falryn` or trigger migration.

## Provider connections

Provider profiles are stored in the typed `providers.connections`
configuration value. A fresh installation includes a selected
OpenAI profile that references `FALRYN_OPENAI_API_KEY`; configuration stores
the reference, never the credential bytes. The environment store resolves only
the provider's ordered declaration of Falryn-specific and provider-native
aliases. It works through the inherited process environment on macOS, Linux,
and Windows. On macOS it can also resolve one declared alias from the current
launchd user environment; on Windows it can resolve one declared persisted User
or Machine value. Linux deliberately has no post-start environment probe because
its common user-manager command exposes the complete environment rather than one
name. Falryn never parses or executes shell profiles or reads another
application's credential files. Additional profiles can be added, configured,
selected, tested, logged out, or removed through `falryn provider`.

`provider add` and `provider configure` infer the installed official SDK only
from an exact provider identity: `openai`, `anthropic`, `google`, or
`commandcode`. Their
official destinations receive their provider's canonical environment reference
and default to remote model discovery. An unfamiliar provider requires an
explicit adapter and endpoint, and a compatible custom endpoint receives no
inferred credential and defaults to static discovery unless the caller opts
into remote discovery. Enabled models and user catalog identities are
repeatable inputs to the same typed action used by human, JSON, and JSONL
callers.

Successful profile creation, configuration, selection, and login automatically
run the profile's configured discovery path. Static profiles resolve their
enabled model facts immediately. Remote profiles refresh through the selected
official SDK once a credential is available, then reuse the bounded platform
cache until its catalog expires. A discovery failure is reported separately
and never rolls back provider metadata or a credential that was already stored.
Automatic discovery does not enable provider models that the profile did not
select. `provider test` remains the explicit authentication and catalog
diagnostic, while every live attempt also refreshes an expired catalog before
binding its immutable execution generation.

Interactive API-key login accepts the secret only on standard input and stores
it through `Bun.secrets`: macOS Keychain Services, Linux Secret Service, or
Windows Credential Manager. The value does not enter command arguments,
environment variables, diagnostics, configuration, or model context. Missing,
locked, denied, and unavailable platform services fail closed. OAuth PKCE and
device authorization are accepted only through an installed official provider
adapter; Falryn does not imitate browser sessions or subscription credentials.

Human, JSON, and JSONL results expose profile, connection, account, catalog,
and revocation state without secret material. `falryn run` passes the selected
provider and normalized model catalog into a real model attempt. Assistant tool
requests are validated against a bounded, generation-bound disclosure and then
pass through policy, focused confirmation, hooks, scheduling, exact capture,
semantic journaling, and bounded result projection before provider
continuation. A headless turn cannot report completion unless a terminal model
attempt ran.

Model identity and model selection are stored separately. Falryn bundles
strict, versioned OpenAI, Anthropic, Google, and Command Code model catalogs
as committed JSON resources into the executable. `bun run generate:model-catalogs`
deterministically regenerates Command Code's resource from its verified model,
reasoning-control, and provider-pricing sources; `bun run check:model-catalogs`
validates all four resources and rejects generated drift. It also reports
complete and partial model counts plus unresolved core facts. A built-in model
cannot claim `complete` while its modalities, feature support, context or
output limit, or pricing remain unresolved. The ordinary static check runs that
verification in parallel with repository integrity, type checking, and code
quality. The command reports each catalog's model count, coverage, canonical
SHA-256 resource digest, and committed path. Every built-in catalog
also records bounded resolved source URLs, observation times, source authority,
confidence, and the identity, capability, token-limit, or prompt-cache facts
supported by each source. Provider documentation is preferred. Upstream model
documentation, runtime observations, and independent research can represent
facts absent from provider docs without being mislabeled as provider-published.
Search-result pages are not evidence. Each pricing schedule keeps its own
provider-bound source and observation time. Catalog resources contain data only;
TypeScript owns strict validation and the Command Code generator, without
putting transport behavior or credentials into catalog data.
Provider profiles select enabled model IDs and may reference user catalogs by
identity, and optional inline profile declarations remain the highest-priority
compatibility override. A user catalog is a bounded JSONC document at
`~/.falryn/catalogs/<catalog-id>.jsonc`, bound to one provider identity, SDK
adapter, and normalized endpoint so facts cannot cross destinations. Catalog
documents separate input modalities from output modalities and record tools,
structured output, streaming, reasoning, provider-native reasoning controls,
provider-native response-density controls, context limits, output limits,
provider-bound pricing schedules, and completeness. Pricing uses integer USD
microunits per million tokens and retains source, observation time, billing
mode, context/service/time bands, effective interval, and distinct input,
cached-input, cache-write-input, and output rates. Unpublished rates stay
explicitly unknown. Feature support is tri-state
(`supported`, `unsupported`, or `unknown`); missing facts are never upgraded to
support. The default OpenAI profile enables the current general-purpose GPT-5.6 family: `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, and the moving `gpt-5.6` alias. Sol is ordered
first for the default route. Their source-verified declarations record
text/image input, text output, tools, structured output, streaming, reasoning
controls, and token limits. Specialized realtime, audio, transcription,
embedding, moderation, and image-generation models are not placed in this
text-agent catalog because they require different request and output contracts.
The compatibility manifest retains `gpt-4o-mini` for existing profiles, but
fresh defaults do not select it. Compatibility facts apply only at the official
OpenAI endpoint; unfamiliar model names and custom endpoints remain unknown.

The Command Code catalog contains the 62 execution IDs currently published by
its Provider API, with names and context limits from the model endpoint and
text, image, and reasoning facts from Command Code's model registry. Output
limits, structured-output support, and provider-native reasoning controls stay
unknown because Command Code does not publish those facts per model. The
catalog marks the provider's agent protocol as tool-capable and streaming, but
live image transport remains unavailable until Falryn can resolve image
handles into SDK request parts. Its bundled pricing schedules cover every one
of those 62 IDs from Command Code's current official table, including
long-context, time-of-day, cache, and temporary-free conditions. They are
marked as published estimates because Command Code says routed upstream cost
can vary. OpenAI's catalog independently records its official direct-API
schedule, so an identical model ID never borrows a price from another
destination. Command Code's capability projection and pricing schedule are
catalog-generation inputs; runtime catalog loading reads the same strictly
parsed resource shape as OpenAI, Anthropic, and Google. Its exact protocol and
reasoning-control maps remain separate transport-routing facts.

Remote catalog refresh uses the official OpenAI, Anthropic, or Google Gen AI
TypeScript SDK selected by the profile. Command Code discovery uses the OpenAI
SDK against its official Models endpoint. Successful provider-reported catalogs
are cached as bounded, secret-free normalized documents beneath the
platform-native cache root; the cache is disposable and scoped to the exact
profile, provider, adapter, and endpoint. OpenAI's Models API contributes model
identity and availability but no invented capability facts. Anthropic's richer
Models response contributes modalities, limits, structured output, and
reasoning controls. Google's Models response contributes supported actions,
token limits, and thinking support; fields it does not enumerate remain
unknown. Remote facts merge with explicit profile declarations under a new
catalog generation. Only configured model IDs enter the effective catalog.
Malformed records, stale generations, authentication failures, rate limits,
timeouts, and cancellation fail closed with typed, secret-free outcomes.
Before a live model adapter is created, the exact effective catalog is
published immutably to the product SQLite state database with its provider
profile, provider adapter kind, and configured endpoint. Reusing a profile and
generation with a different destination or catalog is a conflict. The model
route and attempt retain that exact profile/destination binding and catalog
generation, so cache eviction, profile reconfiguration, or a later provider
refresh cannot change or erase the facts used by an in-flight or replayed
decision. Catalog and profile files never contain credential bytes.
Live inference uses provider adapters. OpenAI is one Falryn provider above two
official-SDK transport leaves: Chat Completions and Responses. Its immutable
destination and exact-model plans select the leaf without changing provider
identity. Anthropic and Google each instantiate their official SDK directly.
Command Code is one
Falryn provider whose composite adapter uses an exact model-to-protocol map:
Claude execution IDs delegate to the Anthropic SDK leaf and the remaining
published IDs delegate to the OpenAI SDK leaf. No model-name heuristic or
generic compatibility assumption chooses that transport. Each provider adapter
translates the same bounded messages,
tool definitions, tool continuations, output contract, token budget, usage,
finish reason, cancellation, and typed failure events. A provider-native
reasoning control is sent when the effective model catalog supports a mapping
for the selected Falryn posture. `max` is an explicit quality-first posture and
is eligible only when both the model catalog and adapter expose the provider's
native `max` control. OpenAI's GPT-5.6 catalog maps Falryn `minimal` to `low` or
`none`, not to the SDK's unrelated literal `minimal` compatibility value.
Catalog modality support is also intersected with the adapter's current request
transport; the live adapters accept text today and fail with
`unsupported-capability` rather than dropping unresolved image handles. Falryn
keeps retries above the SDK boundary; each SDK performs one request attempt.

Provider wire behavior is a separate versioned contract. Every adapter resolves
an immutable destination plan plus one plan for each enabled model and publishes
their SHA-256 identities. Resolution is ordered: installed SDK baseline, optional
destination declaration, then an optional exact-model override. The route keeps
the selected plan's source and layer receipt; provider request metadata and the
durable model-attempt binding retain its identity. The attempt runner refuses an
identity or receipt that differs from the live adapter before network I/O.
Existing profiles use the installed adapter's baseline. OpenAI profiles may
instead declare exact Chat Completions behavior for
system or developer messages, output-token field, streaming usage, finish
reason, strict tool schemas, tool-result names, and assistant bridging after a
tool result at destination or exact-model scope. The separate Responses
declaration records instruction role, stateless encrypted-reasoning replay or
stored previous-response continuation, provider storage, reasoning summary,
prompt-cache retention, stream obfuscation, parallel calls, and strict tool
schemas. The plan also records session affinity through the prompt-cache key and
the supported automatic or default service tier. The Responses leaf translates
function calls and outputs with their provider call identities, normalizes text,
reasoning, usage, retry delay, refusal, incomplete, failed, and terminal events,
and rejects malformed or duplicate tool identities. Exact-model declarations name
an enabled model and retain nullable HTTPS source and observation metadata. The
strict profile codec rejects duplicate or disabled model overrides and any
dialect that does not match the selected adapter. Source metadata is audit data,
not authority. Falryn does not infer these facts from a model name, provider
label, or endpoint URL. Chat Completions and Responses state never cross their
transport leaves. Responses continuation state is retained in bounded SQLite
records keyed by the exact profile, provider, destination, model, compatibility
plan, and tool-call identity. A restarted product route can reload stateless
encrypted reasoning or a stored response identity without projecting opaque
state into instructions, normalized events, or diagnostics. Secret-safe
metadata reports only whether bounded state was saved or loaded and how many
tool calls it covered. Missing, malformed, oversized, or unavailable durable
state fails the continuation closed.

The Anthropic Messages declaration separately binds top-level system blocks,
`max_tokens`, adaptive thinking, signed-thinking replay, JSON-schema output,
system-prefix cache placement and TTL, assistant-before-user tool-result
ordering, strict tool schemas, message-start/delta usage, and service tier. Its
plan also records SDK-managed API versioning, the absence of beta headers, and
the currently verified text-block input encoding. Its
official-SDK leaf validates the complete message and content-block lifecycle,
rejects malformed or unsupported server output, and normalizes provider refusal,
context exhaustion, paused turns, retry timing, cache usage, and reasoning
usage. Signed thinking and opaque redacted-thinking blocks are retained
unchanged for tool continuation in the same exact-route SQLite repository used
by product composition. A restarted adapter loads only a matching profile,
provider, destination, model, plan, and tool-call record; opaque continuation
bytes never enter prompts, normalized events, or diagnostics.

The Google Generate Content declaration binds top-level system instructions,
user/model roles, `maxOutputTokens`, thinking-level control, JSON Schema output,
provider or derived function-call identities, model-before-user function-result
ordering, prompt-feedback and finish-reason safety, single-candidate streaming,
usage metadata, text-part input, and disabled SDK automatic function calling.
The official-SDK leaf validates candidate, part, usage, and terminal ordering;
rejects unsupported server parts, partial or duplicate function calls, unsafe
finishes, malformed usage, and transport-plan drift; and reports exact cached
input, output, and reasoning usage when Google supplies it. Signed thought parts
and per-function thought signatures use the same exact-route SQLite continuation
repository and replay after restart without placing opaque signatures in
normalized events or diagnostics. Live image handles remain unsupported until
the artifact-backed media issues supply exact bytes.

Live turns also derive a secret-safe, session-scoped prompt-cache identity from
the bound provider route, configuration and catalog generations, and the exact
stable instruction, capability, and tool-schema prefix. Dynamic Brief guidance,
task text, conversation, memory, and evidence remain outside that prefix.
Retries and tool continuations on the same route reuse the identity; a session,
route, generation, stable instruction, or disclosed schema change breaks it.
Each built-in model records its exact provider cache mechanism, published
minimum cacheable prefix, and provider-bound cache-read and cache-write prices;
unknown thresholds or prices remain unknown. OpenAI receives the current SDK
`prompt_cache_key`. Anthropic receives a five-minute `cache_control` breakpoint
on the last stable system block. Google reports provider-managed cache usage.
The Generate Content adapter can consume an exact cached-content binding, but
creation, reuse, expiry, deletion, restart recovery, and retention are not yet
implemented. Without that binding, an explicit-cache request sends the exact
uncached prompt. Command Code keeps Falryn's stable prefix but lets
its Provider API manage cache locality without leaking OpenAI- or
Anthropic-specific controls through its protocol adapters. Attempt events retain
the selected mechanism, eligibility threshold, cache digests, and stable
boundary, never prompt text or credentials. Normalized usage keeps
provider-reported cache reads and cache writes distinct.

Falryn now publishes the executable tool inventory into one immutable shared
capability registry generation. Its strict contribution contract covers tools,
MCP tools/resources/prompts, skills, hooks, plugins, commands, agents/subagents,
workflows, providers, and UI contributions without treating those primitives as
one executor. Existing tool capability IDs remain canonical; `ToolRegistry`
continues to own exact schemas and runner bindings. Installed inventory has no
arbitrary entry quota, while queries default to 32 entries and are capped at
256. Current production loaders contribute the built-in product tools. Live
extension, agent, workflow, provider, and UI loaders remain with their owning
issues.

Each registry generation can now be inspected through one consumer-specific
capability-health snapshot. The pure evaluator combines declared lifecycle and
operational state with supplied platform, architecture, dependency, credential,
resource, policy, probe, provider/attempt-runner/workspace, and external-host
facts. Healthy, degraded, unavailable, incompatible, denied, quarantined, and
unknown remain distinct from registered, disclosed, executable, projected,
selected, and active. Bounded active probes validate catalog identity, count,
concurrency, timeout, cancellation, and freshness; their text and recovery
handles are redacted before projection. Stale results become unknown.

The product runtime exposes that same immutable snapshot to native-model, CLI,
OpenTUI, headless, and external-host consumers. Its read-only inspector derives
tools queries, deduplicated doctor findings, and effective permission facts from
one generation. Queries default to 32 rows and admit at most 256, carry a
deterministic continuation handle, and reject stale generations. Permission
changes remain owned by settings rather than the inspector. Slash command
parsing and completion for these actions are not claimed here.

The provider request contains only the disclosed tool definitions and bounded
compact capability cards, not the whole registered catalog or implementation
bodies. Before each provider request, the product runtime now derives one
deterministic opportunity plan from the normalized task, work intent, execution
profile, current capability-health generation, exact model-schema eligibility,
effect, source locality, declared cost/latency class, an optional
application-supplied preference, and stable publication order. It selects the
bounded schema set before inference;
an explicit shell request keeps the shell route, while structured browser access
stays ahead of visual computer use when both are relevant. Matching skill,
workflow, MCP/plugin, delegation, background, browser, and computer opportunities
are reported as selected, recommended, unavailable, deferred, or not needed.
This planner does not install or execute those contributions; their owning
runtimes remain separate.

The model capability brief names the preferred family, fallbacks, selected
contributions, automation decisions, schema-token cost, negative availability,
and the bounded discovery handle. It retains only a SHA-256-derived task
fingerprint rather than the task text. A semantic top-rank tie is marked eligible
for model assistance, but the planner does not add a separate routing-model
request. The same plan is validated against the provider-bound schema set and
persisted with the attempt, so a stale generation, altered discovery identity,
or unselected tool schema fails before provider execution. The attempt event
also retains the provider profile,
adapter kind, secret-safe destination identity, model route, resolved reasoning
control, catalog, capability-schema, and policy generations, contribution
counts/cards, capability cost/latency classes, tool-schema digests, schema cost,
effective health/selection/projection flags, stable diagnostic codes,
unavailable capability families,
omissions, and a `capability-catalog:<generation>` discovery handle. Provider
disconnects, malformed requests, cancellation, timeout,
fallback exhaustion, and uncertain effects remain typed outcomes. Completed or
uncertain consequential tool effects are not retried as fresh work.

The interactive composer and `falryn run` use the same application-owned
live-turn executor. Both paths compose Context and, unless disabled, Brief; run the selected
provider and bounded tool continuation loop, and persist the same closed
session, turn, model-attempt, and capability-invocation events to SQLite before
projecting them. OpenTUI folds those committed events into its transcript;
JSONL emits the same event values before its terminal result. A failed append,
provider connection, context composition, attempt, or replay cannot be reported
as an accepted or completed turn. Production does not fall back to the in-memory
event-store test double when SQLite cannot open.

Brief remains a pre-inference response-density policy; it never truncates or
rewrites a completed answer and does not add a second model request. The shared
live-turn path derives response obligations from the task and current Context
state, preserves failures, risks, uncertainty, citations, validation, required
actions, and recovery guidance, and reprojects those obligations before each
provider continuation after tool results. Brief also supplies a mode-specific
provider output ceiling. Projection failure is a typed turn failure rather than
silent omission.

`brief.v4` delivers that policy through one provider-neutral request field.
The route first intersects controls published for the exact model with controls
implemented by the selected provider adapter. OpenAI GPT-5.6 requests use native
`verbosity`; models without a verified native control receive Brief's bounded
prompt guidance. When native density is available, only task-specific semantic
obligations remain in the prompt. Command Code does not inherit OpenAI
verbosity merely because one of its transports is OpenAI-compatible. The Brief
receipt records `prompt`, `native`, or `native-with-semantic-prompt`, the exact
normalized native value, and the guidance bytes actually sent.

`auto` uses the deterministic `brief.v4` policy. Prompt shape is classified as
low, medium, or high without treating one technical keyword as a large task.
High complexity, uncertainty, recovery, safety-critical ambiguity, or an
explicit clarification request selects detailed output. Medium complexity, a
failure, risk, confirmation, required user action, or order-sensitive procedure
selects balanced output. A low-complexity headless or narrow turn selects
compact; interactive turns default to balanced. Citations and validation
results remain protected facts but do not force a larger answer by themselves.
Every receipt records the ordered reasons for its selection.
Failures, uncertainty, confirmations, required actions, and recovery obligations
are derived from the request itself as well as later Context and tool outcomes,
so the first provider attempt receives the same preservation guarantees.

The explicit modes use outcome-first guidance and require every explicit fact to
appear once with names, paths, commands, errors, numbers, and negations kept
exact. Compact requests the shortest complete answer and avoids optional
examples. Balanced adds only the reasoning and evidence needed to act. Detailed
means complete rather than long: it adds relevant tradeoffs and actionable steps
but remains direct and forbids invented background, prompt restatement, repeated
conclusions, and filler.

Brief changes density and explanation depth only. It does not impose a language,
persona, dialect, broken grammar, or Caveman-style voice on the provider. The
current policy defaults cap compact, balanced, and detailed at 2,048, 4,096, and
8,192 output tokens respectively; these are ceilings, not requested answer
lengths or universal model limits. `auto` selects a level and its ceiling from
the live need. The effective request uses the lowest applicable Brief, model,
route, and caller limit. Brief `off` adds neither guidance nor a Brief-derived
ceiling; the selected model route's ordinary provider budget still applies.

Human controls expose `compact`, `balanced`, `detailed`, `auto`, `on`, and
`off`; they do not expose the backend name `raw`. `/brief off` and
`falryn run --brief off` select that internal bypass, so the turn has no Brief
prompt section, Brief receipt, or Brief-derived output budget. In a TUI session,
`/brief on` restores the last enabled density mode. The stateless CLI maps
`--brief on` to `auto`.

The TUI also exposes `/compression`, a single interactive control sheet for
Brief, Hush, and Loom. It shows the current state of all three engines, selects
an explicit Brief density, toggles Hush or Loom, and can enable or disable all
three together. `/brief`, `/hush`, and `/loom` remain compatible direct
shortcuts rather than becoming a second configuration system. Human-facing
`off` continues to map to each engine's bounded backend raw mode; it does not
disable safety, capture, artifacts, recovery, or provider limits.

`bun run benchmark:brief` provides a bounded matched-run scorecard against the
pinned Caveman research policy. It records complete provider usage, retries,
latency, guidance cost, required-fact fidelity, losing rows, and invalid rows
without persisting raw model responses. The scorecard requires a configured
live provider for comparative acceptance; deterministic fixtures prove only
the comparison and failure plumbing.

The checked-in #827 qualification ran the six reviewed fixtures twice with
alternating order through Command Code `MiniMaxAI/MiniMax-M3`. Both arms used
the live headless provider path, a 2,048-token output ceiling, concurrency one,
and no disclosed tools. All 12 pairs passed with full Brief fidelity, no retry,
loss, invalid row, or missing Brief fact. Brief used 8,502 provider-reported
complete-turn tokens; the pinned Caveman arms used 25,892. This is evidence for
that provider, model, corpus, and run only. It is not a universal model claim.

`bun run benchmark:compression` is the aggregate qualification command for the
three live compression lanes. It refuses a dirty checkout, reruns the complete
Hush projection corpus against the locally pinned RTK executable, reruns Loom
against the pinned Headroom fixture, consumes the reviewed provider-reported
Brief qualification, and executes the focused provider-continuation, process,
Read, Loom-recovery, and headless live-turn tests. Its human and JSON forms are
projections of the same typed result. Every Hush, Loom, and Brief row remains
visible, including ties and failures; test stdout and stderr are represented
only by digests. Estimated Hush/Loom tokens and provider-reported Brief tokens
remain separate, so the report never publishes a false cross-lane total.

The Hush inventory comparison remains pinned to RTK 0.45.0 at commit
`b34be37caf3796b69a50952a28e60e32b5daad43`, while executable projection runs
are pinned separately to RTK 0.46.0. The aggregate report verifies and displays
both facts instead of relabelling the older command-inventory evidence. A dirty,
partial, cancelled, stale, baseline-missing, fact-losing, or recovery-missing
run cannot produce an overall pass.

A shared deterministic integration fixture exercises that lifecycle through
both public composition roots. Its first provider response invokes
`run_process`, the exact `ls -la` capture is reduced by `files.ls`, and the
second provider request receives the correlated assistant tool call and one
bounded Hush result without the original raw listing. Reopening product state
replays the same ordered semantic events and reads the exact retained bytes
through the recovery artifact without executing the process again. Required
artifact-retention failure stops before provider continuation and settles the
turn as failed with a partial effect.

OpenTUI's `session.new` palette action creates a new durable session before it
switches the active transcript and submission target. A failed creation leaves
the current session selected; concurrent duplicate actions coalesce, and active
turns or unresolved confirmations must settle first.

## Execution profiles and model roles

Headless and OpenTUI turns use one versioned execution-profile contract and the
same live-turn executor. `Agent` is the default. `falryn run --mode <profile>`,
the `mode.select` palette action, `/mode <profile>`, and the `/ask`, `/plan`,
`/debug`, and `/agent` aliases all select that same contract.

| Profile | Completion criterion | Enforced authority |
| --- | --- | --- |
| Ask | answer | Observation-only evidence and tools |
| Plan | durable plan | Observation-only investigation plus an exact reviewable Markdown artifact |
| Debug | diagnosis | Bounded process, LSP, and DAP probes; direct edit and Git-mutation tools are denied |
| Agent | implemented and verified | Full authorized tool loop with the normal effect policy and focused confirmations |

Profile selection is persisted as a semantic session event. Each model attempt
binds the selected profile, profile version, completion criterion, and policy
generation before provider execution. A later selection applies only to a later
turn and cannot broaden an in-flight attempt. The required profile guidance is
also budgeted as a product-invariant prompt section; the gateway remains the
authority even if a prompt or tool result asks for a wider effect.

Plan cannot report completion unless its exact model output is retained as an
available `text/markdown` artifact. Human and structured headless results expose
the effective profile, completion criterion, model role, reasoning setting,
policy generation, and Plan artifact identity when present. OpenTUI shows the
active profile in the status line and emits a transcript notice when it changes.

The public model roles are `default`, `compact`, `vision`, `plan`, `advisor`,
`commit`, `fast-read`, and `fast-edit`. Unconfigured standard job roles inherit
`default`; reasoning remains a supported setting on the effective model rather
than a `thinking` or `deep` role. Profiles request a work intent and reasoning
posture, but never choose a hidden provider or grant authority through model
routing.

OpenTUI's model picker is connected to the live turn path. A selection must
exist in the current catalog generation, must not be unavailable, and must be
executable by the selected provider adapter. A successful selection becomes an
the process-local default route for later turns and remains selected when the process creates a
new session. An in-flight turn keeps the model identity it captured before
provider execution. This selection remains process-local; durable role and
fallback editing is still outside the current interface.

The current disclosure path uses that task-aware opportunity plan to select a
bounded profile-eligible subset from the shared registry, resolves exact
executable schemas through `ToolRegistry`, and records selected, fallback,
rejected, omitted, unavailable, and non-executable facts. Automatic skill and
workflow loading, MCP/plugin execution, delegated/nested agents, and durable
background scheduling still belong to their dedicated runtimes; #193 exposes
the deterministic opportunity and truthful availability without claiming those
sibling executors.

## Live context, index, and memory

`falryn run` and the interactive composer open a durable index database scoped
to the active workspace root. Each process builds the current bounded index
generation before accepting a turn. The turn extracts a small set of task
queries, retrieves bounded candidates, verifies their stored content digests
against current file bytes, and admits only current excerpts to Context. The
first provider request carries the selected evidence, citations, Brief policy,
tool disclosure, omissions, and an explicit empty, unavailable, or cancelled
index state.

Completed mutating workspace, process, and Git capabilities invalidate retained
Read evidence and refresh the index before the next provider continuation.
Refresh failure does not misreport the external mutation as failed; the tool
result reports that index publication is unavailable so the model can use an
exact Read or search fallback. The current implementation publishes a complete
bounded generation. Incremental file deltas, native watcher overlays, FTS5,
structural backends, and graph retrieval are not claimed here.

Workspace-scoped memory records persist in SQLite. Relevant records are
recalled before prompt composition. A new record is admitted only after the
model attempt, terminal turn event, and durable replay all report completion;
failed, cancelled, partial, or uncertain turns are not learned.

## Session scratch resources

The live CLI and OpenTUI tool loops expose `scratch_write`, `scratch_read`,
`scratch_list`, and `scratch_discard` for temporary model work such as PR
drafts, notes, and small scripts. A write stores at most 64 KiB of validated
text as an exact artifact and publishes a durable named revision only after the
artifact commits. The model receives a
`scratch://session/<session-id>/<name>` handle, revision, digest, media type,
and byte count; it does not receive a second artifact identifier.

Scratch names are labels rather than paths. Handles cannot cross sessions,
revisions are immutable, replacement uses optimistic concurrency, and discard
creates a durable tombstone. Metadata and exact bytes survive process restart.
Scratch writes are governed mutations, but they do not create workspace files,
change Git, refresh the workspace index or language diagnostics, enter memory,
or enter prompt context unless a later tool reads them explicitly.

`run_process` accepts one exact `{ handle, revision }` through `stdinScratch`.
Falryn resolves those bytes inside the governed process call and never copies
them into argv, environment, logs, or the model-visible result. Scratch content
does not grant execute authority and `run_shell` does not accept this input.

## Product Read and Loom

The product workspace registry includes one `read_file` capability for exact,
ranged, multi-file, and Loom-recovery reads. Initial single- and multi-file
requests accept `outputMode: "loom" | "raw"`. `loom` is the default. When a
complete text file exceeds the inline limit and durable artifact storage is
available, Read stores the exact bytes once and adopts that artifact into a
workspace/session-scoped Loom manifest.

Committed Loom manifest metadata is stored in SQLite beside the artifact
records. A later Falryn process can restore the manifest, its trusted file
origin, and exact artifact membership before accepting a recovery request.
Missing, malformed, foreign-scope, or digest-mismatched recovery remains
unavailable rather than being reconstructed from model-supplied metadata.

For a digest-current indexed source, Read returns a bounded, line-numbered
outline with explicit omitted ranges and a Loom recovery handle. The same
projection is admitted to Context as file evidence with indexed freshness,
transformation lineage, and the exact artifact as its expansion. If the index
is absent, stale for that file, or has no structural records, Read falls back
to Loom's bounded head/tail projection. Recovery supports byte ranges,
head/tail, search hits, and exact retrieval; it does not require another
artifact ingest.

In a headless coding turn, the bounded Loom result is returned through the same
`read_file` tool lineage. A model can pass the opaque recovery handle back to
`read_file` for a targeted projection, and the recovered result re-enters the
same provider continuation without serializing the retained full file body.

`raw` skips indexed and Loom projection for that initial request. Small files
remain exact inline. Oversized files still obey Read's hard inline bounds and
return the exact prefix, continuation, and artifact expansion instead of
placing unlimited bytes in model context. Recovery requests keep their
existing range, head/tail, search-hit, and exact projection contract.

The TUI exposes `/loom on|off`, and headless runs expose
`--loom on|off`. `off` maps to the existing backend `raw` mode and overrides a
model request for Loom projection. The model-facing Read schema keeps
`loom|raw` because those values describe execution semantics; the human-facing
control never asks users to select `raw` directly.

## Process output, Hush, and recovery

The built-in `run_process` and `run_shell` capabilities accept
`outputMode: "hush" | "raw"`; `hush` is the default. Raw mode bypasses only
output reduction. Schema validation, effects, confirmation, hooks, scheduling,
capture, redaction, deadlines, cancellation, persistence, provenance, and
result bounds remain on the same product-tool path.

Small non-secret raw text is returned exactly in separate stdout and stderr
fields. Mandatory secret replacement preserves line and column layout. The
projection states that ordering is preserved per stream rather than claiming a
cross-stream interleave. Raw capture admits at most 6 KiB inline per stream,
Hush projections admit at most 8 KiB, and the complete model-facing process
value admits at most 16 KiB. Encoding expansion that would cross the final
bound is replaced by an artifact-backed recovery result rather than an
over-budget JSON value.

A real Hush reduction commits the exact original stream before it publishes a
recovery handle. Hush falls back to raw when reduction is unsafe, does not make
the complete model-facing value smaller, or cannot stay within its bound.
Oversized and binary streams likewise expose a Loom-backed recovery handle only
after the exact artifact is available. The handle identifies the original
invocation, capture, stream, encoding, byte length, and permitted bounded Read
operations. Missing required storage produces a partial result and never an
exact-source claim.

The model can submit that handle to `read_file` for a byte range, head/tail,
search-hit, or exact recovery. The returned result preserves the original
process invocation and capture lineage and continues through the same provider
tool loop. A process result contains only the selected Hush or raw projection;
the internal capture is not serialized a second time.

The TUI exposes `/hush on|off`, and headless runs expose
`--hush on|off`. `off` maps to the existing backend `raw` mode and overrides a
model request for Hush reduction. The model-facing process schemas keep
`hush|raw`; capture, redaction, hard bounds, artifacts, and targeted recovery
remain active when the human-facing control is off.

## Language and debugger tools

The product registry contains 30 LSP operations and 29 DAP operations. Each
operation has its own closed root input schema. Protocol-specific capability
and launch configuration maps are recursive depth-, item-, key-, string-, and
byte-bounded extension values rather than an arbitrary request escape. Unknown
root fields, invalid identities, stale generations, and malformed ranges are
rejected before transport.

The LSP surface covers server lifecycle, document synchronization, navigation,
symbols, completion and signature help, diagnostics, formatting, rename, code
actions, and call/type hierarchies. An operation that depends on an optional
server capability checks the initialized and dynamically registered capability
set before sending a request. Formatting, range formatting, rename, and code
actions return Falryn patch proposals with document-version preconditions;
language servers do not apply those edits directly.

After a completed product mutation, Falryn compares every tracked open document
with current workspace bytes, sends a bounded full synchronization only for
changed documents, saves the synchronized version, and attaches the latest
available diagnostics to the same tool result. A missing file is closed in the
language server. Files outside the bound workspace are not read.

The DAP surface covers adapter and target lifecycle, launch and attach,
configuration completion, source/function/instruction/exception breakpoints,
threads, stack frames, scopes, variables, controlled evaluation and set
operations, execution control, source/modules, cancellation, and bounded
session-artifact capture. Optional requests check negotiated adapter
capabilities before transport. Watch/hover evaluation is classified as an
observation while REPL evaluation is interactive; the derived effect is the
one used by policy, confirmation, scheduling, deduplication, and execution.

These descriptors are composed into the same production registry and runner as
workspace, process, Git, and memory tools. A provider can execute only the
strict subset selected into its immutable attempt disclosure, and every such
call passes through the unified policy, confirmation, hooks, scheduler,
capture, journal, and projection gateway. Registration alone does not imply
that all 59 schemas are placed in every prompt.

## Verification posture

The repository validates formatting, linting, TypeScript, integrity checks, and
the Bun test suite with:

~~~bash
bun run check
~~~

The interactive terminal path is qualified on macOS arm64. Linux and Windows
receive source and compiled CLI checks, but are not presented as fully qualified
interactive product platforms.

## Documentation boundary

This page and the root repository materials document source-verified behavior.
Internal product documentation is maintained separately in a private repository.
Future plans, detailed architecture, and delivery sequencing are not published
here.
