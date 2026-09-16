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
| falryn config show / validate / path / set / reset / migrate | Inspect, validate, update, or remove a scoped configuration override |
| falryn profile list / show / default / use | Inspect working profiles, save defaults, or request an exact session target |
| falryn env inspect / reload | Inspect or explicitly prepare this invocation's scoped child environment |
| falryn provider list / add / use / configure / test / login / logout / remove | Manage local provider profiles and credentials |
| falryn data backup / inspect / restore / diagnostics / retention / gc / reset / uninstall | Inspect, preserve, repair, retain, collect, or preview/apply confirmed removal of Falryn-owned local data |
| falryn workspace list / show / save / load | Inspect or persist named workspace sets |
| falryn model | Inspect and revision-safely edit model policy through the shared settings service |
| falryn package | Inspect, install, activate, update, disable or remove governed packages and inspect their data/health |
| falryn peer | Inspect authorized peers, exchange messages, and read delivery history |
| falryn extension inspect / trust / scope / catalog | Inspect local declarations, confirm trust or scoped metadata preferences, and query the inert catalog |
| falryn export / import | Preview or write a versioned local export package, or import one after verification |
| falryn replay | Rebuild one stored session projection without repeating effects |
| falryn session list / show / resume / fork / rewind / replay | Inspect or navigate durable session history while preserving lineage |
| falryn task decompose / validate / progress / commit-plan | Project deterministic task structure, validation, progress, or a reviewable commit plan |
| falryn artifact list / show / get | Inspect locally stored artifacts |
| falryn completion bash / zsh / fish | Print shell completion scripts |

Commands support human-readable and machine-readable output forms. Results go
to standard output and diagnostics go to standard error.

## Configuration home and local data

Human-authored user configuration defaults to `~/.falryn/falryn.jsonc`, with
profiles under `~/.falryn/profiles/`, user-authored model catalogs under
`~/.falryn/catalogs/`, and named workspace layouts under
`~/.falryn/layouts/`. Project configuration remains
`<workspace>/.falryn/falryn.jsonc`. `FALRYN_CONFIG_DIR` is the explicit user
configuration-root override.

Version-two configuration separates global `connections`, `defaults`, `storage`
and `policy` from working-profile `overrides`. The registered settings keep their
existing consumers and scope restrictions. Version-one files retain their paths
and whole-value model-policy behavior until explicit migration. New documents
write `schemaVersion: 2` and `minimumReaderSchemaVersion: 2`.

`--profile` selects a working setup; otherwise a saved personal workspace
preference, `profiles.default`, or the reserved `default` identity selects it.
A missing `profiles/default.jsonc` is virtual and creates nothing. The loader also accepts an explicit personal workspace
association from its caller, below an explicit selection. Missing named profiles,
malformed defaults, cycles, case ambiguity and ancestry beyond eight files fail.
Each profile ID is at most 64 characters. The immutable generation reports
ancestry and revisions. `config show` and `profile show` report requested and
effective values, source contributions and application timing without starting
providers or extensions.

Profile ancestry follows project and optional private-project settings at
`.falryn/local/falryn.local.jsonc`; environment and CLI overrides follow it.
Private-project settings retain project scope and participate in workspace trust.
`config set --file-scope private-project` creates that file only on explicit save.
Version-two model preferences inherit by declared field and identity; model
changes reset omitted thinking to provider default. Model actions edit their
selected source, so route, membership and processing resets reveal inheritance.
Provider account, endpoint and executable definitions remain global in version two.

Interactive sessions expose `/profile` for inspection, `/profile use <id>` for
an inert preview, and `/profile apply <candidate-id>` for explicit application of
that exact candidate. `/profile default <id>` saves a future-session default;
`/profile workspace <id>` saves a personal preference keyed by workspace identity
in SQLite. `/profile workspace reset` removes that preference. These saves do not
switch the active session. Standalone `falryn profile use <id>` refuses without
a supported exact session transport and provides launch guidance.

Preview reports redacted source/value changes, processing preferences and each
preparation owner's requirements, costs and application class. Apply prepares
under the shared resource owner, checks source and generation revisions, then
publishes and records individual acknowledgements. A required failure retains
the previous generation. Receipts distinguish a saved file revision, published
generation and applied, pending, unavailable, failed or restart-required owners.
Session-construction owners can refuse with `new-session-required`; unsupported
privacy/offline settings do not acquire behavior merely from a profile name.

Active turns, children and workflows retain their captured model routes and
generations. New admissions use the acknowledged binding. Provider credentials
are checked again before requests; opaque continuations are isolated per binding.
Existing process and storage owners retain their construction settings and report
restart requirements when affected. Missing optional package declarations remain
visible and their values are omitted by the configuration resolver.

Escape or `/profile cancel` requests cancellation. Before publication the attempt
releases its own prepared resources. After publication the receipt retains actual
acknowledgements; `/profile reconcile` observes existing owners without repeating
preparation. File observation invalidates reviewed candidates without executing
setup. Resuming a session re-resolves its recorded selection under current trust
and a new generation; historical receipts are not proof of current application.
Model-originated profile controls require a policy owner and are denied by the
current product host. SDK callers use the same transition service and receipts.

A working profile differs from a provider connection (account and destination),
`run --mode` (execution behavior), and a browser profile (browser-owned state).

### Scoped child environments

The registered `execution.environment` object lives under `defaults.execution`
in user/project files and `overrides.execution` in profiles. It accepts `set`,
`unset`, `pathPrepend`, `pathAppend`, `inheritedNames`, `operationNames`,
`allowProject`, and an optional `preparation` descriptor. Missing fields inherit;
empty strings remain real child values. Setting and unsetting the same name in
one layer is invalid. Relative PATH entries resolve against the declaring file.
Project settings cannot broaden inherited names or operation permissions.

For example, a version-two user document can contain:

```json
{
  "schemaVersion": 2,
  "minimumReaderSchemaVersion": 2,
  "defaults": {
    "execution": {
      "environment": {
        "inheritedNames": ["PATH"],
        "set": { "EDITOR": "vi" },
        "operationNames": ["LANG"]
      }
    }
  }
}
```

Script execution requires an explicit descriptor such as
`{"interpreter":"/bin/zsh","exports":["PATH"],"required":true}`. Its default
user source is `env.zsh` beneath the resolved configuration home; project
preparation uses the exact trusted `.falryn/env.zsh`. Presence alone executes
nothing. Falryn does not edit shell startup files or mutate `process.env`.
Zsh preparation qualifies the local 5.9 interpreter at `/bin/zsh` or
`/usr/bin/zsh`; unsupported or missing interpreters are unavailable. Noninteractive
`-d -f` skips user startup files; the system `/etc/zshenv` remains possible.
These flags do not provide OS isolation: the existing sandbox policy still applies.

The session owner applies allowed inheritance, user preparation and edits,
project preparation and edits, then profile ancestry and permitted operation
edits. Consumer restrictions apply last. Only eligible user exports with
registered runtime mappings enter configuration precedence; bootstrap roots
and credential stores retain their original inputs. Project exports never enter
the configuration bridge. Process tools require explicitly allowed operation
names; Git keeps its restrictive environment and resolves its executable before
each invocation using the captured PATH.

`/env inspect`, `/env reload` and `/env cancel` operate on the current interactive
session. The standalone commands affect only their own invocation. Inspection
is inert and exposes opaque generation/status facts, rejected mapping names and
actual retained process identities, never values. Reload uses the profile
transition owner, with one 30-second deadline including admission, no automatic
retry, 64-KiB source and diagnostic bounds, and a 64-entry/32-KiB environment.
Captured source bytes and strictly framed declared exports prevent partial
output or source replacement from publishing an environment.

New work captures an immutable environment binding. Active asynchronous work,
PTYs and managed services retain their values; later launches still recheck live
authority. Required failures retain the old generation and block new dependent
launches. Optional failures omit the complete script delta and report degradation.
Watchers and receipt recovery never replay scripts. Resume prepares only after
the selected session is committed. Preparation bytes remain in memory; the safe
transition receipt records admission, publication and owner acknowledgement.

To inspect or select a working setup:

```sh
falryn profile list
falryn profile show default --format json
falryn profile default coding
falryn config show --profile coding
```

`profile default` validates an existing named profile before saving the selection.
For an existing version-one global file, preview `falryn config migrate`, inspect
its mapping and collisions, then apply with `--confirm <preview-id> --revision
<source-revision>`. Migration preserves an exact recovery original beside the
source, refuses stale previews or unsupported mappings, and uses the shared
atomic writer. A refused migration leaves the version-one source authoritative.
Unknown package settings remain inert under their qualified identity.

Configuration saves edit the existing JSONC source, preserving unrelated keys,
comments, ordering, indentation, newline style, UTF-8 BOM, and trailing commas.
`config reset <key>` removes the selected override; it retains authored parent
objects and comments and does not create an absent file. New files use the
canonical minimal format. Duplicate keys, malformed or oversized documents,
invalid scoped or composed values, and stale revisions refuse the save.
The source and candidate remain bounded to 256 KiB.

CLI, model-role, provider-profile, and registered package-key file saves share
the revision-checked writer. Cooperating conditional writers use a sibling
lock, then compare again before one atomic replacement. Replacement failure
retains the original bytes. External editors do not share that lock, and
multiple documents do not form one transaction. An interrupted writer's lock
is not removed automatically; inspect the file and the writer before recovery.
`config set` and `reset` report old/new revisions, changed paths, validation,
save, and pending publication/application separately. Model saves also report
the reload generation or retain the saved receipt with a failed reload.
Installed package data in SQLite keeps its separate transactional owner.

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

Configuration registry construction does not validate declaration defaults.
Complete validation rechecks supplied folded keys, so an invalid omitted-key
default can pass. #1088 owns that validation gap; no shipped default was found
to be invalid.

## Workspace trust

Interactive startup reviews project settings, instructions, MCP declarations,
hooks, and skills before applying project settings. The existing confirmation
sheet shows loader families, redacted relative source labels, generation changes,
and the effects of Proceed or Refuse. Arrow and page keys scroll the inventory;
the decision keys stay visible. Refuse or cancellation leaves project loaders
disabled. User configuration remains available.

Proceed commits a decision in the existing product database (migration 0013),
bound to the local actor, canonical workspace roots, exact inventory generation,
trust policy, and relevant configuration. Restart reuses only a matching record.
Changed files, permissions, user/profile configuration, or workspace identity
invalidate approval. Project configuration uses the reviewed bytes and rechecks
the generation on reload. Automatic skill and instruction discovery remains
unavailable; workspace approval does not grant tool permissions or a sandbox.
Explicit registered instruction paths use the source admission described below.

Headless `falryn run` requires a matching decision when project loaders exist.
Otherwise it returns `workspace.trust-required` without prompting. There is no
headless approval bypass. `doctor` reports trust state without creating or
migrating a database; JSONL includes `workspace.trust.reviewed` facts. Replaying
those events displays a notice and never grants trust.

Inventory work uses shared product admission and scans known loader locations
only: at most 1,024 files, 4,096 entries, 1 MiB per file, 16 MiB total, 16 nested
levels, and 30 seconds. Malformed, unreadable, linked, escaped, changing, or
over-limit declarations and failed decision writes keep project loaders disabled.
The decision contains hashes and redacted labels, not file contents or credentials.
After correcting a failure or change, reopen interactively to review again.

## Instruction sources and generations

The main terminal session, headless `falryn run`, child agents and model workflow
steps share an instruction-source owner. User or working-profile configuration
can explicitly register files in `instructions.sources`. Automatic ancestor-file
discovery, skill invocation and prompt-template expansion remain separate loader
work. Merely installing a package does not activate its instruction body.

