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

## Product Read and Loom

The product workspace registry includes one `read_file` capability for exact,
ranged, multi-file, and Loom-recovery reads. Initial single- and multi-file
requests accept `outputMode: "loom" | "raw"`. `loom` is the default. When a
complete text file exceeds the inline limit and durable artifact storage is
available, Read stores the exact bytes once and adopts that artifact into a
workspace/session-scoped Loom manifest.

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
