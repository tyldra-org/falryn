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
OpenAI profile that references `FALRYN_OPENAI_API_KEY`; configuration
stores the reference, never the credential bytes. Additional profiles can be
added, configured, selected, tested, logged out, or removed through
`falryn provider`.

Interactive API-key login accepts the secret only on standard input and stores
it in the operating-system keychain on supported platforms. The supervised
keychain command receives the secret over its standard-input channel rather
than an argument or environment variable. OAuth PKCE and device authorization
are accepted only through an installed official provider adapter; Falryn does
not imitate browser sessions or subscription credentials.

Human, JSON, and JSONL results expose profile, connection, account, catalog,
and revocation state without secret material. `falryn run` passes the selected
provider and normalized model catalog into a real model attempt. Assistant tool
requests are validated against a bounded, generation-bound disclosure and then
pass through policy, focused confirmation, hooks, scheduling, exact capture,
semantic journaling, and bounded result projection before provider
continuation. A headless turn cannot report completion unless a terminal model
attempt ran.

Model identity and model selection are stored separately. Falryn bundles a
strict, versioned OpenAI model catalog into the executable, provider profiles
select enabled model IDs and may reference user catalogs by identity, and
optional inline profile declarations remain the highest-priority compatibility
override. A user catalog is a bounded JSONC document at
`~/.falryn/catalogs/<catalog-id>.jsonc`, bound to one provider identity, SDK
adapter, and normalized endpoint so facts cannot cross destinations. Catalog
documents separate input modalities from output modalities and record tools,
structured output, streaming, reasoning, provider-native reasoning controls,
context limits, output limits, and completeness. Feature support is tri-state
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

Remote catalog refresh uses the official OpenAI, Anthropic, or Google Gen AI
TypeScript SDK selected by the profile. Successful provider-reported catalogs
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
profile, SDK adapter kind, and configured endpoint. Reusing a profile and
generation with a different destination or catalog is a conflict. The model
route and attempt retain that exact profile/destination binding and catalog
generation, so cache eviction, profile reconfiguration, or a later provider
refresh cannot change or erase the facts used by an in-flight or replayed
decision. Catalog and profile files never contain credential bytes.
Live inference uses the official OpenAI, Anthropic, or Google Gen AI SDK named
by the selected profile. Each adapter translates the same bounded messages,
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

The provider request contains only the disclosed tool definitions, not the
whole registered catalog. The attempt event retains the provider profile,
adapter kind, secret-safe destination identity, model route, resolved reasoning
control, catalog, capability-schema, and policy generations, tool-schema
digests, schema cost, unavailable capability families, omissions, and discovery
handle. Provider disconnects, malformed requests, cancellation, timeout,
fallback exhaustion, and uncertain effects remain typed outcomes. Completed or
uncertain consequential tool effects are not retried as fresh work.

The interactive composer and `falryn run` use the same application-owned
live-turn executor. Both paths compose Context and Brief, run the selected
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

`bun run benchmark:brief` provides a bounded matched-run scorecard against the
pinned Caveman research policy. It records complete provider usage, retries,
latency, guidance cost, required-fact fidelity, losing rows, and invalid rows
without persisting raw model responses. The scorecard requires a configured
live provider for comparative acceptance; deterministic fixtures prove only
the comparison and failure plumbing.

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

The current disclosure path selects a bounded profile-eligible subset from the
registered catalog and records selected, omitted, and unavailable reasons. The
broader task-aware opportunity planner for automatic skill, MCP, workflow,
delegation, and background-work activation is not claimed here.

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