For example, author this in the version-2 user `settings.jsonc` document. It
registers one file relative to the effective configuration home:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": {
      "instructions": {
        "sources": {
          "version": 1,
          "entries": [{
            "root": "configuration",
            "path": "AGENTS.md",
            "scope": "",
            "enabled": true,
            "references": [],
            "conflicts": []
          }]
        }
      }
    }
  }
}
```

A workspace entry names an admitted workspace root and a normalized relative
path. `scope` is its applicable subtree, or the empty string for that root.
Project settings cannot register new paths. Project files require current
workspace trust; registering a file never grants tool or executable authority.
References and declared conflicts name other registered files relative to the
declaring file. Absolute paths, parent traversal, symlinks, missing references
and reference cycles are refused. Reads compare the opened file descriptor with
the inspected revision before and after reading. Arbitrary prose contradictions are not
mechanically detected.

Compatible instructions compose in deterministic order. Source priority rises
from built-in and configured origins through user CLAUDE/AGENTS/FALRYN to project
CLAUDE/AGENTS/FALRYN. Project ancestors precede descendants. Source choice never
changes its instruction role. The shared resolver also handles skill and prompt
metadata: equal-priority skill collisions and ambiguous prompt aliases require
a choice; an explicit prompt declaration replaces only its exact same-package
conventional identity. Their automatic loaders and command dispatch are not
activated by this registration setting.

`instructions.preferences` is a version-1 object with `choices` and `restrictions`
arrays. A choice contains `kind`, `name` and `source`. For instructions, `name` is
`<root identity>:<subtree>` or `user:<subtree>`; `source` is the normalized identity
digest shown in provenance. Skill and prompt choices use their local or qualified
name. Restriction entries contain `source`, `user` and `automatic` booleans and
can only narrow invocation eligibility. Missing or malformed eligibility is
unavailable. Explicitly save preferences in user, project or profile settings;
reset the key with the existing configuration reset command. The application
owner also supports volatile session selection and reset without writing files.
The object writer validates saved controls; `config set` does not accept these
objects as a JSON command-line string. A graphical source picker is not shipped.
Missing, disabled or revoked explicit choices report unavailable with alternatives.

Each admitted turn binds complete UTF-8 bytes, identities, digests, scope and
generation before provider dispatch. Children and model workflow nodes resolve
their own admitted root/subtree and execution identity; optional
`instructionDirectory` narrows that subtree. Deterministic workflow steps add no
model call. Edits affect subsequent composition, while current provider inputs
retain their exact bytes. Current trust, enablement, scope and restriction checks
can still stop new provider requests and tool effects. Malformed replacement
content retains the last complete generation with the rejected source and reason.

The existing file watcher coalesces notifications for 100 ms, starts a rescan
within one second of a continuous burst, and rereads periodically every 30 seconds
to recover missed notifications. Admission also performs a full bounded scan.
Reload uses shared product resources. Source reads are limited to 1 MiB each,
admitted content to 8 MiB, metadata and parsed-content caches to 16 MiB each,
and reference depth to 64. The source publication queue admits at most 64 pending
operations with a 30-second deadline. Inspection pages contain at most 100 entries
or 256 KiB; this is not a total catalog quota. Registration and preference documents
accept at most 1,024 entries. Required content that cannot fit the prompt budget
fails instead of being silently truncated.

Native `instructions.resolved`, `instructions.rejected` and `instructions.revoked` facts retain bounded,
body-free provenance for JSONL, replay, export and transcript notices. Provider
history retains effective content under the existing history policy. Generation
and content digests are separate, so an unchanged rescan or inspection does not
report new effective instruction content. Parsed products are keyed by source,
content digest and configuration generation; expanded arguments and rendered
sensitive prompts are never cached by this owner.

## Executable sandbox policy

The existing command, capture, PTY and managed-service launchers consume
`SandboxPort`. Application authorization, workspace trust, scheduling and
credential resolution remain separate controls. Built-in workspace commands
use the explicit installation compatibility default, `off`, which provides no
OS filesystem, network or process isolation. Executable extensions cannot use
that exception and remain unavailable through their existing activation rules.

The user-only `tools.sandbox` object has `version: 1`, `mode`, `readRoots` and
`writeRoots`. Project/profile configuration and model arguments cannot select a
weaker mode. `strict` admits the primary workspace for read/write and explicit
additional roots, requires offline execution, and denies subprocess creation.
The current macOS adapter qualifies Darwin 25.6.0 and 27.0.0 arm64 with pinned
`sandbox-exec` identities. The 27.0.0 policy additionally permits the dyld self-policy
query, descriptor/library-validation operations and `/dev/urandom` reads needed
by the qualified Python runtime. Other hosts, broader network/process controls and
strict PTYs are unavailable. `degraded` is unavailable because no weaker
boundary is qualified. A strict refusal never retries without isolation.
Missing accepted configuration or unread sources refuse workspace launches.

The adapter also permits runtime reads from `/System/Library`, `/usr/lib`,
`/Library/Apple`, the executable and root-directory entry, plus metadata for
admitted-root ancestors and existence checks through verified macOS path aliases.
The version-3 profile permits named hardware queries and own-process metadata,
and denies numeric sysctl and ptrace syscalls. It supplies explicit environment
and standard I/O.
It does not provide CPU/memory containment or protection from a privileged host
or kernel compromise. The system helper is deprecated. Debugger attachment was
denied with and without the adapter on the qualification host; that observation
does not establish an independent adapter restriction.

`run_process` and `run_shell` can propose `sandboxExpansion` with extra read/write
roots. A separate focused confirmation shows canonical destinations and binds
one launch to the invocation, argument-aware effect, input digest, catalog and
policy generations, task, and expiry. The grant expires within 60 seconds and
cannot authorize a second launch or modify a running child. Receipts are bounded
to 32 launches plus one terminal refusal and 64 KiB per invocation; each root
list has at most eight entries. Existing execution budgets still apply.

Effective boundary and cleanup receipts reach tool/model output, the semantic
journal, CLI human/JSON/JSONL output, terminal transcripts and replay. Export
preserves the typed policy facts and redacts credential handles. `doctor`
reports selected workspace policy and platform availability, and identifies
trusted vault/provider-login helpers as host operations under `off` policy.
Those authentication helpers are outside workspace isolation. Managed-service
restarts recheck policy; an expired or changed invocation cannot authorize a
new launch. Existing process supervisors retain stop and cleanup ownership.

Reproduce hostile source/compiled child checks with
`bun test src/integrations/security/sandbox-qualification.test.ts`, product
composition with the coding-run and shell-attachment suites, and packaged
composition with `bun run smoke:macos-arm64` after `bun run build`.
`bun run tools/benchmarks/sandbox-scorecard.ts` measures raw disabled, supervised
off and strict startup and 64 KiB read/write workloads separately. Qualification
covers APFS mount aliases, filesystem escapes, live TCP/DNS/proxy/listener
controls, subprocess/daemon creation, parent signals, explicit environment and
closed inherited descriptors. Source and compiled positive controls also prove
that strict mode blocks reading a sibling process’s initial environment and
the tested ptrace syscall. Privileged mounting and kernel exploits are
outside this boundary. These are development results, not a release or a
browser/computer-use isolation claim.

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

`provider add` and `provider configure` infer an installed official API SDK only
from an exact provider identity: `openai`, `anthropic`, `google`, or
`commandcode`. Their official destinations receive their provider's canonical
environment reference and default to remote model discovery. The distinct
`openai-codex` identity has no API-key reference or direct HTTP destination and
defaults to static discovery. An unfamiliar provider requires an
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

The installed `openai-codex` policy adapter keeps ChatGPT/Codex subscription
identity separate from the `openai` API-key destination. OpenAI's public Codex
documentation describes authentication owned by Codex and an experimental
`codex app-server` delegation boundary, but no third-party OAuth client
registration or subscription-backed HTTP contract for Falryn. Both authorized
methods therefore return
`openai-codex-third-party-authorization-unavailable` before any browser, device,
token, vault, or provider transport work starts. The profile schema binds the
reserved identity and adapter in both directions and requires a null endpoint,
null credential reference, and static discovery. API-key login, provider tests,
automatic discovery, and model handoff return the same policy result. Converting
an API profile with a credential reference is refused until logout. Falryn never
silently switches this identity to usage-based API billing.

Installed authorized-login adapters enter one versioned registry keyed by the
exact provider, SDK adapter, and method. Each attempt binds the current registry
generation before network work starts. The shared coordinator implements PKCE
S256, random state, bounded random-port loopback callbacks or a strict
adapter-declared `127.0.0.1` redirect, provider-approved manual-code fallback,
bounded device-code polling, cancellation, and a hard deadline. A browser
receives only a local loopback URL in its argument vector;
the provider URL and OAuth state stay inside the loopback broker. Headless runs
do not launch a browser, and ordinary diagnostics never print provider URLs,
callback codes, or device codes.

Successful exchange stores one versioned access/refresh credential bundle in
the operating-system vault and persists only its opaque reference plus safe
account metadata. Public results carry a secret-free terminal receipt with the
attempt, adapter, generation, method, outcome, and structural failure code.
Immediately before provider handoff, an expired authorized connection refreshes
through its bound adapter and records the replacement reference before vault
placement. Connection schema 2 reads schema 1 and atomically publishes profile
changes with bounded cleanup intentions. Refresh, configure, login rollback,
logout, and removal share `credentialRemovalIdentity` equality over store,
locator, consumer, and nullable account label. A stale publication preserves the
previous reference; a shared replacement is never deleted as rollback.

Within the owning Bun process, current profiles and admitted provider handoffs
retain their credential generation. Product streams bind the current profile
on each attempt and release it on iterator settlement, cancellation, or failure.
Profile mutation contention returns a retryable stale-state result without
adding a scheduler. Cleanup retries reread current ownership; interrupted local
deletion first observes presence. Failed, unavailable, and uncertain outcomes
remain in configuration for reconciliation. Uncertain remote revocation is not
blindly repeated. Logout reports remote revocation and local deletion separately.
This shared lifecycle does not claim
that a provider supports subscription login until an installed adapter
advertises the method as available.

CLI, JSON, and JSONL provider actions project the same authorization receipt
and safe account state. OpenTUI's provider resource view projects the effective
authentication state and method from the same selected connection; it does not
copy protocol codes or credential values into the renderer.

Human, JSON, and JSONL results expose profile, connection, account, catalog,
and revocation state without secret material. `falryn run` passes the selected
provider and normalized model catalog into a real model attempt. Assistant tool
requests are validated against a bounded, generation-bound disclosure and then
pass through policy, focused confirmation, hooks, scheduling, exact capture,
semantic journaling, and bounded result projection before provider
continuation. A headless turn cannot report completion unless a terminal model
attempt ran.

The normal product request in `src/application/context/product-model-input.ts`
selects text output. Provider output contracts and JSON/JSONL event serialization
do not establish caller-selected final-answer schema validation. That integration
remains separately tracked in [#1091](https://github.com/tyldra-org/falryn/issues/1091).

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
Every live model selection is bound to the exact provider profile, provider,
and model tuple rather than a bare model ID. Role routes, fallbacks, explicit
selection, recursion tracking, and routing receipts retain that full identity,
so the same model ID can safely exist under multiple accounts, endpoints, or
providers. The interactive model picker shows the provider display name and
profile beside each model, and its selection notice repeats all three identity
parts. Malformed, mismatched, missing, unavailable, or transport-ineligible
selections fail without replacing the current model. Persistent model-role
settings use the shared `model roles|configure|reset|migrate|clear` CLI actions
and the OpenTUI panel reached through `/model roles`, `/model configure`, or
`/settings models`. Mutations require the inspected file revision.
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

Model processing preferences use the existing `models.policy` envelope and
revision-checked model settings actions. Optional `processing.mode` selects
`provider-default`, `standard`, or `fast`; optional `processing.fallback` selects
`stop` or `allow-standard`. Omitted fields inherit, finally resolving to
provider-default/stop. The Fast supporting-model role remains independent.
The shared product attempt path accepts a per-call preference, qualifies the
exact provider/model/destination/operation and installed transport version,
and captures an immutable binding before admission. Supporting route resolution
does not copy main-only processing into child defaults.

Qualified processing reserves the maximum applicable published price,
including cache modifiers. Provider-default cannot establish a hard cost cap
from ordinary-only prices without qualification covering all possible tiers.
Local account authority and remaining budgets are checked after queueing.
Normalized observations keep requested and actual processing separate;
contradictory reports remain unknown. The existing journal, export and replay
codecs preserve the binding, bounded observations and conservative usage-cost
settlement without executing requests. Missing legacy observations remain
unrecorded. Direct OpenAI API-key connections now qualify explicit Standard
(`service_tier: default`) and Fast (`service_tier: fast`) through both installed
SDK transports. Provider-default preserves omitted Chat tier or the existing
Responses `auto`/`default` declaration. Fast is qualified for exact
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini`, and `gpt-4o-mini`
on both endpoints, and `gpt-5.3-codex` on Responses only, at
`https://api.openai.com/v1`. Unfamiliar models, custom endpoints, the legacy
`gpt-5.6` alias, and older long-context models without complete Fast coverage
remain unqualified. Missing price modifiers remain unknown and cannot establish
a hard cost cap.

OpenAI terminal response tiers and Chat stream tiers normalize `fast`/`priority`
to Fast and `default` to Standard while retaining the bounded native label.
Missing or unfamiliar values produce unknown plus a fixed diagnostic. A successful
Standard downgrade is consumed once and settles against captured ordinary rates.
The product connection owner binds local account configuration and rechecks it
before submission; upstream entitlement and capacity remain provider decisions.
Processing adds no capacity, SDK retry, helper request or subscription authority.
Controlled HTTP fixtures exercise the real product factory and attempt runner,
including premium admission, actual-tier journal receipts, quota and cancellation.
Continuation fixtures preserve prompt-cache affinity, stateless/stateful tool
results and native tool-search replay across Fast-to-Standard changes. Live
account access and latency gains have not been measured. Other providers retain
ordinary behavior through this contract.

`/model` includes Processing speed. `/fast` inspects without submitting a request;
`/fast on` requests Fast, `/fast off` explicitly requests Standard, and
`/fast reset` removes the session override. The palette uses the same actions.
The default scope is the current session's main model and its next admitted
request. Active turns and children retain captured processing. Child and workflow
routes use their own defaults; a transient main setting does not grant premium
child work. Inspection shows exact account/model/thinking, eligibility and known
price bounds or uncertainty, with Stop/Allow Standard as a separate fallback
preference. Unknown prices cannot establish a hard spending cap.

`falryn model processing inspect|set|reset --scope session|user|profile` exposes
the shared actions. Set requires `--mode provider-default|standard|fast` and
accepts `--fallback stop|allow-standard`. Saved mutations require `--revision`
from inspection (`absent` for a missing file); `--role` targets a role's preference.
Session mutation requires an attached authorized host; a standalone command
cannot change another live process by supplying its session ID. Reset removes
only the selected processing preference. Saved changes retain ordinary publication
and pending/applied receipts. Model/account transitions revalidate processing
before replacing the active binding.

