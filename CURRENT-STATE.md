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
| falryn run <prompt> | Run one headless coding turn through the selected provider |
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

## Provider connections

Provider profiles are stored in the typed `providers.connections`
configuration value. A fresh installation includes a selected
OpenAI-compatible profile that references `FALRYN_OPENAI_API_KEY`; configuration
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

The provider request contains only the disclosed tool definitions, not the
whole registered catalog. The attempt event retains the provider/model route,
catalog and policy generations, tool-schema digests, schema cost, unavailable
capability families, omissions, and discovery handle. Provider disconnects,
malformed requests, cancellation, timeout, fallback exhaustion, and uncertain
effects remain typed outcomes. Completed or uncertain consequential tool
effects are not retried as fresh work.

The interactive composer and `falryn run` use the same application-owned
live-turn executor. Both paths compose Context and Brief, run the selected
provider and bounded tool continuation loop, and persist the same closed
session, turn, model-attempt, and capability-invocation events to SQLite before
projecting them. OpenTUI folds those committed events into its transcript;
JSONL emits the same event values before its terminal result. A failed append,
provider connection, context composition, attempt, or replay cannot be reported
as an accepted or completed turn. Production does not fall back to the in-memory
event-store test double when SQLite cannot open.

OpenTUI's `session.new` palette action creates a new durable session before it
switches the active transcript and submission target. A failed creation leaves
the current session selected; concurrent duplicate actions coalesce, and active
turns or unresolved confirmations must settle first.

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