The status distinguishes next-request preference from active/last actual speed.
Transcript, JSONL and durable history project the same bounded provider receipt;
unknown and successful Standard downgrades remain visible. Preference edits do
not emit completed attempts or model-switch events. Host model-service query,
preference and receipt declarations are available to later SDK/protocol consumers;
those transports are not enabled by these controls.

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
`prompt_cache_key`. Anthropic receives a `cache_control` breakpoint on the last stable system
block, using the qualified transport declaration's `5m` default or supported
`1h` TTL. It does not place a cache marker on conversation messages. Google reports provider-managed cache usage.
The Generate Content adapter can consume an exact cached-content binding, but
creation, reuse, expiry, deletion, restart recovery, and retention are not yet
implemented. Without that binding, an explicit-cache request sends the exact
uncached prompt. Command Code keeps Falryn's stable prefix but lets
its Provider API manage cache locality without leaking OpenAI- or
Anthropic-specific controls through its protocol adapters. Attempt events retain
the selected mechanism, eligibility threshold, cache digests, and stable
boundary, never prompt text or credentials. Normalized usage keeps
provider-reported cache reads and cache writes distinct.
The nominal stable capability brief includes plan, selection and health facts;
changes can alter its digest, but their cache-hit impact has not been measured.
[Conversation-prefix reuse](https://github.com/tyldra-org/falryn/issues/1098)
remains a follow-up. No sustained cache-hit rate or comparative cost result is
claimed by the current implementation.

`falryn extension inspect <path>` reads a local package directory and prepares
inert declarations from Agent Plugins 1.0.0 `plugin.json`, immediate
`skills/*/SKILL.md`, root `mcp.json`, non-recursive `prompts/*.md`, and strict
version-1 `org.tyldra.falryn` metadata. Human, quiet, JSON, and JSONL output
report identities, declared effects and permissions, compatibility, dependency
resolution and bounded diagnostics without printing instructions, environment
values, headers or raw manifest metadata. Inspection does not execute package
code, fetch dependencies, install packages or activate bindings. It reads scoped
trust decisions from an existing product database; opening that database may
apply the normal schema migrations. An absent database stays absent on inspection.
Invalid portable components leave valid siblings inspectable; malformed core
or Falryn metadata rejects the package.

`falryn extension trust <path> --input <request.json>` previews an `approve`,
`revoke`, or evidence `refresh` decision. The JSON request is bounded to 65,536
UTF-8 bytes and contains `action`, `expiresAt`
(epoch milliseconds for approval, null for revocation), and optionally the exact
`confirmation` returned by the preview. Approval expires within 30 days. A
revocation may name a prior `decisionKey` after the source changes; the preview
shows the contributions recorded with that decision. Only the same local actor
and scope can revoke it. Confirmation binds the subject, owner, evidence, policy,
revision, expiry, action and contribution identities. No prompt or implicit
approval occurs in headless mode.

Evidence refresh uses `expiresAt: null` and a strict version-1 `verification`
object containing `keys`, nullable `signature`, and nullable `advisory`. Keys
are explicitly selected by the invoking user/host, never read from package
metadata. Each has `role: publisher | advisory`, `id: sha256:<DER bytes>`, and
`publicKey` containing canonical base64 DER/SPKI Ed25519 bytes. At most 16
distinct role/key pairs are accepted; each encoded key is at most 1,024
characters. A proof contains `algorithm: ed25519`, `keyId`, the canonical base64
64-byte `signature`, and `statement`. Verification signs Falryn canonical JSON
UTF-8, including the exact `PackageIdentityV1` as `subject` and integer
`issuedAt`/`expiresAt` milliseconds with a positive lifetime of at most 30 days.
The package statement's type is `falryn.package-integrity.v1` and includes a
publisher identity digest. The advisory statement's type is
`falryn.package-advisory.v1` and includes a positive `sequence`, `status:
clear | quarantined | revoked`, and at most 32 `advisoryIds`.

Refresh first previews the resulting facts and a confirmation token. Repeating
the exact request with that token writes one evidence revision. It does not
approve the package. Verification proves a supplied key signed the exact
package identity; it does not certify the claimed publisher's real-world
identity, safety, or curation. Invalid signatures deny eligibility. Future or
expired evidence remains stale, including offline. Missing signatures are
unsigned, and missing advisories remain unavailable. Attestation, certificate,
transparency-log verification, automatic key discovery and advisory networking
are unavailable. A refresh cannot lower an established advisory sequence,
remove it, or change its statement at the same sequence. Rejected refreshes
leave prior evidence intact; inspect the failure before retrying. A signed
withdrawal needs a higher sequence and does not restore an old approval.

`falryn package <action> --input <request.json>` implements local package
installation transactions and explicit health checks. Actions are `inspect`, `data`, `health`, `install`, `update`,
`rollback`, `disable`, `uninstall`, `recover`, and `enable`. Every request names
`packageId`, a UUID `operationId`, and `expectedRevision`. Install/update also
name `sourcePath`; rollback names a previously returned `versionDigest`.
Mutations first return a `confirmation` digest. Repeat the same request with
that digest to apply it. A committed operation ID replays its recorded receipt
without repeating the mutation; changed intent under that ID is refused.

Installation validates complete local package bytes and the installed dependency
closure without running scripts. Invalid entries, incompatible candidates and
missing dependencies fail closed. Dependency inventories are bounded to 256
packages per validation. SQLite migration 0014 owns package revisions,
dependency locks, version ownership and operation receipts. Inert byte containers
live under the state root's `packages` directory with owner-only permissions.
Publication writes and flushes the candidate under the SQLite writer before
switching the current generation. Interrupted candidates remain recorded for
`recover`; neither partial files nor orphan candidates become installed.

Updates retain prior versions. Rollback revalidates exact cached bytes and host
compatibility without fetching or restoring grants. Declared configuration and
state migrations stage with candidate bytes; incompatible rollback preserves
the installed version and its state.
Update and rollback refuse a digest change required by an installed dependent.
Uninstall refuses installed dependents. Its `retention` choice defaults to
`retain`; `remove` claims owned versions for deletion after logical removal.
Cleanup processes at most 64 versions per operation and reports remaining or
failed cleanup explicitly. `recover` retries claimed cleanup and discards
uncommitted candidates while preserving retained versions. Source directories
and unrelated files are never removal targets. Inspection reports the current
digest, revision, retained count and pending cleanup; save version digests from
receipts for exact rollback. Human, quiet, JSON and JSONL expose the same facts.

Installation and trust approval do not create executable bindings. `package enable`
without a native activation request still returns `activation-owner-unavailable`.
The explicit native tool path below publishes only its selected contribution
identities. Remote acquisition, module services, full-user execution and other
native-kind adapters remain unavailable. Scope controls remain metadata preferences.
Package cache files retain exact source bytes and are not redacted artifacts.
SQLite-only backups and session exports do not include those bytes or confer
package authority. Removing the state root removes both lifecycle records and
its package cache. Older binaries require a compatible database backup.

`falryn package health --input request.json` explicitly checks one installed
contribution selected by its exact digest in `health.contribution`. Trust, scoped
enablement, installed revisions and locked dependency compatibility are checked
before confirmation and each protocol request. Preview starts no code. Confirmed
health uses the product resource owner and the qualified macOS arm64 strict
sandbox with package reads and its fixed system-runtime read allowance, no
writes, network or children, and an empty environment. Other hosts, loaders, module services and full-user execution remain
unavailable. Required CPU or memory controls, including inherited limits, refuse
admission because the native profile cannot enforce them.

The native `falryn-package-health/1` JSON-line peer handles initialization, two
health requests on the same child, and shutdown. Frames bind exact attempt,
package, contribution, generation and request identities. Output is capped at
64 KiB, frames at 16 KiB, requests at five seconds and the whole attempt at
30 seconds. Durable occupancy allows four unresolved attempts per state store
and one per package; three failed attempts quarantine the exact generation.
Migration 0023 records launch intent, process birth and terminal facts. Reusing
an operation ID returns its receipt without execution. `health.recover: true`
previews identity-checked cleanup for that same operation; unknown birth evidence
keeps replacement fenced. Results report termination, retained files, uncertainty
and timings without raw child output, argv, credentials or recovery paths.
Source and compiled CLI journeys cover successful, hostile and cancelled peers.
Health never enables native catalog bindings or automatic model invocation.

`falryn package enable --input request.json` accepts a separate `nativeActivation`
object with `scope` (`user` or `workspace`), `expectedRevision` (the activation
revision, initially 0), and `contributions` (exact inspection identity digests).
The outer `expectedRevision` is the installed package revision. Preview binds
current trust, scope, installed bytes, dependency locks and configuration; repeat
the same request with its returned `confirmation` to save activation. Migration
0024 stores the allowlist and idempotent operation receipt under the existing
SQLite writer. Scope preference, installation and approval alone remain inert.
Session, process and development activation require an unavailable live host control.

The first native owner registers offline observation tools whose governed native
executable declares `falryn-package-tool/1`, a behavior family, closed object input
and output schemas, and no filesystem, network, secret, child, configuration,
state or host-service authority. It uses the same qualified macOS arm64 sandbox,
installed admission, process supervision, occupancy, quarantine and recovery
store as package health. CPU and memory ceilings remain unavailable and fail
closed. Registration starts no code; an unprobed but preparable tool retains
unknown health. Unsupported native kinds and disabled contributions stay
inspectable with an unavailable binding. A failed candidate leaves the prior
complete publication intact.

Enabled tools with `choice.explicitOnly: false` can enter ordinary opportunity
planning. Only selected schemas enter the model request, and invocation crosses
the normal policy, trust, hook, resource, capture, journal and result gateway.
Headless composition and each new shell turn refresh native publication; in-flight
attempts retain immutable bindings. Disable, update, uninstall, changed scope or
revocation rejects a stale tool before execution. Delegation preserves the same
native registry and trust facts. Model-irrelevant package payloads remain outside
model context. Exact package catalog identities remain inspectable when aliases
are disabled or ambiguous.

The tool protocol is versioned JSON lines, not JSON-RPC. Requests echo the
health binding fields (`protocol`, `attempt`, `package`, `contribution`,
`generation`) and use IDs 1–3 with methods `initialize`, `invoke`, `shutdown`.
Only `invoke` adds `input`. Responses contain the same binding, ID and method
plus `result`: `"ok"` for initialization/shutdown, or the declared output object
for invocation. They omit `input`. Extra keys, forged identities, unsolicited or
late frames and schema violations fail closed. Inputs are capped at 8 KiB,
output objects and frames at 16 KiB, combined output at 64 KiB and total time at
30 seconds, narrowed by declared limits. Every call owns one short-lived child.

Native attempts use a durable operation UUID derived from the gateway invocation
ID. Replaying it never repeats code. Unresolved process or retained-file failures
include `operation=<uuid>`. To inspect or clean that attempt, use `package recover`
with a new outer operation UUID, the exact package ID, its current installed
revision and `nativeRecovery: { "operation": "<attempt-uuid>" }`; preview and
confirm the recovery token. Cleanup uses recorded birth identity, not PID alone,
and never invokes the package again. Unknown ownership remains fenced. A known
output remains in the attempt record even when cleanup fails; cleanup success
is separate from semantic invocation success. Source and compiled model fixtures
verify a real native output, and source tests verify revocation between disclosure
and invocation, disabled aliases and next-turn replacement.

`falryn package data --input request.json` exposes version-1 host-owned
configuration and state operations. Its outer request binds the installed package
revision; nested `data.expectedRevision` binds the data document. Inspection
returns usable scope identities, declaration metadata, quota use and effective
configuration. Configuration uses qualified `packages.p<digest>.<key>` paths in
the normal registry, files, profile, environment bridge, `config show`, and
`config set`. Invalid refresh retains the last valid generation. Package update
validates candidate declarations and current normal sources before publication.

SQLite migration 0020 stores package documents, operation/recovery receipts,
inert imports and artifact ownership. State supports bounded reads, metadata
pages, revision-guarded writes, tombstones, namespace reset and guarded rollback.
User, workspace and session state is durable; host-owned process/development
stores are ephemeral. Native session fork copies only declared copyable records
under fresh session identities. Session closure applies declared removal policy.
Pure bounded rename/default/remove migrations run with package publication;
failed or incompatible migrations retain the previous complete publication.

Export omits sensitive values and credential references. Native session exports
carry admitted session state with the `falryn.package-data` schema family.
Import retains those records separately, even without an installed package;
replay shows historical metadata without state payloads or execution. Adoption
is a separately confirmed revision-guarded action into one durable layer or state
scope, with retain/replace outcomes and a durable recovery receipt. Artifact
references require existing user-supplied native artifacts with matching metadata
and owned reachability; standalone data export omits artifact bytes explicitly.
Retained recovery and artifact claims are bounded and are not silently pruned.
The supervised version-1 configuration/state port is contract-tested; connecting
running contributions remains with the native activation owner.

`falryn extension scope --input request.json` previews and confirms exact
package-wide or contribution-specific enabled, preferred and explicit-only
choices. Its strict request contains `action: "scope"`, `packageId`, `scope`,
and a nested `request` with UUID `operationId`, `expectedRevision`, exact
`packageIdentity` digest and `choice`. A confirmed retry repeats the returned
`receipt.confirmation` inside `request`; a new intent needs a new operation ID.
Session scope additionally names an existing durable `session` whose saved
workspace binding matches the current host-resolved roots. Missing legacy or
foreign bindings produce `session-workspace-unverified`. User and workspace
choices persist separately from installation and trust. Workspace choices bind
the host-resolved root set and current trust generation. Existing exact choices
can be narrowed after package trust revocation; widening still requires admission.
Process/development bindings belong to one host admission. Cross-process CLI
writes explicitly return `scope-requires-live-host` rather than unusable previews.
Built-ins and standalone owners have separate identities, not synthetic packages.

`falryn extension catalog` returns current compact package descriptors, including
disabled and unavailable states. Optional `--input` accepts an `action: "catalog"`
request with an exact catalog-bound `query` and optional `session`. Queries default
to 32 entries and allow 256. Continuation handles bind the query and catalog;
changed controls, package bytes, lifecycle, compatibility or trust reject stale
handles. Human, quiet, JSON and JSONL expose the same bounded facts. An absent
database remains absent during inspection and previews.

SQLite migration 0019 stores revision-guarded scope choices and idempotent
receipts. Reconciliation selects current authority keys before admitting at most
1,024 controls, 4,096 descriptors and 16 MiB compact metadata within 30 seconds.
Unrelated scope history stays stored. Failed or stale reconciliation preserves
the previous snapshot. These are operation bounds, not a stored-history quota.
Package descriptors have no native binding and remain unavailable even
when their scoped preference is enabled. Rehydration does not prepare full
instructions or schemas, resolve credentials, start code, or contact a model.

Headless runs and new interactive sessions rehydrate before producer composition.
The same migration stores a version-1 historical catalog with `session.started` and
the session record. It retains at most 32 entries and 49,152 bytes, with total
and omitted counts, exact owner/generation facts and no executable bindings.
Session show, fork and replay expose these historical facts; resume also reports
current reconciliation separately and remains cursor-only. Export/import and
fork preserve provenance without copying active scope controls. OpenTUI resource
inspection labels its session-start catalog historical and non-executable.
Runtime workspace-root replacement and native package execution are not added.

Trust decisions use version-1 records in the product database's migration 0012,
with 128 KiB per record and transactional revision checks. The current CLI uses
local-user scope and policy generation 1. Source ownership comes from observed
filesystem device, inode, uid and gid, not manifest authorship. Inspection reads
explicitly refreshed signer and advisory facts when present; otherwise those
facts remain unavailable. Computed hashes are not verified publisher evidence. Trust,
evidence freshness, compatibility, health and availability are separate fields
in human, quiet, JSON and JSONL output. Package and contribution identities stay
visible independent of their short names. Approval never installs or activates
content or supplies a full-user execution grant.

The shared capability trust owner evaluates exact subject, owner, actor, scope,
policy, evidence and expiry at admission. Plugin and MCP tool bindings require
its affirmative result in addition to existing tool policy; the gateway checks
again after hooks and immediately before the native runner. Missing trust stays
unavailable in the product catalog. Health/card projections retain the same
trust facts rather than deriving approval from a healthy status. No live package
runtime or signature/advisory fetcher is added. Evidence is reread at admission,
and CLI approval writes compare its binding within the transaction. Expired or changed approvals
require a new preview. Revocation survives policy changes and expiry; restoring
exact package bytes only restores eligibility while its prior approval remains
valid and unrevoked. Trust records are local authority, not portable grants in
session exports. Older binaries refuse the newer database schema; downgrade
requires a compatible backup. Restoring a whole database can restore its old
decisions, so inspect and revoke them before continuing.

Migration 0017 adds package evidence (16 KiB per record), exact full-user grant
records (512 KiB), and append-only redacted metadata receipts for evidence,
CLI approval/revocation, and grant revisions. No public-key material, raw
signatures, argv values, credentials or executable bytes enter these records.
`FullUserGrantIdentityV1` binds the complete package/contribution/source,
explicit nullable provenance, schema and lock digests, entrypoint/helper/loader
identities, target OS/architecture/ABI, `most-specific-v1` selection, access and
cleanup digests, scope/workspace set, platform qualification and policy
generation. Helper paths are unique and sorted. Durable grant ID/revision and
explicit/automatic/suspended/revoked state are separate from this immutable key.
Automatic allowance requires a later revision of an explicit allowance.
The shared admission owner compares existing references, denies changed
identity/evidence/policy, and persists suspension with a receipt. A stale
reference cannot overwrite a newer decision. Package quarantine, rollback and
restore enforcement remain separate lifecycle work; this owner produces trust
facts and grant eligibility, not a second package-disable state machine.

There is no full-user grant creation/import command, execution profile, qualified
launcher or activation UI on this path. Those consumers must supply the complete
host-qualified identity and an existing grant reference. Unknown loader,
platform or helper qualification must remain unavailable. The ordinary trust
approval above never substitutes for that grant.

The extensions domain owns six strict version-1 identity codecs and canonical
UTF-8 JSON with NFC strings, LF line endings, sorted keys and SHA-256 digests.
Exact file bytes have separate integrity hashes. Executable declarations must
name locked package files; their execution mode is a declaration, not a sandbox
or an executable admission. A missing or non-semver portable version has a null
normalized package version and cannot serve as a dependency candidate. The
pinned semver resolver uses caller-supplied inventories, exact digest locks,
prerelease opt-in and dependency-first ordering. The standalone preparation API
retains skill, prompt and MCP-connection source ownership without inventing
installed packages. These records do not replace the live registry's existing
identity model. The separate package lifecycle consumes these prepared identities.

Directory reads reject unsafe paths, skip unsupported links/special entries
with diagnostics, and verify observed file identities before returning bytes.
Inspection limits are 4,096 entries, 64 directory levels, 1 MiB structured
metadata, 16 MiB other files, 64 MiB total and a 30-second read deadline.
Declarations are capped at 1,024 contributions, metadata depth 32 and 128
diagnostics plus an omission count. Dependency resolution permits 256 candidates,
32 dependency levels and 10,000 search decisions. Missing batch declarations
default to serial, foreground, non-native-batch metadata. Unknown Falryn fields
and unsupported schema vocabulary fail closed.

Falryn publishes the registered built-in product-tool inventory into one
immutable shared capability registry generation. Its strict contribution
contract covers tools, MCP tools/resources/prompts, skills, hooks, plugins,
commands, agents/subagents, workflows, providers, and UI contributions without
treating those primitives as one executor. Existing tool capability IDs remain
canonical; `ToolRegistry` continues to own exact schemas and runner bindings.
Installed inventory has no arbitrary entry quota, while queries default to 32
entries and are capped at 256. Current production loaders contribute the
built-in product tools, including the delegate control. Live extension, workflow, package-provider, and
UI loaders remain with their owning issues.

Product publication now requires an explicit native runner binding before
marking a registered tool executable. The unbound `open_pty` descriptor remains
unavailable. Invocation still checks policy, disclosure, generation and shared
resource admission; a registered descriptor alone cannot execute. The
capability registry still keys identity by kind plus namespace/name. The separate
inert Extensions catalog preserves exact source-owner-qualified candidates and
scope-aware alias resolution without changing executable registry identity.

Provider tool batches now pass through the common capability composition owner
in the product attempt runner. The same application port accepts dependency
graphs with exact capability IDs, versions, effects and catalog generations.
It rejects cycles, duplicate nodes, unknown edges and invalid inputs before
effects. Graphs are limited to 64 nodes, 128 dependency/transfer edges and
256 KiB of JSON, with four concurrent nodes by default and a ceiling of sixteen.
The thirty-minute maximum deadline also respects the inherited task deadline.
Every node uses the existing tool gateway and task allowance.

Dependent nodes receive only completed, schema-valid, nontruncated output;
transfers are capped at 64 KiB each and 256 KiB in total. Incomplete predecessors
block dependents, while independent nodes can settle. Cancellation without
termination proof remains uncertain. Native owners retain artifact ownership.
Digest-only graph provenance, topology and node statuses persist with invocation
events; replay rebuilds those facts without executing tools. Duplicate graph
admission cannot repeat effects. Existing events without composition fields
remain readable. Live MCP, package and browser hosts are not added
by this common runtime path.

### Configured MCP transports

`connections.mcp.servers` in the user configuration declares stable IDs for
stdio or Streamable HTTP peers. `falryn mcp inspect` reads lifecycle facts without
starting a peer. `falryn mcp probe <server-id>` explicitly opens one connection,
validates protocol readiness, and closes it before returning. Its `probe` result
records readiness; `connections` records the final stopped state. Human, quiet,
JSON and JSONL output share those facts. Probe failures retain a named code.

Headless and terminal model runtimes publish `mcp_inspect`, `mcp_connect`,
`mcp_request` and `mcp_stop` through the existing registry, confirmation, resource
admission and tool runner. MCP-related tasks or explicit discovery disclose the
controls. No peer starts until an admitted connect request. Requests require the
captured configuration and transport generations and bounded JSON object text in `paramsJson`. Results use normal invocation history, projection and replay; replay
never reconnects or repeats a remote effect.

The integration pins `@modelcontextprotocol/client` 2.0.0. The default protocol is
2026-07-28: HTTP uses protocol/routing metadata without initialize or a protocol
session ID. `protocol: "legacy"` explicitly selects older negotiation. The SDK
handles protocol validation, correlation, pagination and unsupported server
requests. Falryn owns transport lifetime and live authorization.

Stdio uses the managed process owner, isolated protocol stdout, and only the
selected `environmentNames` from the prepared scoped environment. Diagnostic
stderr stays in the managed owner's bounded 64 KiB replay and is never projected
as MCP content. Environment or
selected connection changes fence old replies; reconnect closes the old owner
and captures a new generation. HTTP accepts HTTPS or loopback HTTP, rejects URL
credentials, queries, fragments and redirects, and sends only its optional
`credentialEnvironment` bearer reference. Configured secret values are redacted
from returned content. Other server/provider values are not inherited by stdio.

Limits are 64 configured identities, 1 MiB per protocol message, 32 pending
requests per endpoint, a 30-second deadline, and three start attempts per endpoint
in 30 seconds. SDK list walks stop after 16 pages. A safe read may retry once after
HTTP 502/503/504 within its original deadline. Tool calls are never retried after
an uncertain result. Shutdown aborts and settles pending requests before reporting
stopped. Cancellation, configuration changes and disconnects preserve uncertainty
for a sent tool call.

Stdio is available on POSIX hosts with owned process-group termination. Windows
stdio returns `mcp-stdio-platform-unavailable` before launch; HTTP remains
available. Unsupported protocols and missing credentials do not publish a ready
binding. General MCP catalog publication, subscriptions, automatic peer discovery,
OAuth enrollment and server-initiated sampling remain separate capabilities.

Example user configuration:

```json
{
  "schemaVersion": 2,
  "minimumReaderSchemaVersion": 2,
  "connections": {
    "mcp": {
      "servers": [
        { "id": "remote", "transport": "http", "url": "https://example.com/mcp", "credentialEnvironment": "MCP_TOKEN" }
      ]
    }
  }
}
```

`enabled` defaults to true and `explicitOnly` defaults to false. Explicit-only
servers accept user probes but reject model/discovery startup. Stdio definitions
require `executable`; `args` and `environmentNames` default to empty arrays, and
`cwd` is optional. Configuration stores credential references, never values.

Each registry generation can now be inspected through one consumer-specific
capability-health snapshot. The pure evaluator combines declared lifecycle and
operational state with supplied platform, architecture, dependency, credential,
resource, policy, probe, provider/attempt-runner/workspace, and external-host
facts. Healthy, degraded, unavailable, incompatible, denied, quarantined, and
unknown remain distinct from registered, disclosed, executable, projected,
selected, and active. Bounded active probes validate catalog identity, count,
concurrency, timeout, cancellation, and freshness; their text and recovery
handles are redacted before projection. Stale results become unknown.

The evaluator can derive consumer-specific snapshots for native-model, CLI,
OpenTUI, headless, and external-host contracts. Product composition uses the
snapshot for built-in model disclosure and diagnostics. The admitted native
package observation-tool path executes through the shared gateway; a public
external host is not implemented. Configured MCP transport controls use the
same gateway as described below. Its read-only
inspector derives tool queries, deduplicated doctor findings, and effective
permission facts from one generation. Queries default to 32 rows and admit at
most 256, carry a deterministic continuation handle, and reject stale
generations. Permission changes remain owned by settings rather than the
inspector. General catalog commands, external-host transport, and slash-command
parsing and completion for these actions are not claimed here.

Native tool search requires an exact model in the connection transport plan's
`nativeToolSearchModels` qualification list. Missing qualification uses the
bounded eager tool set and does not admit deferred calls. Responses and
Anthropic retain completed search records with existing protected continuation
state; Anthropic search arguments include streamed fragments. Replay checks
current eligible definitions/references, count and size limits, and matching
search results before another provider request. Unknown SDK-compatible
endpoints do not gain native search automatically. Fixture tests cover wire
behavior; they do not establish live billed-token savings or model-quality
parity with eager disclosure.

Search tool arguments cannot choose an executable. Product composition may supply
one qualified ripgrep path; otherwise search uses the bounded filesystem reader.
Explicit memory recall binds workspace and destination sensitivity from the host.
Model-supplied scope, clock and trust overrides are rejected. Model-authored
admission candidates remain inferred and pass the existing admission policy;
they cannot label themselves user-confirmed. Automatic user-request admission
continues through its existing turn owner.

Responses strict function schemas now represent optional fields with nullable
wire slots and wrap root variants in an `input` object. Optional fields that
also accept literal null use a `value` envelope to distinguish null from omission.
The SDK decodes these representations before native tool assembly and re-encodes
retained calls during continuation. Native runtime validation and exact patch
preconditions still apply. SDK fixtures verify these contracts; no live-provider
qualification is implied by those fixtures.

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
runtimes remain separate. Beyond the eager set, the plan's ranked-out but
eligible candidates — its fallbacks and candidates rejected only as not
task-relevant — are bound to the same catalog generation as deferred tool
definitions, capped by a separate count and schema-token budget. Providers
with native deferral receive them marked `deferred` plus a server-side tool
search tool, and the stream records which deferred definitions the provider
loaded; providers without it receive only the eager set with an explicit
omission receipt. Either way a deferred call is admitted through the same
generation-bound gateway validation as a disclosed tool; policy-denied,
unavailable, or schema-ineligible candidates are never deferred.

The opportunity plan also contains an explicit, generation-bound degradation
graph. A fallback edge names its source and target capability, the unavailable
condition that permits it, the information and effect difference, and the
terminal unavailable result when no target succeeds. Only a no-effect
`unavailable` tool result can return to the model for another choice; failed,
denied, malformed, partial, uncertain, cancelled, and timed-out results keep
their existing terminal or recovery behavior. Falryn never substitutes a tool
silently. The next model proposal must name one of the declared targets, remain
within the attempt's disclosed schema set, and pass the normal validation,
policy, confirmation, hook, scheduler, and execution path. Self-edges,
backward/recursive transitions, authority widening, stale generations, and
transition-budget exhaustion fail closed before another effect.

The unavailable result sent to the model carries a bounded notice with the
declared target names, terminal reason, and recovery handles. The durable
capability-invocation event records the normalized unavailable status and the
same secret-free transition receipt, so replay and machine consumers do not
have to infer degradation from a generic failed outcome.

The gateway retains one in-process result promise per workspace/session/turn and
invocation identity. Fresh invocations with identical arguments still execute;
concurrent replays of the same identity share the original result, including
uncertain outcomes. Reusing an identity with different arguments, capability,
call identity or configuration generation is rejected. Replay rechecks current
scope, disclosure, policy and package trust before returning retained output.
This ledger is turn-owned process state, not crash-surviving effect recovery.

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
disconnects, malformed requests, cancellation, timeout, fallback exhaustion,
and uncertain effects remain typed policy-run outcomes. The current policy can
return `exhausted` with a null or nonterminal turn; GitHub issue #215
owns settlement to the existing `failed` turn terminal while retaining the
specific policy outcome. OpenAI Responses and Anthropic adapters parse provider
retry timing, but normalization currently drops it before turn retry policy;
Google GenAI and legacy OpenAI paths do not expose equivalent timing here.
Completed or uncertain consequential tool effects are not retried as fresh
work.

The interactive composer and `falryn run` use the same application-owned
live-turn executor. Both paths compose Context and, unless disabled, Brief; run the selected
provider and bounded tool continuation loop, and persist the same closed
session, turn, model-attempt, and capability-invocation events to SQLite before
projecting them. OpenTUI folds those committed events into its transcript;
JSONL emits the same event values before its terminal result. A failed append,
provider connection, context composition, attempt, or replay cannot be reported
as an accepted or completed turn. Production does not fall back to the in-memory
event-store test double when SQLite cannot open. Bootstrap currently also
constructs and discards a separate `session:bootstrap-idle` product runtime in
addition to the real headless or
OpenTUI session runtime. GitHub issue #909 owns removal of that duplicate runtime
and journal authority without dropping required initialization or cleanup.

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

Semantic history uses version-1 `history.recorded` payloads within the existing
version-2 runtime-event family. Migration 0026 indexes their artifact references.
The journal captures admitted user messages and selected source content, public
assistant text (including interrupted fragments), provider proposals before
assembly, binding and reuse, policy/confirmation/hook/scheduling decisions, and
native tool results before projection. Protected reasoning is excluded. Stable
message, proposal and invocation identities preserve their relationships;
checkpoint and restore-point payloads preserve supplied lineage and up to 32
authorized artifact references without implementing automatic compaction or
restore execution. SQLite validates those references before append. Deletion
and expiry tombstones retire coverage even before byte cleanup; reads and export
honor them, and GC no longer treats a retired point as a retention root.

History evidence is inline up to 2 KiB or sealed as an artifact up to 4 MiB.
Credential redaction is explicit in its fidelity. SQLite validates a retained
reference inside the event append transaction; a lost publication boundary
records an unavailable gap when the journal remains writable. A completed tool
effect remains completed even if retaining its result fails. Such a result
fails delivery and is not silently executed again by the gateway's effect ledger.
Unreferenced sealed artifacts are GC candidates; session references retain their
artifacts through the existing reachability owner.

The shared event/artifact reader checks current authority, retention metadata,
byte length and digest. It returns exact, redacted, reduced, missing, expired,
corrupt, unauthorized, cancelled or unavailable results. Pages contain at most
64 events and 64 KiB of expanded content. The live transcript caches the latest
64 events and identifies an omitted prefix. `falryn session show <id>
--workspace-id <workspace>` exposes ordered history; `--after-sequence <n>` follows
its cursor. Read-only replay reports its bounded history page and truncation.
It never invokes the original provider or tool. Authority is checked before
cancellation results, and refused inline bytes are removed from the returned
event as well as expanded text. Cancellation and authority are checked again
after retained reads. Model tool projections carry a history identity and
metadata without repeating the inline result; authorized history reads retain
access to the recorded content.

Manual history checkpoints are published by the admitted `compact.preview` and
`compact.apply` action behind `/compact`, the palette, and `falryn compact`.
A preview seals one `history-projection.v1` artifact, preserving every selected
semantic payload and lifecycle fact while interning repeated text. It binds the
source range/digest, model/configuration/policy, protected request, ancestry and
original recovery references. Apply compares that identity and appends its
pointer and receipt atomically. Duplicate apply returns the existing receipt.
Preview expires within 30 seconds and the owning operation deadline. Active
turns return busy; strict ephemeral sessions refuse before artifact preparation.

Admission uses the selected model window (capped by the existing 128,000-token
Context ceiling) and explicit instruction, fresh-tool/result, modality and
output/continuation reservations. Token values are labelled estimates using
UTF-8 bytes divided by four. All source records remain protected; insufficient
budget, unsupported media admission, changed source/policy, cancellation and
unavailable evidence refuse without truncation or a provider/tool request.
The producer does not consume prepared memory or enable automatic overflow retry.
The live action requires a captured admitted text request; the headless action
requires an explicit complete reservation. The live conversation reader below
consumes these projections; combined continuity remains #792.

Checkpoint inspection revalidates the original authorized sources, retention,
digests and bytes. Restore selects retained checkpoint lineage without modifying
source events or activating a session. It cannot recover forgotten or unavailable
evidence. The producer uses the existing 64 semantic-record, 1,000 stream-event,
32 retained-reference and 4 MiB content ceilings; exceeding them is explicit.
Ordinary history pages remain 64 KiB, while admitted checkpoint reads may use the
4 MiB ceiling. Real SQLite/artifact and CLI fixtures cover reopen, repeat/restore,
source/model/policy races, lost receipts, SIGKILL before/after publication, Unicode,
modality reservations, smaller windows, expiry, corruption and scope revocation.
The shared producer fixture is `src/cli/runtime/history-checkpoint.fixtures.ts`.

Live turns now read the selected session's committed conversation before recording
the new user input. Interactive and headless composition use one application
reader, including when a host is constructed over reopened SQLite. The snapshot
binds stream/session/workspace and a high-water sequence. It contains ordered
public user/assistant messages, correlated terminal tool exchanges, source
evidence, original recovery records and the selected checkpoint identity.
Streaming fragments are replaced by their settled answer; interrupted output
remains labelled partial. Current instructions stay in the leading system prefix.
History never dispatches a tool, hook, peer notification or optional memory model.

Applied/selected checkpoints revalidate the complete original range, artifact
digests, authority and retained bytes. Residual records append after their covered
range, with stable tool-result bytes across subsequent requests and compactions.
Missing, expired, denied, corrupt, unrecorded or incomplete tool evidence refuses
the request rather than silently falling back to the newest prompt. Historical
source text remains attributed evidence, not current task state or fresh effect
permission. The next request refreshes history; later commits cannot change an
already captured snapshot.

Each read admits at most 1,000 events, 4 MiB each of event metadata and expanded
content, 128 artifact reads and a 30-second deadline narrowed by its task. These
are request bounds, not storage quotas. Complete messages and disclosed schemas
are charged with UTF-8 byte estimates, output and continuation reservations on
the actual route, including tool continuations and late steering. A smaller
window or unknown media cost is an explicit refusal, without a model upgrade.
Application results and headless payloads expose the sequence, checkpoint,
message digest, bounded omissions, read counts and labelled budget estimate.
Default `falryn run` creates a fresh session. `falryn run --continue-session <id>
<prompt>` explicitly activates a compatible durable session through the shared
history admission owner. It uses current instructions, model policy and credentials;
inspection and replay do not submit work.

`/export` and the `session.export` palette command preview the active session
through the same application action as `falryn export`. `/export write <name>`
writes a versioned JSONL package with authorized artifact bytes; an existing
destination is refused. Preview reports omissions, and write rechecks artifact
policy before copying and publishing. Import installs artifacts before events
that reference them. Cancellation after publication reports the published
package. Export preserves authorized inline history and numeric model token-budget
metadata so a committed package remains decodable for continuation. Export and
replay do not activate a historical session executor.

OpenTUI's new, resume, fork and rewind actions share a transition guard with
prompt admission and compaction. The guard is acquired before asynchronous
preparation. Active turns or supervised work return a typed busy result; failed,
cancelled, foreign, stale or incompatible selections preserve the prior executor
and draft. Input prepared before a switch retains its original binding and is
refused if that binding changed. Repeated new-session clicks coalesce. If runtime
preparation fails after creating a durable fork, the refusal identifies that inactive
fork for inspection; it does not replace the active session.

Activation publishes the selected executor, transcript and header identity together.
Resume restores the in-memory lifecycle without appending another `session.started`.
Turn IDs use independent UUIDs, so reopening never resets a durable counter. Fork
and rewind store a source session/stream/sequence boundary in migration 0027;
subsequent turns append only to the new stream. Rewind requires an admitted completed
turn boundary. Legacy inspection-only fork records without a recoverable boundary
remain unavailable for execution. Ancestry is limited to eight parents and the same
aggregate history content, event and artifact-read ceilings. Original artifacts
are reauthorized; no source event, file, tool effect, credential or grant is restored.

The activation result explains lineage, checkpoint, accepted input, current
configuration/model policy, current versus recorded instruction/catalog input
digests and unresolved evidence. Required missing history or
unfinished operations refuse activation; optional services retain their existing
unavailable outcomes. `session.activated` observers receive the committed identity,
reason and generation only after publication; observer failure cannot undo it.
Old peer/listener and language/debug-service attachments are released. Shutdown
cancels and awaits admitted work before closing the shared stores.

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
| Agent | implemented and verified | Full authorized tool loop; confirmation-required effects fail closed unless the host supplies an authorized confirmation port |

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

The public model roles are `default`, `fast`, `subagents`, `workflows`, `vision`,
`plan`, and `advisor`. Ordinary coding, reading, tool selection, editing and
commit work stays on the captured main model. Admitted compression uses the same
main route, thinking, processing and cumulative limits; deterministic compaction
makes no model call. Fast has independent research, documents,
background-results, memory and vision-media options.
Subagents has Default and Small/Medium/Big presets; Workflows has its own Default.
Neither inherits Fast. The agent catalog supplies six built-ins and configured
user definitions to Advanced. Validated global and reviewed project workflow files
supply workflow and stable-step entries; retained missing entries stay inspectable. The shared resolver accepts
owner-supplied definitions, stable node keys, and revision metadata, distinguishes
model nodes from agent nodes, and gives deterministic nodes no model.

`models.policy` stores schema version 3 in user or profile configuration. A
profile replaces the complete user value. Project, environment and generic CLI
overrides cannot set it. Reset removes one preference, preserving explicit
descendants. Separate clear and legacy-import actions require a preview;
import retains the original and previous destination in a recoverable local copy
before atomic replacement. Schema-2 Fast compaction and legacy standalone compact
preferences are retired without copying them into memory or Fast Default. Old
policies remain inspectable with a migration-required diagnostic and an inert
projection that never executes their retired route; ordinary settings edits
require explicit migration first. Preview includes the source revision and retired
fields. Apply preserves exact source text (including BOM, comments and line endings),
original assignments and the previous destination in the state root's
`model-policy-backups` directory before writing. Main and unrelated memory
preferences remain unchanged. Historical receipt roles remain replay data.
Memory's evaluated/off policy and admission remain separate. This correction
does not enable automatic history summarization or promise lossless context.

Thinking follows the winning model route and omitted thinking uses that model's
provider default. Unsupported explicit thinking fails visibly. Reasoning remains
a setting on the effective model, rather than a separate role. Profiles request a work intent and reasoning
posture, but never choose a hidden provider or grant authority through model
routing. The current product turn still receives one selected provider catalog
and fixed adapter, so cross-profile or cross-provider fallback is not
executable; GitHub issue #215 owns immutable per-attempt route and provider
recovery. Configured role-level attempts, input/output tokens, wall time, and integer
USD microunit cost limits now narrow one task scope across retries and provider
continuations. Admission reserves declared maxima. Provider-reported token usage
can reconcile those reservations; absent or estimated usage retains the maximum.
A configured cost ceiling requires complete published pricing and token maxima;
missing evidence refuses the request before contacting the provider. Cost uses a
conservative published-tier maximum, not an exact billing claim.

OpenTUI's model picker is connected to the live turn path. A selection must
exist in the current catalog generation, must not be unavailable, and must be
executable by the selected provider adapter. A successful selection becomes the
process-local default route for later turns and remains selected when the
process creates a new session. An in-flight turn keeps the model identity it
captured before provider execution. Picker selections remain process-local and
take precedence over the saved main default. Settings writes affect subsequent
turns with their captured configuration generation; changing the saved provider
profile requires reopening the shell to attach that profile's authenticated
adapter. A mismatched selection fails closed. Headless configuration supports
explicit bounded fallback lists; each fallback uses its own provider-default
thinking and cannot implicitly reuse an unsupported primary-model control.

The current disclosure path uses that task-aware opportunity plan to select a
bounded profile-eligible subset from the shared registry, resolves exact
executable schemas through `ToolRegistry`, and records selected, fallback,
rejected, omitted, unavailable, and non-executable facts. Automatic skill loading,
MCP/plugin execution, and scheduled background work still
belong to their dedicated runtimes; #193 exposes
the deterministic opportunity and truthful availability without claiming those
sibling executors.

The workspace write, mutation, discovery, search, and patch descriptors, all
fifteen `git_*` descriptors, and the explicit `memory_admit`/`memory_recall`
descriptors carry strict, bounded, closed input schemas, so each is eligible
for that selection. The per-attempt count and schema-token budgets still bound
the disclosed set, and rejected or unselected descriptors continue to carry
explicit omission receipts.

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
structural backends, and graph retrieval are not claimed here. Startup indexing
currently admits only TypeScript, TSX, JavaScript, JSX, Markdown, and JSON,
rebuilds a complete
generation, and may exact-read broad candidate sets for as many as four derived
task queries before applying the final match limit.

Named workspace sets can be saved and shown, but product tools, index, language
services, attachments, session navigation, and configuration remain bound to
the invocation-time primary root. OpenTUI add/remove/load actions currently
change the shell workspace-set view rather than recomposing generation-bound
runtime authority. GitHub issue #879 owns that product wiring and revocation.

Workspace-scoped memory records persist in SQLite. Relevant records are
recalled before prompt composition. A new record is admitted only after the
model attempt, terminal turn event, and durable replay all report completion;
failed, cancelled, partial, or uncertain turns are not learned.

The shared product state host also exposes an explicitly bound reflection
persistence owner. Migration 0025 stores version-1 source-range requests,
pending candidates, immutable prepared projections, fenced leases, publication
coverage, and append-only invalidations. Creation verifies committed event
identity and content digests. Publication commits candidates and coverage in
one transaction; repeating the same publication returns its existing outcome.
Expired leases can be inspected and explicitly taken over with a higher epoch.
Policy, authorization, scope, source and artifact checks run again before
returning derived text. Export/replay preserves lineage and lifecycle observations
without a lease token or an admission operation.

Coverage distinguishes the current committed event boundary from contiguous
processed history. Recent processed ranges leave older gaps visible; an empty
result is processed, while unavailable and unprocessed ranges stay explicit.
The owner bounds requests, source handles, candidates, bytes, publications,
generations and scans. Exhausted publication capacity retains partial coverage;
a bounded coverage response marks omitted ranges pending. Source history and
accepted memory remain separate. There is no automatic reflection worker,
provider call, candidate review UI, or compaction consumer in this persistence
path.

## Unified resource Read and Search

Live CLI and OpenTUI turns register `read` and `search` alongside the existing
workspace tools. Typed targets identify primary-workspace files, exact session
scratch revisions, artifacts admitted by a scoped Loom manifest, and retained
evidence references. Search accepts known resources or bounded workspace path,
literal, and regex discovery. Hits carry Read targets; verified line evidence
is distinguished from discovery that could not be refreshed.

Read supports UTF-8 exact content, byte ranges, line ranges, head/tail, literal
matches, and heuristic outlines. It checks at most 16 resources sequentially,
with an 8 MiB source ceiling and an aggregate output ceiling of 64 KiB, default
16 KiB. References preserve scope, revision, digest, byte coverage and fidelity
in the existing artifact store. Scratch retains its own payload owner. Exact
recovery survives store restart and consumer context replacement. Changed
workspace content makes retained evidence historical; references never grant
write permission. Missing, discarded, expired, corrupt, wrong-scope, denied,
unsupported and cancelled resources remain explicit per-resource outcomes.

Resolved composer attachments and mentions reach the shared live-turn input.
Supported attachment-only submissions work. Selected paste and transcript bytes
are retained before reference; stale files, unavailable payloads, unsupported
media and secret selections refuse admission without accepting the draft.
Attachment admission and provider/tool work share the turn's resource budget.

An injected virtual-resource host must reauthorize each use and provide
digest-verifiable bytes. The default CLI/TUI composition has no live browser,
notebook, or MCP resource host and reports those targets unavailable. Binary,
extracted-document and sources above the source ceiling are unavailable in this
text route. Native structured Search has no qualified Hush projection adapter
and returns bounded structured facts with that reason. Heuristic outlines are
structural evidence, not exact edit preimages. Revision-bound edit preparation
is not implemented by this reader.

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
`outputMode: "hush" | "raw"`; `hush` is the default. `open_pty` is registered
but returns `unavailable` until the session-owned PTY host in GitHub issue #712
is composed. Raw mode bypasses only output reduction. Schema validation, effects,
confirmation, hooks, scheduling, capture, redaction, deadlines, cancellation,
persistence, provenance, and result bounds remain on the same product-tool
path.

Hush `hush.v35` selects a supported command or output-shape reducer, or returns
bounded raw output. Unknown commands and expected-family misses use
`safe.passthrough`, strategy `passthrough`, and domain fidelity `raw-fallback`;
reducer exceptions use the same fallback and record a failure omission.
Repeated lines remain intact on these fallback paths. The generic strategy and
reducer have been removed, and requests for the removed strategy are rejected.
Unknown commands have family `unknown`; the existing shell compound reducer has
family `compound`. Command-specific reducers retain their own output policies.
The product envelope selects raw output whenever the domain returns passthrough
and describes its actual inline or artifact-backed fidelity. Native structured
Git tool results continue to return their typed results directly.

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

The product registry contains 30 LSP operations, 29 DAP operations, and two
configuration discovery operations. All 61 input schemas pass recursive model
eligibility. Language/debugger tasks select startup prerequisites within the
existing disclosure count and token budgets; restricted execution profiles
still deny consequential operations.

User configuration at `tools.languageServices` owns `languageServers` and
`debugAdapters`. Only the user layer may set this sensitive key. Each service
names its exact canonical `workspaceRoot`, `serviceId`, executable, arguments,
environment, initialization options, and optional existing supervisor limits.
A debug adapter also declares `targets`, each with an `id`, `kind` of `launch`
or `attach`, bounded `configuration`, and optional launch-only `noDebug`.
Services are not installed or started by discovery. Missing executables fail
at the existing managed-process boundary. Configuration uses the existing
256-item and 256 KiB protocol bounds; no runtime budget is increased.

`lsp_configurations` and `dap_configurations` disclose workspace-matching
service identities and configuration digests without executable options or
protocol configuration values. `lsp_start`, `lsp_restart`, and `dap_start`
resolve those references immediately before dispatch. Debug launch/attach also
requires an exact configured target reference. Changed configuration refuses a
stale reference; unreadable configuration refuses discovery and use. Shutdown
and disconnect remain available for their owned generation during that failure.

Initialization and target options retain the recursive depth-, item-, key-,
string-, and byte-bounded protocol extension validators. Models cannot supply
those maps as startup authority. Unknown model fields, invalid identities,
stale generations, and malformed ranges are rejected before transport.

The LSP surface covers server lifecycle, document synchronization, navigation,
symbols, completion and signature help, diagnostics, formatting, rename, code
actions, and call/type hierarchies. An operation that depends on an optional
server capability checks the initialized and dynamically registered capability
set before sending a request. Formatting, range formatting, rename, and code
actions return Falryn patch proposals with document-version preconditions;
language servers do not apply those edits directly. Hierarchy traversal takes
an `itemRef` retained from the matching call/type preparation response, bound
to the service and open-document generation. Opaque extension data stays with
the retained item. Retention is bounded to 512 items and 256 KiB; evicted or
stale references require preparation again.

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
Concurrent LSP observations recheck document and service generations before
returning results. State-changing operations refuse a competing operation on
the same service; DAP observations also recheck stopped-state generation.
A lost launch/attach response marks the adapter failed with
`target-start-uncertain` and returns an uncertain gateway outcome. It cannot
start another target before explicit recovery.

Fresh-session deterministic protocol-peer scenarios exercise discovery through
the provider, gateway, both headless and terminal product hosts, negotiated
LSP hover/definition and hierarchy traversal, DAP launch/attach and stopped
stack inspection, and owned process shutdown. These process scenarios are
qualified on the POSIX test lanes; Windows remains explicitly skipped.

These descriptors are composed into the same production registry and runner as
workspace, process, Git, and memory tools. A provider can execute only the
strict subset selected into its immutable attempt disclosure, and every such
call passes through the unified policy, confirmation, hooks, scheduler,
capture, journal, and projection gateway. Registration alone does not imply
that all 61 schemas are placed in every prompt.

LSP file resource operations remain rejected and embedded code-action commands
remain deferred. #1085 owns resource-operation patch conversion; #1086 records
the unresolved command-effect decision. Existing text-edit support is unchanged.

## Scoped work-item records

`createWorkQueueActions` is the bounded application boundary for version-1 work
queues and items. It creates lists, adds and updates records, manages reciprocal
dependency edges and blockers, claims/releases assignments, records completion
claims and validator decisions, and cancels, archives or tombstones records.
These actions mutate data; they never launch or stop an executor. Shared command,
model, OpenTUI and task-profile registration remains with its existing owners.

The product storage host exposes registered `workspace-state`, `user-state` and
`memory` locators. The durable locators use indexed namespaces in the existing
state database; the memory locator uses the same SQLite adapter and migrations
without a database file. Session is the default scope. Session-owned lists in
nonpersistent sessions use memory; project/shared lists retain independent durable
storage. Queue headers persist the chosen locator, workspace and scope generation,
owner and membership. Resume resolves existing bindings before new defaults.
Additional locations require host registration; request text cannot open a path.

Migration 0021 stores queues, items, item versions, dependency edges and versions,
mutation identities, and session bindings. A mutation's rows and `work.queue.changed`
receipt commit together through the existing journal transaction. Expected queue
revisions prevent lost updates. Exact retries return their recorded receipt and
revision; changed identity reuse fails. An uncertain commit requires receipt
reconciliation. Missing or corrupt records never become an empty successful list.

Limits are per operation: 100 mutations, 100 records per page, 16 KiB aggregate
inline fields per item, 32 KiB encoded records, 1 MiB requests/responses, 10,000
validation traversal steps and a 30-second deadline narrowed by task admission.
Graph validation is iterative and paged. Exhaustion rolls back the entire batch;
previous accepted batches and stable IDs remain. There is no lifetime list-size,
creation-count or total dependency-edge quota. Pages and historical replay bind
to exact revisions and refuse stale continuation.

Readiness requires satisfied dependencies and no blocker. Completion remains a
claim until a host-authorized validator accepts exact item, criteria, claim and
evidence generations. Claims record holder identity and generation atomically.
Release without observed settlement or fencing remains pending, including after
restart; cancellation of a record does not signal its execution. Deletion refuses
active claims and removes both dependency directions in the same transaction.
Deleted prerequisites leave dependent criteria unresolved. Tombstones and revision
history preserve identity and evidence; explicit content erasure remains with the
existing retention owner. Rejected batches return their original source handle.

## Captured background tasks

`run_process` and `run_shell` accept an optional strict version-1 `execution`
object with `attachment: foreground|background`, `foregroundWaitMs`,
`onSettle: notify`, and `shutdown: drain`. Omitting it preserves foreground
capture. The wait defaults to 1,000 ms and accepts 1–30,000 ms; a running receipt
is nonterminal and never authorizes implicit detachment. Attached tasks cancel
when their parent closes. Explicit detach/reattach preserves the same process,
invocation, deadline, resource reservations, and cumulative allowance.

The non-launching `process_task` tool offers inspect, logs, result, wait, detach,
reattach, cancel, kill, and cleanup through the existing gateway. Controls bind
the current session/workspace, task generation, and mutation revision. Task
controls use reserved interactive admission and do not contend for the process's
held workspace-effect lock. Both product hosts compose the durable supervisor.

SQLite task transitions, semantic events, and terminal wake records commit
atomically. Capture and result artifacts seal before terminal publication.
Model log/result reads accept at most 32 KiB of source bytes within a 64 KiB
response, with offsets, continuation, declared encoding, and completeness facts.
Native writes coalesce into 64 KiB blocks per stream. Live reads distinguish
available bytes from committed `durableBytes`; up to 64 KiB per stream may remain
buffered or awaiting persistence. Settlement flushes that tail before sealing.
A crash can lose nondurable bytes and recovery reports incomplete, uncertain output.
Redacted views disclaim exactness. Receipts and notifications contain no argv,
environment values, or captured output. A store retains at most 256 tasks;
a supervisor permits 64 concurrent waits. Full capacity refuses admission.
Cleanup requires terminal sealing and notification disposition.
Retained tasks protect their artifacts even after session closure. Cleanup
releases task-only retention without removing invocation provenance or shared,
pinned, or exported roots. Reachability GC claims digests before deleting metadata
and bytes, preventing concurrent reuse. Unconfirmed deletion leaves a visible
`gc-claim-outstanding` omission; at most 256 claims may remain, and maintenance
recovery for abandoned claims is unavailable.

Notify-only delivery makes at most three durable attempts with one notification
identity. The interactive transcript receives committed terminal notices without
starting another provider request. Restart validates semantic state and probes
supervisor/process birth identities, never adopting or signaling from a PID
alone. Vanished or replaced supervisors with expired unchanged leases become
uncertain; live or unreachable ownership is not silently rewritten.
Known dead owners found before lease expiry are checked again at expiry during
the same host session, with a fresh identity probe and fenced reconciliation.

Normal headless response projection precedes detached-task drainage. The same
Falryn process stays alive until tasks settle or reach their deadlines; event,
artifact, index, and SQLite stores remain open through capture and its observers.
Failed run finalization, checkpoint, or store closure makes shutdown uncertain.
Explicit interruption cancels owned work. Linux/macOS support captured task
ownership; Windows background launch fails closed before spawn. There is no
daemon, automatic relaunch, or post-crash survival guarantee. Shared task UI,
direct task CLI controls, and PTY remain separate. Delegated agents and workflow
runs use this durable attachment and settlement owner without a child OS process.


## Typed workflows

`workflow` is a built-in tool in the normal headless and interactive coding
runtime. `validate` and `preview` inspect a version-1 JSON definition without
starting work. `execute` requires a run handle, the definition, and arguments;
`inspect`, `result`, `pause`, `resume`, `cancel`, and `list` use the same application
action owner. Broad workflow dashboards and slash authoring are separate UI
integrations. Automatic opportunity discovery never launches a graph.

Definitions support native actions, model steps, registered agents, structured
questions, typed conditions, and joins. Input references select literals,
arguments, exact prerequisite results, or a mapped item. `resultPath` selects an
own-property path from a native result before its declared schema is checked.
There is no expression evaluator. A definition has at most 256 nodes and 1,024
edges, with up to four concurrent nodes; the inherited task and subdivision
ceilings can narrow execution further. Results are limited to 64 KiB each,
definitions to 1 MiB, and checkpoints to 4 MiB.

A minimal definition for reading a native file size is:

```json
{
  "version": 1,
  "id": "user/global/workflows:file-size",
  "label": "File size",
  "argumentsSchema": {
    "type": "object",
    "properties": { "path": { "type": "string" } },
    "required": ["path"],
    "additionalProperties": false
  },
  "nodes": [{
    "key": "stat",
    "kind": "action",
    "capability": "builtin:workspace/stat_path@1",
    "effect": "observation",
    "input": { "path": { "from": "arguments", "path": ["path"] } },
    "resultPath": ["byteLength"],
    "resultSchema": { "type": "number" }
  }],
  "outputs": { "bytes": { "from": "node", "node": "stat" } }
}
```

Save definitions through the ordinary file-editing owner at
`<configuration-root>/workflows/<id>/workflow.jsonc` or
`<workspace>/.falryn/workflows/<id>/workflow.jsonc`. The file's qualified identity
must be `user/global/workflows:<id>` or `user/project/workflows:<id>` respectively.
Project bytes must match the reviewed workspace inventory; symlink escapes and
stale files fail closed. JSONC loading is inert and supplies the shared model
settings catalog. Saving or changing a file does not run it or change an admitted
snapshot. The direct action accepts the decoded definition; the model tool
encodes it in `definitionJson`, arguments in `argumentsJson`, and an explicit
handle such as `{"id":"file-size-run","generation":"one"}`. A later explicit
run uses a new handle generation. Run and targeted step model overrides use
`modelJson` and `stepsJson`; normal model-setting authority still applies.

Workflow model steps use targeted, saved-step, node, run, saved-workflow,
definition, Workflows, then main settings in order. Agent steps use their
workflow step overrides before the ordinary agent/Subagents resolver.
Admission freezes the selected routes and provider destinations. Deterministic
steps make no provider request; model steps have no tools, while agents retain
the normal delegated runtime and narrowed capabilities.

Migration 0022 commits immutable graph, input, authority, route and budget facts
with revisioned checkpoints and metadata-only `workflow.changed` events. Exact
results stay in the existing sensitive artifact store. Each native operation
re-enters the shared gateway; normal input validation, confirmation, hooks,
conflicts and preimages still apply. Workflow question nodes use the existing
question owner without treating an answer as permission for a later effect.
Headless missing-presenter requests return durable waiting receipts. Restart
requires the original host question capability to reconnect and answer.

Mapped nodes expand only from sealed source items with unique stable keys.
Each item's pipeline can advance independently; explicit joins wait for their
declared prerequisites. Required failures stop later admissions unless the node
declares continuation. Failed, skipped and uncertain nodes remain visible.
Pause stops new work while admitted operations settle. Cancellation does not
invent rollback. Safe observation retries are opt-in, at most two, and consume
the original budget. Unknown in-flight effects require owner fencing and are
never automatically replayed. New-generation reuse checks fingerprints, source
and route generations, retained artifact integrity, schemas, and current native
authority; failed reuse cannot repeat a completed mutation.

The task-list adapter builds an immutable selected graph and uses existing
work-item claims and evidence submission. `autoCascade` defaults to false.
With explicit cascade admission, accepted prerequisite evidence unlocks later
registered-agent nodes through this scheduler. An agent response alone leaves
its item waiting for native criteria validation. The task-list UI and automatic
consumer composition remain separate; configuration alone starts nothing.

Integration tests observe two provider requests for parent authoring/final
response around a native list→stat graph, and four for a graph adding one model
and one registered-agent step. Native transfers add no relay model request.
Receipts distinguish reserved budget consumption from reported measurements;
missing token or commercial-cost measurements remain unknown. These request
counts are fixture evidence, not a claimed wall-time or monetary saving.

## Structured questions

The shared product host composes a host-only structured-question service. It
creates, publishes, inspects, answers, refuses, cancels, resumes, and cleans up
version-1 requests. Single-select, multi-select, UTF-8-bounded text, and review
items share one generation-bound contract. Presenter and owner capabilities are
separate opaque tokens; only their hashes enter storage. The caller must retain
these capabilities to reconnect after restart. Workflow question nodes use this
service and retain only request/settlement references. A standalone question CLI,
model answer tool, general presenter, and goal adapter remain separate.

Migration 0015 journals bounded question revisions alongside the existing task
owner. Publication requires a committed owner; terminal question state, its task
event, and its notify-only wake commit together. Active states are created,
published, and waiting; settlements are answered, refused, expired, cancelled,
and unavailable. Disconnect is a presenter fact. Exact normalized answer replay
returns the same authorized settlement; conflicting or forged submissions do
not disclose the stored answer. Answers always report `effectAuthority: false`.

Requests allow eight items, 32 options per item, 32 KiB of request data, and
16 KiB of answer data. They expire after 15 minutes by default, narrowed by the
owner deadline, with an admitted maximum of 30 minutes. An owner may retain
64 records, at most eight active; each request allows 64 semantic revisions,
including a reserved terminal revision. The shared store's 256-task capacity
and the service's 64 concurrent wait limit also apply. Full capacity refuses
admission. Acknowledged terminal records can be removed after their expiry;
metadata-only task events remain as generation reuse evidence.

Recovery restores semantic waits and deadlines without probing or restarting
an OS process. The existing wake outbox supplies one terminal notification
identity and bounded delivery attempts. A disconnected owner can reconnect and
consume pending settlement; an acknowledged settlement remains inspectable.
Unavailable delivery reports recovery-required instead of waiting forever.
This does not promise exactly-once execution of an external continuation.
Protected input accepts only a non-retention fact, never secret bytes. Answer
bodies are retained only under the normal answer-retention policy; task events
and notices contain neither question text nor answers.

## Peer mailboxes

Main sessions and admitted child generations have authenticated same-machine
mailboxes. The `peer` model tool, direct `/peer <JSON action>` composer input,
and `falryn peer <action> <session-id> --input <JSON-file>` share application
actions. JSON and JSONL use the normal CLI result envelope; human output renders
bounded JSON. `/peer` is direct composer input, not a command-palette entry.

Run `/peer` in each live shell to obtain its exact identity and scope. The
recipient's user must allow the sender, for example
`/peer {"operation":"allow","peer":{"sessionId":"sender-session","agentId":"main","generation":1}}`,
using the actual identity returned by that sender. `hold` permits persistence
but hides the body from model retrieval until explicit `release`; `deny` refuses
new admission. `muted` and `perMinute` narrow notification and rate policy.
Names are discovery hints, never authority. Different workspace/project, user,
environment or trust scope is denied.

`send` and `reply` take `messageJson`, a JSON-encoded version-1 envelope with
`id`, exact `sender` and `recipient`, the endpoint's `scope`, increasing
`laneSequence`, millisecond `createdAt`, `kind` (`message`, `request` or `reply`),
explicit `correlation` or null, `text`, selected `artifacts`, `sensitivity`,
`retention` and `provenance`. Normal evidence uses `sensitivity: "internal"`,
`retention: "normal"`, and provenance
`{"source":"peer-evidence","effectAuthority":false,"causalMessage":null,"hops":0}`.
Omitted `expiresAt` defaults to 24 hours, narrowed by the original request for
a reply. Replies name the request ID in `correlation` and reverse its endpoints.

Only recipient commit establishes `accepted-for-persistence`. Offline proposals
remain unavailable until explicitly retried against a reachable recipient.
Receipts retain independent delivery, remote-handling and local-wait axes;
delivery does not mean read, acted on or answered. Equal ID/digest retries return
the existing receipt, while conflicting content is refused and audited within
the bounded lineage. Replies seal the original request once. Cancelling or timing
out a local wait cannot cancel remote work.

`inspect`, `history`, `cursor`, `export` and `replay` expose exact receipts or
paged metadata. History excludes message bodies; an authorized inspect retrieves
retained text. For example, `falryn peer history my-session --format json` reads
one bounded page and its continuation cursor. Each CLI command acquires a fresh
process lease and closes it on exit; it cannot take over an already-live owner.
Use the live shell's controls when that shell owns the endpoint.

`wait` observes a request. `subscribe` takes an explicit subscription ID, exact
peer, `idle` or `terminal` predicate and bounded `waitMs`. Registration and
predicate testing are atomic. Watches settle once on observation, cancellation,
expiry or revocation. Idle means no active or queued admitted turn for that
endpoint. It does not mean its task, descendants or workflow completed. Escape
cancels the shell's local peer wait. `inspect-subscription` and
`cancel-subscription` address its durable ID.

Arrival and settlement notifications contain a stable inspect handle, including
the child identity. Arrival/release starts no model turn, changes no authority
and copies no transcript. The user's `as` selector can address an owned live
child; the owning main session can inspect retained child mail and history after
closure. A closed child cannot reply or redirect mail to its parent/replacement.
Children still settle their assigned results exclusively through normal joins.
Model calls cannot change inbound policy or impersonate another endpoint.

The normal SQLite store owns migration 18, fenced endpoint leases, admission,
attempts, acknowledgements, subscriptions, notification consumption and cursors.
UNIX sockets use private directories and mode 0600 entries; Windows uses local
named pipes. Fresh process signing/encryption keys authenticate nonce-bound
requests and opaque single-use operation capabilities. Private keys and tokens
are not persisted. Expired process claims require fresh authentication after
restart. Cross-machine transport and automatic collaboration turns are unavailable.
The separate follow-ups are #1082 for opted-in local turn admission, #1083 for
explicit local cross-worktree route grants and #1084 for the remote transport
and trust decision. #161 owns their user controls. These issue links do not
change current runtime availability.

Mailbox limits are 16 KiB text, 32 KiB envelopes, eight artifact handles totalling
1 MiB, 64 pending messages/1 MiB queued bytes per endpoint, 64 sends/minute,
16 recipients/minute, three delivery attempts, 64 live waits and 100 records/page.
Transport admission is bounded to 30 seconds. Live registration is limited to
256 endpoints with a separate 64 MiB registry storage bound. A 16 MiB retention
budget reserves 80 KiB per receipt lineage plus payload bytes. Full or narrowed
rate limits return explicit backpressure. These storage bounds are independent
of task execution budgets. Expiry precedes explicit payload cleanup; policy
holds retain evidence. Selected artifact references remain GC roots until payload
cleanup. Digest receipts and bounded history remain, so cleanup does not restore
capacity once retained receipt metadata fills the budget.

## Delegated agents

The model-facing `delegate` tool is composed in headless runs and the live shell.
It discovers and inspects General, Explorer, Researcher, Planner, Implementer,
Reviewer and configured user definitions. Built-in IDs have the form
`builtin/falryn/agents:explorer`; labels never select a definition. Explorer uses
the Small preset, General/Researcher/Implementer use Medium, and Planner/Reviewer
use Big. Shared Subagents settings resolve the model and thinking together,
independently of Fast, including another configured provider account. Missing
accounts, unsupported thinking, unavailable native capabilities and undisclosable
tool schemas return an explicit unstarted result.

Each launch supplies an objective through `inputJson`, selected context, exact
capability IDs, requested effects, resource limits and the existing version-1
foreground/background policy. Children use the ordinary provider/tool runtime,
the same workspace and shared resource admission. Explorer, Researcher, Planner
and Reviewer have an observation-only ceiling. General and Implementer can
narrow the parent's effects and explicitly admit nested delegation. Consequential
operations still require the normal confirmation host; the existing lack of a
production confirmation presenter remains a limitation.

Definitions and selected context are bounded to 64 KiB each. Context text carries
a digest and source generation. Selected artifact references also require matching
metadata, verified bytes and a permitted sensitivity. Children receive selected
evidence, their definition and the preceding sealed result on continuation.
They do not receive the parent's transcript. Child results separate schema-checked
claims from native observation references, usage, actual outcome and effects;
they never assert verification of the parent's wider objective. Results are
bounded to 64 KiB, with an explicit failure for oversized or invalid output.
Raw durable results retain their digest; model projections apply normal redaction.

The returned handle names the logical child generation and its durable task.
`inspect`, `result`, `wait`, `steer`, `continue`, `detach`, `reattach`, `cancel`
and `cleanup` use exact handles. `resolve` accepts a unique friendly name and
refuses ambiguity. Steering queues at most 64 messages and 8 KiB total, and records
admission at a provider boundary separately from model compliance. Continuations
serialize, recheck definition/configuration/route/capabilities/context, preserve
earlier results and reuse the original allowance. Repeated unchanged work and
more than 64 generations are refused. Retention expires with the inherited
deadline or explicit cleanup. Restart can inspect durable tasks and results;
serialized handles cannot restore live continuation authority.
Runtime events now declare schema version 2 and a version-2 reader floor for
the agent task semantics. Version-1 stored events remain readable; older builds
reject the new event envelopes rather than interpreting an agent as an OS process.

Attached launches are required by default. `required: false` declares an optional
child; background launch or explicit detachment transfers cancellation ownership
to the existing background supervisor. Detachment preserves the original
lineage, narrowed authority, deadline and cumulative resource allowance, including
for descendants. The originating root session can control a detached child. A
later assignment creates a new child generation with its current immediate
parent while preserving the original root and allowance. Reattachment requires
the immediate parent to remain available.

The same model tool supports `join`, `join-inspect`, `join-integrate`,
`join-cancel` and `join-cleanup`. A join names its `id`, `generation`, exact
child handles and a policy with `mode`, `quorum`, `partialOnFailure` and
`cancelRemaining`. Modes are `all`, `first-success` and `quorum`. `quorum` is
null for the first two modes and an integer from one through the selected child
count for the third. Required children must succeed under every mode.
`first-success` selects the earliest durably sealed successful child by journal
sequence. A faster failure cannot win. `join-inspect` optionally waits up to
30 seconds through the existing task wait owner without holding a runnable slot.

Only schema-valid sealed artifacts from the exact immediate parent and current
child generation can satisfy a join. Integration is explicit: `accepted`,
`rejected`, `partial` or `follow-up-required`. A failed join exposes selected
partial evidence only when its policy permits it. Join settlement can request
cancellation of remaining children, but a cancellation request never counts as
terminal evidence. Parent termination independently closes attached work;
detached subtrees retain their background ownership.

Migration 0016 persists parent obligations, exact child links, bounded join
revisions and a monotonic task settlement sequence. Each join generation commits
one continuation receipt. Replays return that receipt without executing a child
or an external effect. Parent completion fails when required children remain
unaccepted, failed, missing or stale. Parent closure freezes outstanding joins
as follow-up-required and releases active join retention. Later child effects
remain in their own terminal records. Child result envelopes reference descendant
joins without copying their transcripts into ancestor results.

Joins select at most 16 children, allow 64 join generations/identities per parent,
and retain at most 256 active joins. Each revision is bounded to 64 KiB and each
join has at most three semantic revisions. Cleanup releases active retention
but keeps immutable receipt history; task cleanup protects artifacts still
needed by unresolved integration. Exact results stay in the existing sensitive
artifact store. Default notifications cover background task settlement;
intermediate attached child settlements remain inspectable. The process tool
cannot bypass the delegation owner's agent mutation controls.

Restart restores sealed evidence and join receipts. It does not reconstruct a
live parent executor or grant a new turn the authority of an old parent.
Workflow execution uses these shared owners; broad task dashboards remain a separate integration.

Custom definitions are inert configuration under `agents.definitions` in user
or profile scope. [The complete example](examples/agent-definitions.json) registers
`user/custom:source-inspector`. Save an edited copy with the ordinary configuration
command, supplying the current file revision when replacing existing settings:

```sh
falryn config set agents.definitions "$(cat examples/agent-definitions.json)" --file-scope user
falryn config validate
```

This replaces the complete definitions value; preserve other entries in the file.
Reopen the shell after editing definitions. Setting `enabled` to false preserves
the identity and saved model preference. Saving, listing and editing do not launch
an agent. The native registry accepts admitted package definitions through the
same codec and owner-digest checks. Package installation and native observation
tool activation are implemented; automatic package-agent preparation is not. Required browser, computer, MCP or instruction preparation needs
its native owner; a descriptor alone does not make it ready.

## Current product-integration limits

Model-backed prompt enhancement remains unavailable. Its current refusal names
historical provider issue #33; #1087 owns the separate enhancement backend and
correction of that explanation. Local draft normalization remains supported.

The model tool loop defaults to four concurrent executions and enforces an
implementation ceiling of sixteen. Product tool gateways and provider requests
share one process-owned resource ledger and the existing scheduler. Manifest
`maxGlobal`, `maxPerWorkspace`, timeout, conflict keys, and declared resource
amounts enter admission. Tool-family capacity survives registry generations;
workspace capacity is scoped separately. The generic scheduler's standalone
`BudgetLedger` remains available to non-product callers.

Product defaults bound running operations to sixteen, reserve one slot for
interactive or aged work, and bound the queue to 64 entries, 16 MiB of input,
and thirty seconds. Aging operates across scheduler generations. Queue
cancellation and deadlines prevent launch. Each task allows at most 512
operations, 64 provider requests, and thirty minutes; configured role ceilings
can only narrow them. Child scopes debit the same parent transaction. Closing
a task invalidates its scope, while uncertain non-fenceable reservations remain
charged. Cancellation alone cannot release resource occupancy or conflict-key
capacity; late authoritative completion can reconcile it.

Versioned identities separate capacity owners from reservation bindings.
Reservations atomically preflight overlapping scopes, reject conflicting
replays, conservatively join aliases, and detect safe-integer overflow and
reported overruns. Receipts use opaque identifiers and pass through tool results,
attempt output, and durable lifecycle events. Replay retains receipts without
caching whole model/tool outputs. Missing resource measurements are not treated
as authoritative zero usage. Undeclared dimensions have no measured platform
ceiling: these are admission limits, not OS CPU/RSS enforcement.

GitHub issue #937 owns durable cross-process coordination and recovery;
GitHub issue #938 owns platform resource ceilings. No other process or non-Falryn client is
observed. The process owner exposes explicit shutdown; ordinary task completion
closes only its task scope.

The product runtime can admit a host-selected child against its existing scope
tree and task allocation. It freezes the allowed provider profile, destination,
model and thinking, capability IDs, effects, workspace and configuration/catalog
generations. Descendants intersect that ceiling; native tool policy and focused
confirmation still apply. Provider requests and tool dispatch check the binding
again before acquiring capacity. A child passed to the shared live-turn executor
keeps the same root allocation across retries and later turns.

One root allows 64 cumulative resource subdivisions and at most four runnable
descendant operations, further narrowed by root and child limits. All derived
scope kinds count toward the existing sixteen-level scope bound. Reusing a
child ID or unchanged host-computed work digest is refused across the root,
including through another admission facade. Idle child metadata holds no
runnable slot; provider/tool segments acquire capacity as they execute. Closing
a child cancels its descendants, while uncertain native work retains occupancy
until termination is observed. Tightened limits apply to queued work, occupancy
is released at every depth, and admitted operation/request counts cannot be
refunded by an alias or an actual-usage report.

This is logical admission, not OS confinement. Serialized handles cannot start
or resume work; durable restoration must reconcile ownership and budgets before
obtaining fresh admission. The host admission seam does not select definitions,
launch agents automatically, or implement workflow, schedule or mailbox runners.
Those consumers retain their own delivery owners.

The gateway accepts an injectable `ProductToolConfirmationPort` and fails closed
when confirmation is required but no authorized presenter exists. Normal CLI
composition only forwards an optional port, and no non-test OpenTUI resolver is
currently product-composed. The product workspace bundle also constructs its
patcher without the available Git observation port, so live preview/apply miss
the patch layer's current in-progress-operation and observed-HEAD safeguards.
GitHub issue #200 owns both final pre-effect product paths.

Before/after capability hooks capture an immutable registry and resolve same-point
dependencies before descending priority, source rank (builtin, user, workspace,
session, process, development) and bytewise owner-qualified identity. A registry
has one registration generation; duplicate identities, missing dependencies and
cycles refuse publication. Replacement publication affects new admission and
leaves bound work to drain; explicit disable, trust withdrawal, uninstall and
strict-profile withdrawal cancel the owning external execution generation.

Exact, prefix and bounded relative path glob filters run before resource admission
or package preparation. Glob `*` and `?` match within one path segment. Invocations
receive a signal combining caller cancellation, revocation, resource-owner shutdown
and deadline. Late decisions are fenced. Cleanup waits at most one second within
the remaining chain/enclosing deadline, with complete, uncertain or not-started
outcomes recorded explicitly. Non-cooperative trusted callbacks cannot be forcibly
terminated; their late decisions remain unusable and cleanup stays uncertain.

The v1 hook catalog in `src/domain/extensions/hook-points.ts` defines 47 closed
point schemas and their phase, allowed decisions, mutable fields, filters,
deadline/cancellation rules, sensitive-field policy and settlement events.
`inspectHookPoints()` returns that table and generated input schemas. Exactly
two publishers are currently available:

| Point | Product call site | Payload evidence | Mutation and settlement |
| --- | --- | --- | --- |
| `before-capability-invocation` | `product-tool-gateway.ts` before scheduling | Capability ID, input digest, declared effect | Bounded annotations/input proposals, refusal and focused confirmation; `hook-point-settled` |
| `after-capability-invocation` | `product-tool-gateway.ts` after native outcome | The same identity plus terminal kind and observed effect | Observation or separately admitted tool/follow-up request; no terminal rewrite; `hook-point-settled` |

Both envelopes carry subject/fact identity, owner/configuration/registration
generations, session/turn/attempt correlation and sequence. Callbacks receive
frozen copies; the wire payload excludes raw tool input, output and runtime
objects. Replay remains passive. The remaining catalog entries are unavailable;
schemas alone do not compose a publisher or prove task/lifecycle dispatch.

Hook decisions use `observe`, `transform`, `veto` and `external-effect-request`.
Mutating wire decisions echo `hookDecisionBinding(envelope)`, binding the exact
fact, subject, generations and payload digest. Trusted built-in legacy decisions
remain accepted through a strict compatibility decoder. Neither decision form
supplies an executor or grants permission. Built-in callbacks are trusted
in-process code, not a sandbox for foreign executable handlers.

At the before-tool point, a transform can propose at most eight top-level input
fields, within the 16 KiB response limit. Same-field transforms conflict even
when their values agree. The gateway normalizes the resulting input again and
recomputes its effect, conflict keys, policy and focused confirmation. Earlier
approval cannot authorize changed intent; replay rechecks the admitted input.
Schema, workspace and native resource checks still own allowed targets.

After-tool requests can propose a disclosed tool name and arguments. Once the
subject is durably settled, each request enters the ordinary gateway with its
own invocation, confirmation, shared task budget and receipt. One generation of
requested effects is allowed; nested effect requests fail closed. Unknown or
undisclosed requests are visible as unavailable. Follow-up text is a proposal
only and never starts another model turn. Async execution accepts observations
only; it cannot propose an effect, transform or veto a settled subject. The shared
resource owner supplies four running slots per session, with sixteen pending
observers and 1 MiB of pending payload. Admission reserves the remaining hook
budget before returning a queued receipt. Overflow records a typed unavailable
outcome. Retained child scopes own callbacks, cancellation cleanup and their final
receipts through parent settlement; user cancellation and shutdown reach that work.

The semantic journal records the resolved order and registration, catalog and
configuration generations before invocation. It records each decision with digests,
position, elapsed time, execution/cleanup state and correlation, plus
original/admitted input digests. It does not store hook annotations or proposed
patch contents. Result projections expose hook warnings and separate effect
receipts; effect summaries retain uncertainty. Invalid pre-decisions prevent
dispatch, and invalid or late post-decisions cannot rewrite the native result.
SQLite reopen, export and replay read these facts without dispatching hooks.
The existing 32-registration, recursion, response and native task limits apply.

Each hook binding counts consecutive failures. A success clears its streak before
three failures; the third failure quarantines further execution. Required pre-tool
hooks then refuse dispatch, while post-tool observers report warnings and preserve
the subject outcome. Uncertain cleanup fences further invocation immediately.
There are no automatic retries. Trusted built-in bindings keep health with their
registry; native package bindings persist it in SQLite migration 0029, keyed by
hook identity and the validated activation/contribution digest. Restart and registry
republication preserve quarantine; old or late completions cannot clear it.

`extension catalog` reports native hook health, failure count and activation
generation in human and JSON output without executing handlers. A fresh, confirmed
`package enable` request with `nativeActivation`, the current activation revision
and selected contribution digests revalidates authority and creates a new health
generation. Preview and replay of a previous operation do not reset health;
reactivation cannot restore revoked trust or disabled scope implicitly.

Hook receipts retain point/source identities, captured generation, elapsed and
cleanup facts, health and remediation. External process transport, exit/signal,
response decoding and omitted stream-byte counts remain separate; unknown effects
stay unknown. Raw stdout/stderr, input, headers, prompts and nested exceptions are
excluded from diagnostics. Strict remote/model receipt variants use nullable
usage and effect uncertainty; their live adapters remain unavailable. Queue and
overflow receipts retain the captured binding. Failure receipts become transcript
notices, including passive replay/export. Audit or health-store failure refuses
required gates; after native settlement, persistence failure remains visible
without re-executing the subject or changing its recorded observed effect.

Package preparation rejects unknown hook points, versions, fields and invalid
handler/mode combinations. External entrypoints require inventory digest locks.
`falryn extension inspect <directory> --format json` reports the declared point,
handler and availability; human output reports the same unavailable reason.
Inspection neither activates handlers nor exposes arguments or credentials.
The handler union includes built-in, command, HTTP, MCP and evaluator declarations.
Built-ins and explicitly installed/trusted/native-activated Python package hooks
execute at the two gateway points. Other publishers and remote/evaluator adapters
remain unavailable. One scheduler applies the declared class budgets: local
50 ms default/1,000 ms maximum/2,000 ms cumulative; remote 5/10/20 seconds;
evaluator 10/30 seconds; mixed chains 60 seconds. The enclosing deadline always
narrows them. Inspection displays resolved timeout, chain ceiling, blocking mode
and local/nonlocal resource cost; declarations require explicit nonlocal opt-in.

The `python39-macos-observer-v1` external-command profile is qualified only on
Darwin 27.0.0 arm64 with the pinned Apple Python 3.9.6 executable and library in
Xcode's Python3 framework. Its logical executable is `python3.9`; the governed
execution declaration uses loader `python`, protocol `falryn-hook-command-v1`,
and the same locked package-relative entrypoint and arguments as the hook.
`src/cli/commands/package-hook-fixtures.ts` is a complete manifest/script example.
Native package enablement uses the existing explicit activation confirmation.
Missing or different runtimes remain unavailable; built-in hooks need no Python.
There is no PATH search, interpreter installation, shell sourcing or fallback.

The host revalidates installed revision, locked bytes, authority and activation
before preparation/launch and after execution. It copies admitted package bytes
into a private read-only invocation directory and runs a separate process with
isolated Python flags, an empty environment, offline policy, no child processes,
no writable roots and reads restricted to the package and qualified runtime.
The existing narrow system bootstrap allowance still applies. The common resource
owner reserves one process and conservatively debits the 64 MiB package-cache
ceiling before preparation. CPU/memory usage is unknown, so finite limits for
those dimensions refuse admission. Full-user execution is not provided.

The external codec accepts one UTF-8 JSON document per direction with 64 KiB
stdin ending at EOF, 16 KiB response, 16 KiB diagnostics and exact invocation
correlation. Nonzero exit, malformed/truncated output, stale authority and timeout
cannot authorize a proposal. Process-group termination and sandbox receipts own
cleanup certainty; uncertain cleanup retains the invocation directory. Python
working/hostile controls, installed gateway tests and compiled fixtures exercise
these boundaries. Broader lifecycle publishers retain their existing owners.

The generic gateway captures its native result before projection and reports a
failed capture independently of the observed effect. Content above the 4 MiB
history admission bound is an explicit unavailable record. Broader artifact
lifecycle work remains under GitHub issue #207.

Image, PDF, and notebook readers exist in the application source but are not
registered in the product tool bundle, and live provider adapters accept text
only; their document/media owners remain GitHub issues #183–#188.

Apart from the captured process, delegated agent, workflow, and host-only question
paths described above, no schedule, goal/loop, or automatic work-item runner
is product-composed. Opportunity records do not automatically
launch those runtimes. Their existing owners include GitHub issues #155–#162,
#284, #797, and #897. Extensions, MCP servers, package contributions, skills,
prompts, and external hosts likewise remain registry contracts or planned
loaders unless explicitly described above as built-in production behavior.

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
