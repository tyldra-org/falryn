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
| falryn doctor | Run bounded environment, local-storage, skill validity and installed package standing diagnostics |
| falryn commands | Print the interactive shell's command reference, generated from its command registry |
| falryn config show / validate / path / set / reset / migrate | Inspect, validate, update, or remove a scoped configuration override |
| falryn profile list / show / default / use | Inspect working profiles, save defaults, or request an exact session target |
| falryn env inspect / reload | Inspect or explicitly prepare this invocation's scoped child environment |
| falryn provider list / add / use / configure / test / login / logout / remove | Manage local provider profiles and credentials |
| falryn data backup / inspect / restore / diagnostics / retention / gc / reset / uninstall | Inspect, preserve, repair, retain, collect, or preview/apply confirmed removal of Falryn-owned local data |
| falryn workspace list / show / save / load | Inspect or persist named workspace sets |
| falryn model | Inspect and revision-safely edit model policy through the shared settings service |
| falryn package | Inspect, install, activate, update, disable or remove governed packages, inspect their data/health/standing, evaluate them against the curation rubric, and quarantine or revoke one |
| falryn peer | Inspect authorized peers, exchange messages, and read delivery history |
| falryn extension inspect / trust / notices / scope / catalog / listing / suggestion / skills | Inspect local declarations and skill directories, confirm trust or scoped metadata preferences, list or acknowledge package notices, query the inert catalog with skill findings, curated listings and verified package suggestions, and report skill usage |
| falryn export / import | Preview or write a versioned local export package, or import one after verification |
| falryn replay | Rebuild one stored session projection without repeating effects |
| falryn session list / show / resume / fork / rewind / replay | Inspect or navigate durable session history while preserving lineage |
| falryn task decompose / validate / progress / commit-plan | Project deterministic task structure, validation, progress, or a reviewable commit plan |
| falryn artifact list / show / get | Inspect locally stored artifacts |
| falryn completion bash / zsh / fish | Print shell completion scripts |

Commands support human-readable and machine-readable output forms. Results go
to standard output and diagnostics go to standard error.

In the interactive terminal, press Ctrl+C twice within two seconds to leave. The
first press only shows "Press Ctrl+C again to exit." and changes nothing else. The
hint clears if no second press follows, and choosing Exit in the command palette
or typing `/quit` asks the same way. When a turn is running, a confirmation is
waiting, other work is running or the composer holds an unsent draft, the first
notice also says what leaving ends, for example "Leaving cancels the running
turn." Leaving this way exits `0` and restores the terminal. The key
arrives as input in raw mode, so one shared keymap rule covers macOS, Linux and
Windows; its tests run on all three, and the real-terminal check runs on macOS.
An external `SIGINT` (such as `kill -INT` or a supervisor) still cancels
immediately with exit code `130`.

## Shell commands

One versioned registry (#790) holds every interactive shell command: its stable
action ID, slash forms, argument, key, effect class and its timing during an
active turn. Slash text, the command palette, key bindings, help and
`falryn commands` all read that registry, and slash text, the palette and keys
dispatch through one function in the shell runtime. Dispatched slash text is
cleared from the composer, after success for `/mode <mode>` and
`/workspace load <name>`, and only if the draft has not changed since. The palette ranks matches
deterministically: exact names, then slash-form prefixes, then name prefixes,
word prefixes, substrings and in-order characters. Help and palette rows show
each command's slash usage beside its key.

Slash text is parsed by one grammar. Words split on any Unicode whitespace and
match case-insensitively, longest form first, so `/model routes` wins over
`/model`. An argument is either one declared option word with an optional
operand (`/profile use work`) or the rest of the line, which may be quoted
whole with `"` or `'` (a backslash escapes the quote or itself) or taken
literally after `--`. Text arguments have a byte limit per command. A wrong
argument is refused with a notice that lists the accepted values (for `/mode`,
`ask|plan|debug|agent`), and the draft stays for editing. Unclaimed slash text, such as `/skill:review`, a skill's bare name or
a prompt-template alias, still goes to its owner after the built-ins.

Commands owned by open issues are listed, searchable and refused with their
owner: `/status`, `/doctor`, `/permissions` (#739), `/tools` (#192),
`/provider` and `/login` (#273), `/quota` (#1027), `/rename` (#794), `/goal`
and `/loop` (#797), `/tasks` and `/agents` (#276), `/extensions`, `/mcp`,
`/hooks` and `/plugins` (#274), `/checkpoint` and `/undo` (#792), `/settings`
(#272), `/search` (#793) and `/advisor` (#1216). None of them runs until its
owner ships the action. A planned name never hides a skill or prompt template
of the same name: when one exists, the text goes to it.

Every entry declares `immediate`, `safe-point` or `queued` timing, and an
option can override it: `/profile use` previews immediately while
`/profile apply` is a safe-point change. During an active turn, immediate
commands such as `/help` run at once. Safe-point and queued invocations, such
as `/plan`, `/fast on`, `/env reload` or `/compact apply`, are refused with a
notice to run them after the turn; the mid-turn queue that would hold them is
#954. A bare `/mode` opens the execution-mode picker, as the palette does. The
execution-mode, model and compression pickers obey the same rule: a change
picked during a turn is refused with the same notice.

Each entry declares which callers may invoke it: the interactive shell, a
headless run, or a model. Most shell commands are interactive only. `falryn run`
resolves a prompt that starts with a built-in command through the same
registry, with no provider request. An action whose entry admits headless
callers, currently `/skills` and `/suggestions`, runs through the shared
action dispatcher (#948) and returns stage `command-completed` with its
`commandAction` (action ID, matched form, normalized argument, status and
lines); quiet output prints just the lines. Any other shipped command or
malformed command text is refused with stage `command-refused` before any
workspace, trust or provider work, with error code `command.caller-unsupported`
or the parse error (`command.argument-invalid` and similar). A planned command
is refused with `command.command-planned` after the skill and template catalogs
are read, unless a skill or template of that name takes it.

The shared action dispatcher (#948) is the one path for every caller of an
action with a non-interactive caller. Slash text, the palette, a headless run
and the model all resolve the action through the registry, by canonical ID with
an argument or by literal slash text. They normalize the argument with the
registry's codec, pass admission for their caller and timing, and run the
action's application owner once. Shell and headless sessions register the
`command_action` model tool as explicit-only, so it never takes an eager slot
from ordinary work; a model reaches it through `discover_capabilities`, or a
user selects it with a `$` mention. Its `list` operation returns bounded cards
for the
actions the model may call: ID, slash forms, argument, effect, timing,
confirmation and the registry generation. Its `invoke` operation takes an
action ID and argument, or literal slash text. Slash text is parsed by the
registry grammar; it is never a shell command and never enters the composer.
An unknown action, invalid argument, stale registry generation, planned
command, presenter-only action (`interactive-only`) or a state change during
the turn (`unavailable-while-turn-active`) is returned as a typed refusal that
ran nothing. A call is classified with its action's declared effect only when
the model would be admitted to run it, so gateway policy and confirmation
apply to what actually runs. Skill, prompt-template and extension commands, and
per-option effects for actions such as `/profile`, `/fast` and `/env`, are
separately tracked in #1268 and #1269.

`falryn commands` prints the reference: registry generation, then each
command's usage, aliases, key, timing, effect and owner when planned.
`--format json` returns the same data as schema version 1, and
`--format quiet` prints one canonical usage per line.

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

Named model routes live in user `defaults.models.routes.definitions`. Each has a
stable ID, revision, exact primary connection/provider/model, and at most 16
explicit alternatives. The registry accepts at most 64 definitions. Model-role
preferences select `{ "kind": "route", "routeId": "daily" }`; existing concrete
pins and ordered legacy fallbacks remain unchanged. Working profiles select
references but cannot redefine global route membership. Missing references
remain inspectable and refuse execution.

Use `falryn model routes --format json` to list definitions and their file
revision. `falryn model routes --input action.json --format json` accepts
`route-inspect`, `route-explain`, `route-simulate`, `route-validate`, `route-save`
and `route-reset`. Save supplies the complete `definitions` array and exact
`expectedRevision`; reset supplies an `id` and that revision. Changed definitions
must advance their revision. The existing `falryn model configure --input action.json`
accepts a `kind: "edit"` action with `edit.kind: "configure"`, an existing model
`target`, and the named reference in `edit.route`. `/model` exposes named choices
beside concrete configuration; its Named routes page and `/route` accept the same
JSON management actions. Attached hosts use `ModelSettingsService.execute`.
The registered `model_routes` tool accepts a bounded `commandJson` through the
normal capability discovery and admission owner. Save/reset require mutation
authority and retain revision checks.

Inspection, explanation, validation and simulation use supplied metadata without
credential reads or provider requests. The resolver records exact targets,
revisions, exclusions, processing qualification and quota/price uncertainty.
It supports ordered preference, current-account affinity with a deadline-bounded
wait, availability preference and a strict primary. Live configuration uses
explicit connection capabilities and qualified built-in metadata; undeclared
variants refuse qualification. Live quota and enforceable included-allowance
facts remain unknown unless supplied by an owning consumer, so included-only and
unknown-price cost caps fail closed.

Main requests and delegated/workflow selections retain immutable route receipts.
Each provider request checks the current account binding before transport;
credential replacement or account/project changes invalidate an old binding.
Attempt history records the route ID and revisions beside actual serving and
cache identities. Save receipts distinguish publication from application, and
already-admitted work keeps its capture. Qualified alternatives are a typed
handoff to #215; this implementation does not execute automatic account switching
or quota waits. Scheduled route integration remains with #1113.

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
the generation on reload. Project skill bundles under `.falryn/skills`,
`.agents/skills` and `.claude/skills` are part of the reviewed inventory, so a new
project skill needs review before it can load;
workspace approval does not grant tool permissions or a sandbox. The review covers
each root's `AGENTS.md`, `CLAUDE.md` and `FALRYN.md`, the files instruction
discovery can load at a root. A fixed loader name must match an entry exactly, so a
differently cased lookalike on a case-insensitive file system is treated as absent.
Discovered and registered instruction paths use the source admission described below.

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
can explicitly register files in `instructions.sources`; conventional files are
also discovered without registration. Main turns also route conventional skills
automatically (see Skills below); package prompt templates expand only as explicit slash actions (see
native package activation below). Merely installing a package does not
activate its instruction body.

Discovery reads the user-wide `AGENTS.md` in the effective configuration home
(`~/.falryn/AGENTS.md` by default); other global files, such as a home
`CLAUDE.md`, are used only when registered. In each admitted workspace root it
finds `FALRYN.md`, `AGENTS.md` and `CLAUDE.md` in the root and in every directory
on the path from the root to each directory a turn is scoped to: the root for main
turns, and a child agent's or workflow step's `instructionDirectory`. It never
looks above a root or recursively through the tree, and a symlinked or missing
directory ends that path. Up to 64 scoped directories per root are remembered for
the session, so alternating main and subtree turns keep one generation. Each file
applies to its own directory's subtree; a root's files never apply in another root.

Names match exactly and case-sensitively. A lookalike such as `agents.md`, a
symlinked file, a directory with a supported name, a file over 1 MiB and one that
is not valid UTF-8 are listed with that reason (`unsupported-casing`, `symlink`,
`not-a-file`, `oversized`, `malformed-utf8`, `unreadable`) and never loaded,
while the turn continues with the other sources. Project files in a workspace
without current trust are listed as `untrusted` and not read. A registration of
the same file takes precedence over its discovered form. Discovered files are
rescanned on every admission, so creation, edits and deletion apply to the next
provider request; the root files and the home `AGENTS.md` are also watched for
live reload notices.

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
conventional identity. Automatic skill routing uses this resolver (see Skills);
explicit skill invocation uses it with user origin (see Skills).

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

## Skills

Main turns in the terminal and headless `falryn run` discover skill bundles and load
a relevant skill's complete `SKILL.md` into the request before inference. Each
authorized workspace root contributes `.falryn/skills/*/SKILL.md`,
`.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`. The user contributes
`skills/*/SKILL.md` in the configuration home (normally `~/.falryn`),
`~/.agents/skills` and `~/.claude/skills`. Priority falls in that order, project
before user. A same-named skill in a lower location is reported as shadowed and never
concatenated. Equal-priority duplicates require a choice through
`instructions.preferences`; an automatic pick among them is reported unavailable
(`ambiguous-source`). Another root's project skills never load for the primary root.
No bundled skills ship, and configured extra locations are not available (#1182).

Discovery reads only immediate bundle directories, at most 256 per location. The
entrypoint name must be exactly `SKILL.md`: a lookalike, symlinked bundle or
entrypoint, oversized file (over 1 MiB) or invalid UTF-8 is listed with its problem
and never loaded. Untrusted project skills are listed but never read. The
frontmatter must carry the Agent Skills `name` (matching the directory) and
`description`. `disable-model-invocation: true` keeps a skill out of automatic
selection, and `user-invocable: false` only affects explicit invocation, which is
refused for that skill. These must be real booleans; any other value makes the
skill unavailable (`malformed-eligibility`). `model`, `effort`, `context`,
`agent` and `hooks` are recognized but not yet honored, so a skill declaring one
is unavailable (`unsupported-control`, #1181). `allowed-tools` is a hint that grants
nothing, and other fields are inert. Restrictions in `instructions.preferences`
can only narrow this.

Routing uses the task text and each eligible skill's name and description, which are
untrusted relevance evidence. A skill the task names, such as `release-notes`, is
loaded. Otherwise one clearly best description match (at least two shared terms and
more than any other) is loaded, and ties are listed as recommendations without
loading. At most four bodies load per turn, and a loaded skill stays loaded for the
rest of the session while it remains eligible, including after a restart. A
`skill-workflow` section tells the model which skills were loaded and why, lists
recommendations with their descriptions, and names any skill the task mentioned
that could not load, with the reason. Manual-only skills are never mentioned. Loaded
bodies use the instruction limits above and are complete or refused, never
truncated. Edits and removals apply from the next turn.

A user invokes a skill explicitly by starting a submitted prompt with
`/skill:<name>`, in the terminal composer or headless `falryn run`; the rest of the
prompt is the task. A bare `/<name>` also works when a skill of that name exists.
Built-in commands always win, so `/skill:<name>` reaches a skill whose name is also a
built-in. When a prompt template shares the bare name the command is ambiguous and
must be qualified (`skill.ambiguous-command`); an unknown bare name stays with
prompt templates. Only text the user submits is parsed: slash text inside a prompt,
model output, repository instructions, template expansions and scheduled or child
prompts never invoke a skill. The pick resolves with user origin, so a manual-only
skill (`disable-model-invocation: true`) loads, while a `user-invocable: false`,
restricted, missing, conflicting, untrusted or changed skill refuses the turn before
any provider request, with an `instructions.rejected` fact and no substitute source.
Headless runs report that failure at stage `skill-failed`. A loaded pick is recorded
as route reason `explicit-invocation` and is kept out of automatic routing for that
turn. It carries into later turns only through ordinary automatic eligibility, so a
manual-only skill is not reloaded without another command.

`/skills [filter] [after N]` lists the skill catalog without reading any body: each
source's name, origin, path, declared eligibility and either its command or why it
cannot be invoked (shadowed, excluded, conflicting or not user-invocable). The catalog
is refreshed when the session opens and for each listing. Pages hold at most 100
entries or 256 KiB. In the composer, Tab completes a draft that is only a command
prefix (`/rel`, `/skill:re`) to a skill the user can invoke, using the bare form
only when nothing else answers to that name; several matches extend to their common
prefix and are listed in a notice. Otherwise Tab moves focus as before. Completion
reads the latest catalog, and admission still rechecks the pick. There is no
completion popup for `/`.

### Skill validity findings

`falryn doctor`, `falryn extension catalog`, `falryn extension inspect <path>` and
`/skills` answer why a skill cannot load or work, with one deterministic finding
model. Each finding has a stable code and severity, the exact skill (name, source key,
origin, relative path and SKILL.md content digest), a message, evidence and a suggested
fix. Evidence holds names, codes, counts and relative paths only: no skill body,
configuration value or secret. Findings never judge quality: rare use, size or style
are not failures, and SKILL.md size is reported as a fact on the entry.

| Code | Severity | Raised when |
| --- | --- | --- |
| `metadata-invalid` | error | Missing or malformed frontmatter, `name` or `description`, a name that does not match its directory, a non-boolean invocation control, invalid UTF-8 or a lookalike entrypoint name; the field is named |
| `version-incompatible` | error | The skill declares an execution control this version does not honor (`model`, `effort`, `context`, `agent` or `hooks`) |
| `reference-missing` | warning | A relative link in SKILL.md is missing, hidden, outside the skill directory, a symlink or not a regular file; links resolve exactly as `skill_resource` resolves them |
| `capability-unavailable` | warning | `allowed-tools` names an MCP server (`mcp__<server>__<tool>`) that is not configured and enabled in `tools.mcpConnections`; other entries are hints for other hosts and are not judged |
| `name-conflict` | warning | Equal-priority skills share a name and need a choice in `instructions.preferences` |
| `shadowed` | info | A higher-priority skill of the same name wins; the winner is named |
| `activation-failed` | error | The entrypoint is untrusted, oversized, unreadable, a symlink or not a file, or a stored admission refused this exact content (with the recorded reason and count) |
| `restricted` | info | `disable-model-invocation: true` or a preference restriction keeps the skill out of automatic selection |

Default checks reuse the discovery generation a turn would publish: discovery reads
each entrypoint once, and findings add no read. Links are checked with `stat` only,
at most 4,096 per check. The generation and its catalog decisions are read together,
so a reload publishing during a check cannot mix generations; restarting re-derives the
same findings from the same files. Stored refusals come from the skill usage report's
bounded history. Nothing starts a script, MCP server, provider or network request, and
nothing is rewritten, disabled or installed. A check that is cancelled, cannot read
history or configuration, or leaves links unchecked reports `complete: false` with
its omissions, and a missing generation is `unavailable`, never healthy.

Untrusted project skills are never read, so each reports
`activation-failed: workspace-untrusted` with the workspace trust status and reason.
A project SKILL.md without `name` and `description` fails the workspace trust review
itself (`inventory-malformed`); the fix names `falryn extension inspect` to find it.
Conventional discovery cannot produce equal-priority duplicates: a name must match its
directory, each location has its own priority, and another root's project skill is
excluded for the primary root rather than conflicting. `name-conflict` therefore
appears only for sources a resolver receives at equal priority.

`falryn doctor` adds a `skills` section: counts by severity, the 20 most severe
findings with the number not shown, and where the full listing is. A skill finding does
not change doctor's exit status. `falryn extension catalog --input` with
`{ "action": "catalog", "skills": {} }` lists every discovered skill with its findings.
The optional `skills` filter takes `code`, `severity`, an exact `name`,
`findingsOnly` and an `offset`; pages hold at most 100 entries or 256 KiB, unknown
fields are refused, and requests without `skills` are unchanged. Human, JSON and
JSONL output carry the same projection, and the source and compiled executables
produce the same JSON for the same files.

`falryn extension inspect <path>` is the deep check. For a package, the report adds
each `skills/*/SKILL.md` from the bytes inspection already read. A directory with a
`SKILL.md` and no package manifest is inspected as a standalone skill: its entrypoint
is read (no symlink, at most 1 MiB), then the directory is listed within the package
inspection limits (4,096 entries, 64 levels, 64 MiB, 30 seconds) to check links. A walk
that is cancelled or times out keeps the metadata findings and reports itself
incomplete. Name resolution, shadowing and admission history do not apply to an
inspected path.

`/skills` appends the same findings for the session's own discovery generation, read
from the instruction owner its turns use, without admission history. When a reload
changed the generation since the session last listed findings, it says the earlier
findings are stale. There is no Extensions view for findings yet (#274).

### Composer capability mentions

In the terminal composer, typing `$` at the start of the draft or after whitespace or
an opening bracket or quote opens a suggestion list above the draft. It lists
user-invocable skills, activated packages and configured MCP servers from the
metadata the session already holds; listing reads no skill body or schema and starts
no server. After a letter, digit or `_`, and for shell-like text (`$5`, `$HOME`,
`$PATH`, `$?`, `${` and similar), `$` stays an ordinary character and nothing is
queried. Unavailable rows stay listed with their reason. Up and Down move, Tab or
Return inserts the selected row as a mention, and Escape closes the list; Tab on a
plain `$word` reopens it, and otherwise still completes a `/skill` command or moves
focus. At most 8 rows show (5 below 60 columns, without the source column).

A picked mention is an atomic token bound to the exact identity picked: the cursor
skips it, Backspace after it removes it whole, undo restores it, and editing inside it
turns it back into plain text with a notice. Typing an exact label and then a space or
punctuation while the list shows exactly one exact, available row converts it as if
picked. Pasted, dictated, enhanced, template, model, scheduled and child text never
becomes a token. A prompt holds at most 8 capability mentions, of which at most 4
skills, and 64 tokens in all. Recalled history restores its tokens; prompt
enhancement keeps them as placeholders and refuses a proposal that drops one.

On submit every token is checked against the current catalog before the turn starts.
A skill loads exactly like `/skill:<name>`, with reason `explicit-invocation`. A package
adds its activated bound actions, and an MCP server the MCP tools, to the turn's
preferred capabilities; a picked server whose catalog is not current is connected
once as the user's request, and in that turn the model's calls to it count as the
user's selection, so an explicit-only server can be used. The model sees one section
naming the picks; nothing else is granted, and the preference ends with the turn. A
stale, unavailable, untrusted, not-user-invocable or unconnectable pick refuses the
whole prompt with one reason per token (`mention.*` codes), no turn and no provider
request, and the draft is kept. While a turn is running a draft with mentions is not
queued. The user message's history record keeps the tokens, and the transcript shows
a receipt such as `Using: gmail (package, …) · release-notes (skill)`. Headless
`falryn run` has no suggestion list: `$` there is plain text.


The `instructions.resolved` receipt records routing in `skills`: the number of
eligible candidates and each route's name, decision (`loaded`, `recommended` or
`unavailable`) and reason, plus the admitted source, digest and body bytes of a
loaded skill. It holds no body, so replay and export show these decisions without
reading a skill; the transcript's instruction notice lists each route with its
decision and reason. Child agents, workflow steps and scheduled runs never route
skills automatically. They load only what a child's agent definition or a
schedule preloads, with route reason `child-preload` or `schedule-preload` (see
Delegated agents and Durable schedules). A preload uses the automatic column of
the eligibility table, never user origin, so a manual-only (`disable-model-invocation`)
or restricted skill is refused. Any named skill that cannot load fails that child
or model step before its provider request, with an `instructions.rejected` fact and
no substitute. What a child or workflow step loads never becomes active for the
session's later main turns. Receipts also record estimated context contributions: a loaded body's tokens, each
route's own line in the routing section (bytes and tokens) and the whole section.
Estimates use the prompt composer's four-UTF-16-code-units-per-token rule and name
it (`utf16-code-units-per-4-v1`); they are not provider-measured. Receipts written
before these fields existed report their tokens as unestimated, never zero.

A loaded skill's other files (`references/`, `assets/`, `scripts/`, `templates/`,
`examples/` or anywhere else in its directory) are listed in the routing section
with path, kind, media type and size, inside that skill's own listing line. The list
comes from a directory walk that reads no file, skips hidden files, never follows or
lists a symlink, and names at most 32 files (with a count of the rest). The model
reads one with the `skill_resource` tool, which is offered whenever a loaded skill has
files. It takes a skill name, a path relative to that skill's directory and an
optional `depth`, and follows relative markdown links outside fenced code up to that
many hops (at most 16). One request resolves at most 64 files and returns at most
256 KiB of text, and a file over 1 MiB is refused unread. Each file is read at most
once and returns its digest and size. Every other outcome is reported separately:
binary (metadata only), already loaded, cycle, escaped (outside the skill directory,
absolute, or through a symlink), hidden (any path segment starting with a dot, such
as `.env` or `.git`, is never read), missing, too large, budget exhausted, beyond the
requested depth (named for a later request), reference limit, and changed during the
read.

Only skills loaded by the session's latest turn serve files. A skill whose `SKILL.md`
changed since it was loaded, or that lost its authority, refuses until the next turn
admits it. File text is evidence, not instructions. Scripts are listed as not
executable, and nothing in a skill runs during discovery, loading, indexing or
reading. A standalone skill's script gains no tool or execution authority; the model
can only use the ordinary run tools under their own authority. Package-admitted
executable helpers are not available (#901, #902), and package-installed skills are
not routed.

`falryn extension skills [--input request.json]` reports skill usage from those
stored receipts and from the metadata fact each completed `skill_resource` read
records on its invocation event (the skill, source and body digest it was bound to,
and each file's path, status, size, digest and estimated tokens; never file text).
It never reads a skill or resource, starts a script or MCP server, calls a provider
or records anything. It reads each session's stream and, as separate sessions, the
child, workflow-step and scheduled streams of the workspace that hold admissions,
which no session record lists. The optional request selects one `session` of the
current workspace (default: all of them, at most 256), a `skill` name,
`since`/`until` timestamps, a `limit` of stored events to scan (default 1,024,
maximum 4,096), an `after` continuation from the previous page of the same query,
and `aggregate: "source"` to merge a source's generations while keeping the
per-generation breakdown. Rows are keyed by source, content digest and configuration
generation, and count discovered, selected, shadowed, excluded, conflicting,
recommended, loaded, refused, invoked (explicit user invocations) and resource-loaded
(supporting files whose text a read returned) separately, plus reuse of an identical
earlier admission, load reasons, the admission scope (main, child or workflow) and
who caused each load: `explicit`, `automatic`, `child` preload, `schedule` preload, or
`unknown` for a reason this build does not recognise. A
recommended or refused route belongs to the source that won name resolution, so a
shadowed same-named source never inherits it. Body and listing contributions, and the
shared routing-section total, are reported with the estimator's name; resource
contributions are reported separately from the body. Each fact counts once by its
producer identity (an admission's workspace, scope, execution, generation and content;
a resource read's invocation and bound skill), so the same admission delivered by
another stream, an import or a replay is a duplicate, and a parent never counts a
child's admission.

Coverage lists each session's scanned sequence range and whether it reached the end.
Sequence gaps, unreadable events (skipped, with their neighbours still counted),
events outside the workspace or session, cancellation, and receipts that omitted
sources are reported as omissions, and only a window with none of these is marked
complete. A workspace with no admissions reports usage as unavailable, not zero. A
resource read whose skill has no admission in the window is reported unattributed,
and a read recorded before reads carried a fact is reported without files; either
makes the window incomplete. Provider-reported input totals are not stored per session, so they are
reported as unavailable and never attributed to a skill. An unknown session and a
continuation reused with a different query are refused. There is no Extensions view
for these results yet (#274).

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

`extension inspect`, `extension trust` and `extension notices` accept
`--installed <package-id>` instead of a path (#1279). The command then prepares the
package's current installed version from its exact cached bytes with the source the
lifecycle recorded, so it addresses the installed identity, including a package
acquired from a marketplace listing, which has no local path. Exactly one of a path or
`--installed` is required; other `extension` actions refuse `--installed`. A package
that is not installed, or no product database, answers `not-installed`; the read never
creates the database or contacts a source.

`falryn extension trust <path> --input <request.json>` previews an `approve`,
`revoke`, `quarantine`, `release`, or evidence `refresh` decision. The JSON request is bounded to 65,536
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
metadata. Each has `role: publisher | advisory | curator`, `id: sha256:<DER bytes>`, and
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

A refresh may also carry a `curation` proof: a `falryn.package-curation.v1`
statement (`subject`, `decision: curated | declined`, an embedded evaluation
`report`, `issuedAt`, `expiresAt`) signed by a key the request pins with role
`curator`. It is described under
[package evaluation and curation evidence](#package-evaluation-and-curation-evidence).

`falryn package <action> --input <request.json>` implements local package
installation transactions, explicit health checks and package standing. Actions are `inspect`, `data`, `health`, `install`, `update`,
`rollback`, `disable`, `uninstall`, `recover`, `enable`, `standing`, `quarantine`, `release`, `revoke`, and `evaluate`. Every request names
`packageId`, a UUID `operationId`, and `expectedRevision`. Install/update also
name `sourcePath` or, exclusively, a marketplace `listing` (see Marketplace package
acquisition); rollback names a previously returned `versionDigest`.
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

### Package standing, quarantine, revocation and recovery

`falryn package standing --input request.json` reports what an installed package
may do now and what the user can do about it, from the installed record alone, so
it works with the source directory gone and the network down. The request names
`packageId` and a UUID `operationId`; `expectedRevision` is required by the request
shape and ignored. The receipt's `data.standing` carries `state`, one of
`not-installed`, `eligible`, `unapproved`, `expired`, `changed`, `stale`, `quarantined`,
`revoked`, `incompatible` or `dependency-blocked`; the `reason` (the same
`ecosystem-trust-*` value the catalog and gateway report, or
`dependency-not-eligible`); the current `identityDigest` and `packageVersion`; the
trust `decision` status and `advisory`; the locked `dependencies` (at most 256) with
their own states; up to 64 retained `versions` each with its own state; the
`lastKnownGood` digest; `truncated`; and `recovery` choices.

Standing is derived on every read and stored nowhere. It combines the lifecycle record,
the shared trust projection of each installed version (local user scope) and the
installed dependency closure. A locked dependency that is missing, is not the locked
digest, or is not eligible blocks its dependents. `lastKnownGood` is the newest retained
non-current version whose own approval is still current. Recovery choices are `inspect`,
`refresh-evidence`, `approve`, `release`, `rollback` (with the `versionDigest` it
would restore), `update` and `uninstall`. They are offered and never taken: no version
is substituted for a revoked or quarantined one, nothing downloads in the background
and a restored version stays inert until it is enabled through its own checks.

`quarantine`, `release` and `revoke` use the same preview and `confirmation` flow as
other mutations and write one revision to the existing trust decision store, so the
catalog and every launch check read the change at once (the tool gateway's session view
follows at its next publication, below) and the decision, its optional `reason` category (`integrity`, `suspected-compromise`,
`unexpected-behavior`, `policy` or `other`) and its receipt are retained. The package
lifecycle revision does not change; the request's `expectedRevision` must still match it.
`quarantine` blocks the exact installed identity until a `release`, which leaves it
unapproved: approval is a separate revision with its own expiry of at most 30 days, and
`revoke` needs an existing decision for that identity. An approval cannot be recorded over a quarantine,
and no override of a revocation or quarantine exists. A binary that predates holds reads a
`quarantine` or `release` record as malformed and denies, never as approval. `falryn extension trust` accepts
`quarantine` and `release` for a source path as well.

A revocation or quarantine admits no new package process: every start re-reads trust and
the dependency closure live, so nothing launches after the hold. A long-lived session's
published catalog view, and so which tools it lists, refreshes at its next publication
(each turn); a tool can stay listed until then and still ends at the live launch check.
Work already running holds an immutable binding and stops at its next protocol boundary,
because the generation it was admitted under includes the package record, its trust and
its dependency closure; its process tree is then cleaned up by its owner within that
owner's bounds.
Retained bytes, decisions and receipts are not removed by the transition. The receipt's
`data.runningWork` states this policy.

Rollback receipts preview `data.rollback.target` with the target version's standing and
`restoresApproval: false`. Rollback restores bytes only, offline; a revoked or
quarantined target stays so. It is still refused while an installed dependent locks the
current digest. Uninstall with `retention: remove` refuses with
`quarantined-evidence-retained` while a retained version stands quarantined (or its
standing cannot be read), returning `data.quarantinedEvidence` with the versions, files
and bytes removing it would delete; `purgeQuarantined: true` is the explicit choice that
allows it. `falryn extension catalog` entries report `quarantined` and
`dependency-blocked` as their own trust labels.

`falryn doctor` adds a `packages` section. For each package with a current version, at
most 256 by package ID with the rest counted as `omitted`, it reports the standing
`state` and `reason` that `package standing` reports, notice counts by severity and the
number acknowledged as `extension notices --installed` derives them, and the newest
evaluation's decision, evaluator, time and whether it was recorded for an earlier
version. A part that cannot be read, such as notices whose cached bytes are gone, is
`unavailable` with a code on that package alone. The section reads only a database
at this build's schema, opened without creating or migrating it: with no database it
is `absent`, and at another schema version or when unreadable it is `unavailable`
with `package-state-unavailable`. Cancellation reports `cancelled`. Package standing is
advisory: human output adds a finding for each package that is not eligible, and
neither changes doctor's exit status. No keys, signatures, paths or catalog text appear.

Unavailable: fetching advisories, an OpenTUI view, export and replay projections of
standing.
Package-contributed MCP servers have no connection path, so MCP clients remain
configured by the user.

### Package evaluation and curation evidence

`falryn package evaluate --input request.json` (#168) evaluates the current installed
version of `packageId` against the rubric `falryn.package-rubric.v1` and retains the
report. It reads installed records only: the cached bytes against the recorded identity,
the shared trust projection, package standing, host compatibility and the newest native
health or tool attempt per contribution recorded for that exact identity. It never runs
package code, downloads, approves, enables or installs, and it never creates the product
database; with none, the answer is `not-installed`. `confirmation` and `reason` are
refused.

The report lists thirteen criteria in fixed order (provenance, ownership, integrity,
effects, privacy, security, compatibility, maintenance, documentation, tests,
accessibility, resources, quality), each with an outcome (`pass`, `fail`,
`inconclusive` or `not-applicable`), a basis (`observed`, `curator` or
`behavioral-report`) and a closed code. The decision is derived: any failure is
`not-eligible`, otherwise any open criterion is `inconclusive`, otherwise `eligible`.
The receipt code is `evaluated-<decision>`.

| Criterion | Local observation |
| --- | --- |
| provenance, ownership | Verified publisher signature and publisher, or inconclusive; an invalid signature fails |
| integrity | Cached bytes prepare to the recorded identity, or fail as `bytes-unverifiable` |
| effects | Declarative packages are `not-applicable`. Any failed attempt fails as `native-failed`; full-user contributions are `full-user-opaque`; a missing attempt, an unsettled attempt or one completed without strict enforcement is inconclusive; every governed contribution completed under strict enforcement passes |
| security | A quarantined or revoked standing or advisory fails; a clear signed advisory passes; otherwise inconclusive |
| compatibility | Host compatibility of the installed bytes |
| privacy, maintenance, documentation, accessibility, quality | `curator-review-required` |
| tests | `behavioral-report-unavailable` |
| resources | `resource-measurement-unavailable`: attempts record CPU and memory as unavailable |

A local report is therefore never `eligible`. Each native attempt appears in
`observations` (at most 64, with `omittedObservations`) with its contribution digest,
mode, state, attempt code and enforcement (`strict`, `off` or `unavailable`), so a
denied undeclared effect that made an attempt fail is preserved. A full-user
contribution is reported but its effects stay opaque.

Migration 0036 retains reports in `package_evaluations`: at most 32 per identity and
1,024 in total, oldest first out. The report digest excludes `evaluatedAt`, so an
unchanged repeat keeps one record and reports `recorded: false`. The receipt's
`data.evaluation` carries the `report`, its `reportDigest`, `recorded` and up to 8
newest `history` entries for the package, each with its identity, evaluator, decision,
curation status and `stale: true` when it describes other bytes. One unreadable record
fails the answer (`evaluation-store-malformed`); a cancelled evaluation writes nothing;
an unconfirmed write is `uncertain`.

A curator signs a `falryn.package-curation.v1` statement embedding a report with
evaluator `curator`. Through `falryn extension trust` refresh, curation evidence becomes
`verified` only when the statement verifies with a pinned `curator` key, its lifetime is
at most 30 days, the statement and report subjects equal the exact package identity, the
statement says `curated`, the report is `eligible` and was evaluated no later than the
statement was issued. Otherwise curation stays `unavailable` and the evidence record
names `curationStatus`: `declined`, `ineligible-report`, `subject-mismatch` or
`invalid`. Verified curation expires with its statement. An applied refresh stores the
curator report in the same history and transaction; unauthenticated statements and
statements about other bytes are not retained. Evidence refreshed without a curation
proof keeps its earlier record shape.

Curation never approves, enables, installs or grants execution. The trust state
`curated` appears only without a user decision and with verified integrity and
signature; eligibility still needs the user's matching approval, and a refresh that
changes evidence leaves an earlier approval stale as before. Updated bytes are a new
identity, so earlier reports and curation do not describe them.

Unavailable: behavioral evaluation reports (#1092), an OpenTUI view, model-caller
access, and export or replay projections of evaluations.

### Marketplace package acquisition

Install and update accept `listing: { sourceId, listingId, packageVersion }` for one
exact version from an imported or refreshed catalog. The listing is gated when the
action runs, with the same rules as `extension listing` inspect: a `local` or
`fresh` catalog and a compatible, unwithdrawn version. Its refusal codes are
inspect's. A listing on any other action is `unexpected-package-listing`.

Where the bytes come from:

- A `registry` coordinate uses Falryn registry layout v1:
  `<registry>/<encodeURIComponent(coordinate)>/<encodeURIComponent(packageVersion)>/package.tgz`.
- An `archive` coordinate downloads exactly its `origin`. The SHA-256 of the received
  bytes must equal its declared digest (`archive-digest-mismatch`).
- Both must be `https`. `git`, `local` and `builtin` coordinates are
  `acquisition-source-unsupported`.

The download is one GET per hop, at most three redirects, 64 MiB and 120 seconds
in total, admitted by the product resource owner. Every hop must be `https` and is
re-resolved and pinned to public addresses. Only `200` with identity content
encoding is accepted. The listing marketplace's credential is sent only to hops on
that marketplace's own origin; a redirect elsewhere never receives it. Download
failures are `package-download-*` codes.

The archive is a gzip POSIX ustar/pax tar, read in memory by Falryn:

- Expansion is limited to 64 MiB and 4,096 files.
- Paths must be safe package-relative paths of at most 1,024 bytes and depth 32.
- Links, devices and FIFOs are refused, as are duplicate or case-colliding paths
  and malformed headers.
- The package root is the archive root when it holds `plugin.json`, otherwise its
  single top-level directory.
- Refusals use `archive-*` codes.

The package is prepared with the listed source coordinate. Any identity other than
the listed one is refused before preview (`acquired-identity-mismatch`), including
when served bytes change between preview and confirmation. Preview and confirmation
each download again; the receipt's `acquisition` records the listing, final URL,
byte count and redirect count. Installed versions keep their source coordinate, so
rollback reads retained bytes without a download. Pinned Git acquisition is not
provided.

Installation and trust approval do not create executable bindings. `package enable`
without a native activation request still returns `activation-owner-unavailable`.
The explicit native tool and prompt-template paths below publish only their
selected contribution identities. Pinned Git acquisition, module services, full-user
execution and other native-kind adapters remain unavailable. Scope controls remain
metadata preferences.
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
Each selected `http-v1` hook also needs one entry in `grants`: its `contribution`,
exactly its declared `url`, and, when the hook names a credential, the user's
`credential` reference (`operating-system-keychain` or `environment` store, locator,
optional account label); `null` when it names none. A request without them fails as
`hook-grant-required` and lists each hook's `requirements`; a different URL or
credential shape fails as `hook-grant-destination-mismatch` or
`hook-grant-credential-mismatch`, and a grant for anything else as
`hook-grant-unexpected`. The preview repeats the requirements, and confirmation
stores the grants with the activation, so disabling, withdrawing trust or updating
the package revokes them with it. Activations without grants keep their exact
stored digests.
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

An activated package prompt contribution, either a non-recursive `prompts/*.md`
file or an explicit manifest `prompt` entry naming another package file, binds
as a slash action. Its short alias is the file name or declared id, and
`/<package>:<alias>` is always available. Activation needs no sandbox because no
package code runs. Registration keeps only the description, `argument-hint` and
any declared variables;
the body is read from the installed package bytes when the template is invoked,
after the catalog, activation, trust, scope and installed revision are checked
again. A disabled, revoked, updated or otherwise stale package fails expansion.

In the terminal composer, `/<alias> <arguments>` replaces the draft with the
expanded text and names the template and its content digest. Nothing is sent
until the draft is submitted; if the draft changed during expansion, the result
is not applied. The composer's template catalog is refreshed when a session
opens and when each turn starts, so a package enabled mid-session offers its
templates after the next turn; a disabled, revoked or updated package fails at
its next expansion. In `falryn run`, a prompt starting with `/<alias>` is expanded
and the text is submitted as the ordinary turn. The payload `prompt` is the
expanded text and `promptTemplate` reports the package, template, content
digest, argument count, substitutions and rendered bytes without the body. A
failure returns stage `template-failed` with an error such as
`template.unknown-template` and makes no provider request. Built-in shell
commands such as `/mode`, `/model`, `/peer` and `/schedule` always win. A headless
run refuses them with stage `command-refused` and makes no provider request (see
Shell commands). An alias provided by more than one package or
scope requires the qualified form. Unknown alias-shaped names fail, while text
such as `/usr/bin` is not a template name.

Arguments split on Unicode whitespace outside single or double quotes. Quotes
are removed, adjacent segments join, empty quoted segments are dropped,
backslash is literal and an unclosed quote fails. The body supports `$1` to
`$N`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:-default}`,
`${ARGUMENTS:-default}`, `${@:N}` and `${@:N:L}` in one left-to-right,
non-recursive pass. Values are inserted verbatim and never evaluated. Any other
`${…}` form, position 0 and numbers above 2,147,483,647 fail; a `$` that starts
no form stays literal. Optional frontmatter is a YAML 1.2 mapping between exact
`---` lines, after one BOM is removed and CRLF is normalized. Aliases, anchors,
merge keys, custom tags and non-JSON values fail. The body is trimmed after
frontmatter, and a missing description comes from the first non-empty body line
(60 characters plus `...`). Limits are 128 conventional templates per package,
72 KiB per file, 8 KiB frontmatter, 64 KiB body, depth 8, 64 keys of up to 128
bytes, a 512-byte description, a 256-byte hint, 64 arguments, 16 KiB of argument
text, 4 KiB per argument, 1,024 substitutions and 128 KiB of expanded text.

An explicit manifest `prompt` entry may declare typed variables:
`variables: { version: 1, additional?, entries: [...] }`. Each entry has a
`name`, a `type` (`string` with optional length bounds, `number` with
optional `integer` and range, `boolean`, `enum` with `values`, `array` with
`items` and a required `maxItems`, or `object` with `properties`), and optional
`required`, literal `default`, `sensitive` and `description`. Names are
identifiers other than `ARGUMENTS`; a declaration allows at most 32 variables, type
nesting depth 4, 64 array items, 32 object properties and 4 KiB of text per
value. A required or sensitive variable cannot have a default, a default must
match its type, and other kinds cannot declare variables; package preparation
rejects violations. The body uses `${name}` or `${name:-fallback}` for a
declared name; an undeclared name stays malformed. At invocation a
`name=value` argument binds a declared variable, and the remaining arguments
stay positional. Strings and enums are plain text, numbers are JSON numbers,
booleans are `true` or `false`, and arrays and objects are JSON; each renders in
one deterministic form (objects with sorted keys) through the same renderer and
128 KiB ceiling. An undeclared `name=value` fails unless `additional` is true,
when it stays positional; a duplicate or an undeclared object key also fails.
Failures use typed codes (`variable-missing`, `variable-unknown`,
`variable-duplicate`, `variable-malformed`, `variable-type`,
`variable-constraint`, `variable-limit`) naming the variable path, never the
value. Every given value is checked before missing ones are reported. In the
composer, each missing required variable is asked for in turn: type the value
and press Enter, or press Escape to restore the original invocation and send
nothing. In `falryn run`, a missing required variable fails with
`template.variable-missing`, names what to pass and makes no provider request. The
`promptTemplate` fact lists each variable's name, value source (`argument`,
`entered`, `default` or `absent`) and sensitivity, never a value; a
sensitive value appears only in the draft or prompt the user sends. Completion
and model invocation of templates are not available yet.

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

### Curated catalog listings and marketplaces

`falryn extension listing --input request.json` imports, refreshes, lists and
inspects curated catalog metadata. The request is one of:

- `{ "operation": "import", "file": "catalog.json" }` reads one local file.
- `{ "operation": "refresh" }` or `{ "operation": "refresh", "sourceId": "id" }`
  fetches configured marketplaces.
- `{ "operation": "list", "query": { ... } }` with optional `sourceId`, `kind`,
  `provides`, `text`, `installable`, `offset` and `limit` (1–100, default 50).
- `{ "operation": "inspect", "query": { "sourceId", "listingId", "packageVersion"? } }`.

Only import and refresh write, and only catalog metadata. Nothing downloads, installs,
enables, starts or trusts a package.

Marketplaces are user-scope configuration: `connections.marketplaces.sources`
(flat key `tools.marketplaces`), at most 16 entries of `id`, an https `url` without
credentials, query or fragment, `enabled` (default true), `maxAgeHours` (1–720,
default 24) and an optional `credential` reference or `credentialEnvironment`.
Configuring one contacts nothing. Refresh fetches each enabled marketplace in
order, or one named source, with one GET per source admitted by the product
resource owner. Every resolved address must be public and the connection is pinned
to it; redirects, non-200 statuses, compressed or non-`application/json` bodies and
bodies over 1 MiB are refused, with a 30-second limit. The credential is resolved for
consumer `marketplace:<id>` and sent only as a bearer token to that URL. The
document's `source.id` must equal the configured `id`
(`marketplace-source-mismatch`), and it is then ingested exactly like a local
import, including the sequence rules below. A failed, refused or cancelled source
leaves its cached catalog unchanged; other sources still refresh, and the command
reports each source's result and fails when any source did.

A catalog is a `falryn.curated-catalog` generation-1 JSON document of at most 1 MiB:
`source` (`id`, `title`), a positive `sequence`, `publishedAt` and up to 512
`entries`. Each entry has a `listingId` (`namespace/name`), a `kind` from the design's
package classes (`skill`, `plugin`, `hook-pack`, `workflow-pack`, `mcp-preset`,
`documentation-set`, `example-pack`, `theme`), bounded `title`, `summary` and
`description`, `publisher`, `license`, https-only display `links`, `tags`,
`localizations`, `provides` contribution kinds, and 1–32 `versions`. Each version is an
exact `PackageIdentityV1` with optional `compatibility` and `withdrawn`, so a listing
never redefines package equality and links are never a download location. Optional
`claims` (`review`, `signature`, `tests`) are stored as `absent`, `unsupported` or
`claimed` true or false under `authority: "catalog-claim"` and never become trust
evidence. `editorial` labels, rank and featured flags are kept separately and never
affect identity, ordering, trust or availability.

An unsupported schema or generation, an unknown field named in the document's
`requires`, a malformed header, duplicate JSON keys or an oversized document refuses
the whole catalog. An entry problem refuses only that entry, with a JSON-pointer
path and code but never the submitted value: invalid or credential-bearing links,
text containing control, bidirectional-override or zero-width characters, an unknown
`requires` field, or versions that mix packages or repeat one. Two entries with the
same `listingId` or the same exact package identity are both refused. Other unknown
fields are ignored and reported, never kept. The normalized record is canonical
JSON with a digest, so the same content always serializes identically.

Migration 0034 stores one record per source (at most 64). Only a higher sequence
replaces it; the same sequence with a different body is `catalog-sequence-conflict`
and an older one `catalog-stale`. When a newer import refuses an entry, the listing's
previously accepted form is kept and listed as retained with the sequence it came
from, unless the new catalog lists its package under another entry. Other sources are
never changed; listing shows which other sources list the same exact package. A stored
record with an unknown record version or a changed body is reported unavailable and
is not replaced by a later import. Record version 2 stores the origin: `file`, or
`marketplace` with the exact URL, fetch time and received-document digest. Version-1
records read as file imports. Fetching the same catalog again renews only its fetch
time.

Listing and inspection read only stored records and work offline. Each source
reports its origin and freshness:

- `local`: a file import, with no freshness claim.
- `fresh` or `stale`: the fetch time against `maxAgeHours`.
- `unconfigured`: fetched from a URL no longer configured for that source.
- `disabled`: listings are withheld while the marketplace is disabled.
- `unknown`: configuration could not be read.

Withdrawals are shown as of the fetch; a stale catalog never claims they are
current. Without `text`, listing orders by source and listing ID. With `text`,
listing ranks by exact ID or title, then prefix, then substring, then tag, then
summary, and then orders by listing ID and source. `installable` keeps listings with
a compatible, unwithdrawn version. Editorial rank, labels and featured flags never
order, filter or trust anything.

Inspect selects the requested version, or else the newest compatible unwithdrawn
version, or else the newest. It shows the publisher, source URL and freshness,
sequence, exact package identity and identity digest, compatibility, withdrawal,
contribution kinds, catalog claims (labelled unverified) and other sources listing
the same package. The executable profile is `unknown-until-local-inspection`.
Install is refused for a withdrawn or incompatible version and for a catalog that is
not `local` or `fresh` (`source-not-current`). Otherwise it is `available`, with the
download URL and whether the marketplace credential applies (see Marketplace
package acquisition). `git`, non-`https`, `local` and `builtin` sources are
`unavailable` with `acquisition-source-unsupported` or `acquisition-insecure-origin`.
A later catalog that
withdraws or drops the version changes what inspect shows; earlier results are not
reused. OpenTUI marketplace views are not provided. Human output labels claims as
unverified.

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

### Verified package suggestions

Falryn can suggest an uninstalled package from a marketplace the user opted into. Two
observations count, and neither is trusted:

- A hint line on the stderr of a command the model ran through `run_process` or
  `run_shell`. The line must start at the beginning of a line with
  `falryn-package-hint/1 ` followed by one JSON object: `sourceId`, `listingId`,
  `packageId` and an optional exact `packageVersion`. Any other field, including a URL or
  command, makes the line malformed. A whole line is at most 4 KiB and a stream yields
  at most 8 distinct hints. Indented, quoted or embedded copies, other versions
  (`marker-codec-unknown`), invalid UTF-8 and oversized lines stay inert text. Only the
  exact inline capture of the admitted command is scanned: hook output, projections,
  replay and exports are never read, and the capture and the model's view of it are
  unchanged.
- A catalog entry's optional `relevance` declaration, compared with facts Falryn
  already observed: up to 16 exact executable names (`executables`), matched against an
  argv-mode command's file name, and up to 16 bounded workspace globs (`files`),
  matched by the discovery glob codec against workspace-relative paths that
  `read_file`, `read_compact_document`, `stat_path`, `write_files` or `mutate_paths`
  completed on. Shell text has no admitted program, so `run_shell` contributes hints but
  no executable name. A declaration may also list capability kinds (`capabilities`,
  from the tool vocabulary such as `process`, `lsp` or `mcp`), matched when a
  call through the product tool gateway completed with a tool of that kind. Failed
  calls and hook-origin calls report no kind. Entries without the field keep their
  stored digest.

Suggestions use only sources named in user configuration
`connections.packageSuggestions.sources` (flat key `tools.packageSuggestions`) that are
also configured marketplaces. Project configuration
`defaults.capabilities.packageSuggestionProposals` can only propose sources; they are
listed as proposals and enable nothing, and the user-only key in a project file is
refused. A file-imported catalog is never a suggestion source
(`suggestion-source-unauthenticated`). A hint is resolved against the stored catalog,
which must list that exact `packageId` (`suggestion-identity-mismatch`); unknown
sources, listings and versions are refusals, never installable suggestions. Every read
inspects the listing again, so a withdrawal, removal, disabled marketplace or removed
opt-in takes effect immediately. Package identity and source authentication are
checked again on the facts actually shown, so a catalog replaced between admission and
presentation produces a refusal, not a suggestion under the earlier reason. A stale
catalog keeps its freshness and offers no
install (`source-not-current`). Matching runs locally: it makes no model call, sends
nothing to a marketplace and reads no file content.

A session keeps at most 128 distinct observations and counts the rest. Suggestions are
identified by source and package, so duplicate output or a newer version is the same
suggestion. When a root turn settles, at most one installable, undismissed suggestion
not shown before in the session is recorded as an `extension.suggestion.recorded` event,
with up to 8 other eligible matches. Child, evaluator and cancelled turns record
nothing. The terminal transcript and `falryn run` show it as a notice that says nothing
was installed; JSON output carries it as `suggestion`. Replay and export read the record
and never match or notify again. A new or resumed session starts with no observations.

`/suggestions` in the terminal and
`falryn extension suggestion --input request.json` show the same projection: identity,
reasons, catalog freshness, install state and refusals. Requests are:

- `{ "operation": "list", "sessionId": "id" }`: that session's recorded suggestions,
  checked against current catalogs and preferences.
- `{ "operation": "inspect", "sourceId", "listingId", "packageId", "packageVersion"? }`.
- `{ "operation": "dismiss", "sourceId", "packageId", "expectedRevision" }` and
  `{ "operation": "reset", "sourceId"?, "packageId"?, "expectedRevision" }`.

List and inspect report the user configuration file's `revision`. Dismiss and reset
write only `tools.packageSuggestions.dismissed` (at most 256 entries) and are refused as
`suggestion-preferences-stale` when the file changed after that revision was read. The
revision is read before the preferences it guards, so of two concurrent writers holding
the same revision one is refused and neither update is lost. A
dismissal names a source and package, so a package update does not reset it. An
available suggestion carries only a `listing` handoff for `falryn package install`,
which inspects, downloads and asks for confirmation itself. Nothing in this path
installs, enables, trusts or refreshes a package or catalog.

### Extension notices

`falryn extension notices <path>` lists why a local package is limited or at risk.
It derives notices on every read from the facts that decide invocation: the
package's trust projection, host compatibility, dependency resolution and the
newest package-health attempt per contribution for the same installed identity,
including an unterminated uncertain attempt that needs recovery. Only
acknowledgements are stored. A package with no cause has no notice; an unapproved
package and a missing execution grant are normal states, not notices. Without a product database the command
answers from empty owners and does not create one.

A notice carries a digest `id`, the package subject, a closed `code`, a `state`
(`unavailable`, `degraded`, `incompatible`, `quarantined`, `revoked` or `failed`),
a `severity` (`blocking` when the shared decision denies invocation, `warning`
otherwise), that `impact`, the `reason`, one `requiredAction`, at most three
remediation handles, bounded evidence (digests, closed status words, the advisory
sequence and at most 32 advisory identifiers) and freshness. The `id` binds the
subject, code and cause, never a timestamp or a health attempt identity, so
repeated reads, restarts and a flapping probe keep one identity while a newer
advisory sequence, changed evidence or another health generation is a new notice.
Notices contain no keys, signatures, paths or catalog display text.

| Code | State | Effect |
| --- | --- | --- |
| `advisory-revoked` | `revoked` | blocking |
| `advisory-quarantined`, `advisory-unverified`, `integrity-mismatch`, `signature-invalid`, `signature-conflicting` | `quarantined` | blocking |
| `evidence-stale`, `approval-expired`, `approval-changed` | `degraded` | blocking |
| `host-incompatible` | `incompatible` | blocking |
| `dependencies-unresolved` | `unavailable` | reported only |
| `dependencies-degraded`, `health-uncertain` | `degraded` | reported only |
| `health-failed` | `failed` | reported only |

Dependency and health notices do not change the trust decision. Package launch
admission is separate and still refuses unresolved dependencies and a contribution
with three consecutive failed health attempts. There is no
advisory fetcher, so an advisory arrives through a signed `extension trust` refresh
with a higher sequence and leaves the same way; a withdrawal does not restore an
older approval, so the package needs a fresh approval and `approval-changed` says so.

Discovery, diagnostics and a refused invocation now state one reason from the same
trust projection: `ecosystem-trust-required`, `ecosystem-trust-revoked`,
`ecosystem-trust-quarantined`, `ecosystem-trust-incompatible`,
`ecosystem-trust-stale`, `ecosystem-trust-expired`, `ecosystem-trust-changed` or
`ecosystem-grant-required`. The capability card's availability reason, the health
diagnostic message and the gateway's `denied` reason are that value. Revoked and
quarantined trust reports health `quarantined`, incompatible trust reports
`incompatible` and any other ineligible trust reports `denied`; none is selectable.
`falryn extension catalog` entries, `package health` and native admission refusals,
and a native tool call that was already disclosed when its package lost trust state
that value too (#1279); the catalog's dependency-blocked entries state
`dependency-not-eligible`, and so does such a refused native call. A native call
refused for any other catalog change stays `stale-native-catalog`. A revoked or
quarantined package's tools are no longer offered
to the model in later turns.

`--input <request.json>` accepts one strict request of at most 16,384 bytes:
`{"action":"acknowledge","noticeId":"sha256:...","expiresAt":<epoch ms>}`. The
preview returns a `confirmation` bound to the notice, scope, stored revision and
expiry; repeating the request with it writes one record in migration 0035 for the
local-user scope. The expiry must be in the future and within 30 days. An
acknowledgement hides the notice's presentation, leaving one line that says it is
acknowledged and whether invocation is still denied. It changes no trust,
provenance, health or eligibility, does not cover a different notice `id`, and
lapses at its expiry. A cause that recurs with the same identity, such as a health
failure in the same generation with the same code, stays acknowledged until then. The table keeps at most 1,024 live records and prunes expired
ones on the next write. Session export does not carry acknowledgements.

A corrupt acknowledgement row is read as unacknowledged and can be replaced by a new
acknowledgement.

Limits: notices are per package path or installed package (`--installed`). No OpenTUI view, export or replay projection
exists yet, and `falryn doctor` does not report them; the capability doctor reports
the same reasons through health diagnostics. Package health records carry no
timestamp, so a health notice's freshness is `unrecorded`.

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
validates protocol readiness, discovers its catalog and closes it before returning.
Its `probe` result records readiness, `catalogs` and `entries` record the catalog
as discovered (kind and availability per entry), and `connections` records the
final stopped state. Human, quiet, JSON and JSONL output share those facts. Probe
failures retain a named code.

Headless and terminal model runtimes publish `mcp_inspect`, `mcp_connect`,
`mcp_catalog`, `mcp_resource_template`, `mcp_get_prompt`, `mcp_call_tool` and
`mcp_stop` through the existing registry, confirmation, resource admission and tool
runner. MCP-related tasks or explicit discovery disclose the controls. No peer
starts until an admitted connect request. The model has no untyped protocol
request tool; each MCP operation has a typed owner. Results use normal invocation
history, projection and replay; replay never reconnects or repeats a remote effect.

### MCP catalog, resources and prompts

Connecting (`mcp_connect` or `falryn mcp probe`) discovers the tools, resources,
resource templates and prompts the server advertises, and connecting an available
server again refreshes them. Entries are identified as
`mcp:<server>/<kind>/<encoded name or URI>` and carry their catalog generation. A
server never discovered is `unknown`, not empty. Each kind keeps at most 1,024
entries per server; names are bounded to 256 characters, URIs to 2,048 and
descriptions to 1,024 (flagged when shortened). Duplicate and malformed entries are
skipped and counted. A refresh publishes one complete replacement; a failed refresh
keeps the previous catalog, marked stale with its failure code.

A catalog becomes stale when its server's transport or configuration generation
changes, the server stops or degrades, a list-change notification arrives or a
refresh fails. Notifications only mark the catalog stale; they never refresh, start
a model turn or call a tool, and bursts collapse into one change. On the current
protocol, notifications need the server's list-change subscription. A server that
does not advertise one, or whose subscription closes, is reported as
`listChanges: "unobserved"`: its catalog stays usable but may change without
notice, and a subscription that ends marks the catalog stale once.

`mcp_catalog` pages entries (at most 100 per page) with kind, availability and read
handles and makes no server call. Pages are compact and omit tool input schemas;
passing one `entryId` returns that entry complete. Its cursor is bound to the
published catalog and filter; an old cursor is `mcp-catalog-cursor-stale`.
`mcp_resource_template`
validates name/value arguments against the template's variables (RFC 6570 levels
1–3; path-forming variables are required, query-style ones optional; other syntax is
listed as `unsupported`) and returns a read handle without a server call.
`mcp_get_prompt` validates arguments against the prompt's declared arguments and
returns its messages as context without starting a model turn. Text and embedded
text resources are kept exactly; other content is reported as `unsupported` with its
type. Entries, handles and cursors from an older catalog generation return a typed
stale result and never select a same-named newer entry; a list change during a read
or prompt request also fences its result.

Read handles have the form `mcp:<server>/resource/<encoded URI>?catalog=<generation>`
and are `virtual` targets for the unified `read` tool. A read is admitted only for a
URI listed, or produced by a template, in that server's current catalog. One text or
base64 blob item with the requested URI becomes exact bytes with a digest, retained
as an artifact and evidence; multi-part results are `unsupported` and a different
URI is `failed`. Configured secret values are redacted before bytes are retained.
Server resources are readable evidence, not workspace mutation targets. Retained
evidence stays readable, reported as historical, after its handle becomes stale, and
is denied once the server is removed or disabled. Results larger than 1 MiB fail as
`mcp-result-too-large` and non-converging pagination as
`mcp-list-pagination-exceeded`. User-input requests, task-backed tool calls, MCP
Skills, MCP Apps, MCP-proposed workspace changes and provider-native disclosure of
MCP tools are separate capabilities.

### MCP tool invocation

Discovery normalizes each tool's input schema into Falryn's bounded definition
subset: annotation-only keys (`$schema`, `$id`, `$comment`, `title`, `default`,
`examples`, `format`, `readOnly`, `writeOnly`, `deprecated`) are dropped and
objects that do not declare `additionalProperties` are closed. A schema still outside
the subset (for example `anyOf`, `$ref` or an open object) lists the tool as
`unsupported`. The normalized schema and its digest belong to the catalog
generation. Server hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) are shown as untrusted metadata only.

`mcp_call_tool` takes an `entryId`, its `catalogGeneration` and `argumentsJson`.
Every MCP tool call is an external effect that goes through normal confirmation,
whatever the server's hints say. Arguments must be a JSON object that satisfies the
normalized schema (`mcp-tool-arguments-invalid` otherwise), and an unsupported
schema is `mcp-tool-schema-unsupported`; neither reaches the server. Immediately
before dispatch the selection is revalidated, so a stale generation, a disabled or
removed server, a configuration change or a lost connection returns a stale result
with no call. The call validates structured output against a declared output
schema.

The result records the entry, catalog generation and schema digest with `isError`,
`content` and `structuredContent`. `isError` is the tool's own reported error: the
invocation completes so the model can correct it. A malformed result is
`mcp-tool-result-malformed` and oversized results are
`mcp-result-too-large`; these and disconnects after dispatch report an uncertain
effect and are never retried. An uncertain effect describes the server: the call has
settled locally, so its resource reservation is released rather than held for a
termination that cannot come. A result is untrusted content: payloads that resemble
task progress or Todo state carry no authority.

A current-protocol server may ask for form input during `mcp_call_tool`.
Current-protocol connections declare form elicitation only; legacy connections
declare none, and `prompts/get` and `resources/read` still return
`mcp-input-required-unavailable`. A round may carry four form requests, each
with a message of at most 8 KiB and at most eight fields of the supported
string, number, integer, boolean, enum and enum-array schemas. The message and the
first field's label must fit one 8,192-character question prompt; a choice may
have 32 options, one fewer when optional. Anything else, including URL, sampling
and roots requests, ends the call as `mcp-input-request-unsupported` with an
uncertain effect and no retry.

Each form request becomes one structured question for the local user, showing
the server, tool and message. Choices, yes/no fields and optional fields (with a
skip option) are selections; text and numbers are free text validated after
entry against length, format and bounds. Server defaults are shown as suggestions
and never applied. An answer that fails validation is asked again with the
reason, at most three times, and is never sent. Answered becomes `accept` with
the validated content, refused becomes `decline`, and expiry, cancellation, a
missing presenter or exhausted attempts become `cancel`. Headless runs have no
presenter, so every request is cancelled; nothing is answered for the user.

Before each retry the selection is revalidated; the retry repeats the tool name
and arguments with `inputResponses` and the server's verbatim `requestState` on
a new request. A disconnect, reload or catalog change while a question is open
withdraws the question and ends the call as stale with an uncertain effect,
sending nothing. An abandoned call sends nothing more. After four answered rounds
a further request ends the call as `mcp-input-rounds-exceeded`. Each MCP request
keeps its 30-second deadline, `mcp_call_tool` may run for 16 minutes, and each
question waits at most 15 minutes, narrowed so the retry still fits. The result
adds `inputRounds` receipts (round, request key, schema digest and `accept`,
`decline`, `cancel` or `timeout`) without answer contents. The
`mcp.elicitation` and `mcp.elicitation.result` hook payloads are produced with
the same facts; no hook dispatcher consumes them yet.

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
credentials, queries, fragments and redirects, and sends only its own bearer
credential.

An HTTP server may name a credential reference: `credential` with a `storeKind`
(`operating-system-keychain` or `environment`), a `locator` and an optional
`accountLabel`, or the shorthand `credentialEnvironment` for an environment
variable; the two are exclusive. The reference is resolved through the same
credential stores as provider credentials, and only for that server: its consumer
is always `mcp:<server-id>`, so no other server or integration can resolve it.
Resolution happens when the connection starts. A missing or empty secret is
`mcp-credential-missing`, a locked or refused store `mcp-credential-denied`, and an
unreachable store `mcp-credential-unavailable`; none of them sends a request. When
the server answers 401, the reference is resolved again once and the request is
repeated once, so a rotated secret is picked up without a reconnect. A second
rejection is `mcp-auth-rejected` and a 403 is `mcp-auth-forbidden`. Either leaves
the connection `denied` until the credential or access changes, and because the
server refused before accepting anything, a tool call reports no effect. Every
secret a connection has sent, and configured secret values, are redacted from
returned content; failures carry codes, never locators or secrets. Other
server/provider values are not inherited by stdio.

Limits are 64 configured identities, 1 MiB per protocol message, 32 pending
requests per endpoint, a 30-second deadline, and three start attempts per endpoint
in 30 seconds. SDK list walks stop after 16 pages.

Only work the server provably did not accept is retried. A read, list or prompt
request refused with HTTP 429 (`mcp-rate-limited`) or 502/503/504
(`mcp-server-unavailable`) is tried at most three times on the same connection,
waiting the server's `Retry-After` (up to 10 seconds) or a jittered backoff from
250 ms to 2 seconds. A wait that would pass the request's deadline is not started,
and the refusal is returned with no effect. A connection start refused the same
way is retried within the same three-start budget, shown as `mcp-retry-wait` while
it waits. Cancelling during any wait ends it as `mcp-request-cancelled` or
`mcp-startup-cancelled` with no further attempt. Tool calls are never retried: a 429
on a call reports no effect, while a gateway failure, a disconnect or a lost
response after sending stays uncertain. A server that exits or disconnects leaves
its connection `degraded`; nothing reconnects or resends by itself. An explicit
`mcp_connect` or `falryn mcp probe` starts a new transport generation with fresh
configuration and capability checks, and results or selections from the old
generation are stale. Shutdown aborts and settles pending requests before
reporting stopped. Cancellation, configuration changes and disconnects preserve
uncertainty for a sent tool call.

Stdio is available on POSIX hosts with owned process-group termination. Windows
stdio returns `mcp-stdio-platform-unavailable` before launch; HTTP remains
available. Unsupported protocols and missing credentials do not publish a ready
binding. Automatic peer discovery, OAuth enrollment and server-initiated sampling
remain separate capabilities.

Example user configuration:

```json
{
  "schemaVersion": 2,
  "minimumReaderSchemaVersion": 2,
  "connections": {
    "mcp": {
      "servers": [
        {
          "id": "remote",
          "transport": "http",
          "url": "https://example.com/mcp",
          "credential": { "storeKind": "environment", "locator": "MCP_TOKEN" }
        }
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

Capability discovery (#947) lets a later step reach what the eager set left
out. When terminal and headless turns register the built-in
`discover_capabilities` observation, the opportunity plan always selects it
in a reserved slot. That slot never counts against a family budget, never wins
a semantic tie and is never a degradation target. The capability brief tells
the model to use the disclosed tools first and to call it with the
disclosure's `capability-catalog:<generation>` handle only when none fits. A
call runs through the normal gateway and answers from the attempt's current
capability and tool registries. Results are ranked by matching task words,
paged and bounded. Each entry reports registered, enabled, preparable,
prepared, disclosed and executable separately, with the runtime's reasons and
recovery handles. The status comes from runtime state, not from the
contribution's description: a skill is instruction content, a non-operation
contribution is not callable, a disconnected or unprepared server tool is
unavailable or needs preparation, and policy-denied or open-schema tools stay
unavailable. Discovery itself never prepares, starts, installs or runs
anything. An executable native tool that is not yet disclosed is added to the
next provider request at the step boundary and to the gateway's disclosed set
at the same time, so it is refused within the step that found it and admitted
by its exact name afterwards. An attempt allows six discovery calls, eight
discovered tools and 6,000 estimated schema tokens. A handle from another
generation, or a call beyond the bound, returns an empty result naming the
refusal and the current handle. Preparing a lazy contribution on demand,
choosing tools before generic command execution and suggesting next operations
remain separately tracked.
The durable attempt-start record stays within one event (64 KiB). When it would
not fit, it trims, in order and keeping the highest-ranked entries, the plan's
rejected candidates (counted in `omittedRejected`), its fallbacks, its
degradation transitions, the omitted-tool list and the capability cards; every
other trimmed entry is counted in the record's `trimmed` field. Route identity,
selected candidates, disclosed tools and budgets are never trimmed, and trimming
changes only the stored record, not what the attempt sends. If the store still
refuses the start record, the attempt is not run: the turn fails with
`attempt start record could not be stored (<code>)` and no provider request.

Operation profiles (#946) group related native tools into one model-facing
definition. The Git tools form three: `git_inspect` (discover, status, diff,
log, blame, list worktrees), `git_branch` (create, switch and delete branches,
create and remove worktrees) and `git_change` (stage, unstage, commit, sync).
A profile replaces its members only when at least two of them are selected for
the attempt, and it offers only those operations; the receipt lists the rest
with the reason they were not offered, and an execution mode that denies
mutation never shows the mutating profiles. The model sends
`{"operation": "status", "status": {…}}`, with each operation's native
arguments under its own name; `operation` decides, and other operations'
properties in the call are ignored. Before binding, the call is lowered to the exact
native tool, so validation, effects, confirmation, admission, events and results
are the native tool's; the provider history keeps the call as the model made
it. The members stay disclosed under their native names, so a direct
`git_status` call still reaches the same single operation. A call naming an
operation the profile does not offer is refused as malformed before any
effect. Text shown to the model, such as fallback candidates, names a grouped
tool as its profile call, for example `git_inspect(status)`. The attempt's
disclosure receipt records each profile's operations with their native
identity and its whole-definition size beside what the same operations cost as
separate definitions; the durable attempt record keeps the native tools only.
Profiles for other tool families and GitHub operations are not implemented yet.

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
rejected, omitted, unavailable, and non-executable facts. Skills are routed before
inference by the instruction owner (see Skills). MCP/plugin execution, and scheduled background work still
belong to their dedicated runtimes; #193 exposes
the deterministic opportunity and truthful availability without claiming those
sibling executors.

The workspace write, mutation, discovery, search, and patch descriptors, all
fifteen `git_*` descriptors, and the explicit `memory_admit`/`memory_recall`
descriptors carry strict, bounded, closed input schemas, so each is eligible
for that selection. The per-attempt count and schema-token budgets still bound
the disclosed set, and rejected or unselected descriptors continue to carry
explicit omission receipts.

## Generation timing

Every provider request stream in a model attempt records its own timing. A
turn that calls a tool between two streams reports two entries, and tool
execution, focused confirmation, hooks and retry backoff fall between them. The
tap in `src/application/providers/generation-timing.ts` reads the clock as each
event leaves the adapter. That happens before history capture batches deltas
and before the stream consumer's queue can coalesce them, so neither changes a
recorded time or count.

The final fact holds time to first output, the span from first output to
terminal, output tokens with their source, a separate reasoning count when one
is known, and a rate. Provider-reported usage wins. Without it the count is an
estimate over received text, and without text it is `unknown`, never zero.
Spans under 250 ms or counts under 8 tokens report `insufficient-sample`. A
clock reading that goes backwards makes the rate `unavailable`. A stream that
ends without a normal finish, including a cancelled one, is `partial`.

The live rate uses a two-second trailing window, is always an estimate, and
updates at most four times per second. Each live turn executor keeps its own
activity, so a delegated child's stream never enters its parent's status or
totals. The TUI status line shows the running or last rate as a fixed-width
label such as `42 tok/s est. live`. It is the first text a narrow line drops.

Final facts persist as an optional versioned `generation` field on
`model.attempt.completed`. That event is now written with bounded settlement
after cancellation, so a cancelled attempt keeps its partial fact. `falryn run`
lists each entry in human and JSON output, JSONL carries the event, and
`falryn replay` and TUI transcript expansion show stored facts without a
provider call. Attempts recorded before this field existed show `unavailable`.
Export keeps parsed timing facts intact. Transcript streaming-block footers
(#740) and agent task-tree rows (#161) do not render the rate yet.

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
recalled before prompt composition. A turn no longer admits memory by itself:
records come only from the explicit `memory_admit` tool. Records admitted by the
earlier automatic task-text path stay as they were, source-attributed.

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
accepted memory remain separate. The persistence owner itself runs nothing; there
is no provider call, candidate review UI, or compaction consumer in this path.

Headless runs and terminal sessions compose a turn-end reflection worker over this
owner. After a turn's model attempt, terminal event and durable replay all report
completion, the turn result's `reflection` is `requested` and the worker is woken
with the committed stream head; otherwise it is `skipped`, or `unavailable` without
a durable store. Opening a session wakes it once for startup reconciliation. There
is no timer, polling loop, model call, tool, delegated agent or general task.

Each wake creates due requests (transform `turn-end-deterministic-v1`) for exactly
the events committed after the last requested range, in chunks of at most 256
events and 4 MiB, then processes at most eight due or expired-lease requests,
oldest first, and becomes idle. Startup reconciliation stops at the last completed
turn, so an unfinished turn is never requested. For each request the worker takes a
fenced lease, reads the committed events and checks each against the request's
recorded identity and digest, extracts, and publishes. Publication identities are
deterministic, so a retry after an interrupted acknowledgement finds the committed
publication instead of writing again, and a stale owner adds nothing.

Extraction reads only user messages recorded inline (up to 2 KiB) by turns whose
terminal outcome is completed, and capability failures in those turns. Sentences
outside fenced code that state a preference ("Prefer …", "Always …", "I prefer …"),
a correction ("No, …", "Actually …"), a decision ("We decided …"), a changed
assumption ("From now on …"), an unresolved task ("TODO …") or a noted fact
("Note that …") become pending `derived` candidates of the matching memory kind,
proposed for the workspace, each citing its source event. The same capability
failing twice in one range becomes one operational candidate. Repeats are
deduplicated and add no confidence; at most 32 candidates per request, with the
rest counted. Assistant, tool, repository and model text is never a source.
Messages kept as artifacts are published as `unavailable` ranges, not processed.
Candidates still need the existing review and admission; nothing is recalled until
then.

Shutdown is idempotent: it refuses new wakes, cancels extraction before the next
commit, releases an uncommitted lease by shortening it to one millisecond so the
work stays due, and waits at most two seconds. Receipts report `empty`,
`completed`, `partial`, `unavailable`, `failed`, `cancelled`, `stale` or
`uncertain` with counts and a code, never candidate or source text. The headless
run payload includes them as `reflectionReceipts`; the terminal does not display
them yet. Repository, branch and worktree are not part of the binding yet.

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
digest-verifiable bytes. The default CLI/TUI composition uses the MCP catalog as its
virtual-resource host (see MCP catalog, resources and prompts); it has no live
browser or notebook host and reports those targets unavailable. Binary,
extracted-document and sources above the source ceiling are unavailable in this
text route. Native structured Search has no qualified Hush projection adapter
and returns bounded structured facts with that reason. Heuristic outlines are
structural evidence, not exact edit preimages; see Evidence-bound text replacements.

## Evidence-bound text replacements

Live turns register `prepare_replacements` with `read` and `search`. One call takes a
version-1 `text-replacements` request: up to 8 `targets`, each an `evidenceRef` from
Read or Search and up to 32 exact `oldText`/`newText` `replacements`, plus up to 8
read-only `dependencies`. Every item has a unique `itemId`. Omitted `freshness`
(`exact-revision`), `replaceAll` (false) and `dependencies` normalize before strict
validation, but provider schemas require them explicitly. Preparation writes nothing.
It returns per-target facts, a native `patch` bound to the previewed bytes (with
`expectedPlanId` and each file's digest), and the native preview. The model applies
that `patch` unchanged with `apply_patch`.

Each reference is revalidated by the shared resource owner, so wrong-scope,
fabricated, expired, changed-policy and rebound references refuse with their own
codes. Only exact-fidelity workspace evidence is accepted, and one file may appear
only once. `exact-revision` refuses evidence that no longer describes the file.
`covered-ranges` accepts an unrelated change only when every covered byte range is
identical at its original offset; a shifted range needs fresh evidence. A
non-`replaceAll` `oldText` must occur exactly once inside the covered text, and
`replaceAll` needs evidence covering the whole file. Replacements address the same
original bytes and may not overlap. Line breaks in either text take the file's own
single style. Requests are limited to 32 native hunks of at most 256 lines.

Each refusal names its code, request item and one recovery (`read-again`,
`read-more`, `narrow-old-text`, `split-request`, `fix-request`, `use-write-files` or
`retry`). Every lowering is replayed through the native hunk applier and refused
unless the result is exactly the requested text. UTF-8 files keep their BOM, CRLF
or LF and final newline. Mixed newlines, other encodings, binary text and changes
the line model cannot express, such as removing a final line break, are refused.

Native patch plans accept optional read-only `dependencies` (path and expected
digest). Any change refuses preview and apply before a write
(`dependency-changed`), and a written file cannot also be a dependency. The native
patcher now refuses UTF-16 targets instead of re-encoding them and keeps a UTF-8
BOM. After a write, `apply_patch` returns `successors`: a fresh evidence reference
for each applied file's changed lines, or `changed-after-apply` or `unavailable`. A
failure to issue one never hides the write. Preflight is not an atomic multi-file
commit; the existing apply policy, per-file writes and rollback still apply.
Covered-range relocation, hashline addressing and Todo attachment are not provided.

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

Version 2 requests add named groups. A queue is a single-parent forest: groups
contain groups or tasks, tasks are leaves, and siblings are ordered by
store-owned keys addressed by `before`, `after` or `end`. Groups have no
criteria, claim, execution or acceptance, so they can't be claimed, run,
depended on or completed. Task operations and dependency edges refuse group IDs.
Placement is a separate relation from dependencies. Moving or renaming never
changes a claim, criteria, executor or frozen workflow selection. Maximum depth
is 32, with a root-level node at depth 1. A move that would form a cycle is
refused. Removing a group with live children is refused unless the same batch
moves them. Subtree removal needs the exact reviewed node set. Larger subtrees
use `removal-plan`, which returns explicit batches deepest-first; each committed
batch keeps its receipt.

`progress` counts each live descendant task once, never groups. It returns
accepted/total, a disposition partition that uses the pre-archive disposition
for archived tasks, a separate archived count, and `empty`, `in-progress` or
`all-completed`. `all-completed` requires at least one task, all accepted.
When `progress` reaches its traversal bound, it returns what it counted as
`partial` with a pre-order `next` cursor. Pages at one revision sum to the exact
counts, a changed revision refuses them as stale, and a partial page never
reports `empty` or `all-completed`. `node`, `ancestors`, `children` and
`subtree` queries also page at one revision.

Migration 0031 adds group and placement tables. An existing task with no
placement row is a root node ordered by its ID, which is the order flat lists
already had. No task record is rewritten, flat mutations keep writing version 1
receipts, and version 1 clients see tasks only. A mutation that creates or
changes a group or placement writes a version 2 receipt. That receipt binds the
group records, a digest of the placement rows at its revision, and up to 64
affected group IDs, with `complete` false beyond that. Edited group or placement
rows read as corruption. A live node under a missing parent is a recovery
condition, never silently reparented. An older build refuses the migrated
database as `schema-too-new`.

Committed mutations report `task-created` and `task-accepted` facts with stable
ID, revision and provenance. An optional observer receives them after the
storage transaction; its failure never changes the commit, and a replayed
receipt does not call it again. `prepareTaskListWorkflow` accepts `groups` and
expands them once at the queue's revision into a unique task manifest. Accepted,
including archived-completed, and cancelled, archived, blocked or unavailable
tasks are reported, never launched. The expansion revision, groups and
exclusions are frozen in the workflow selection. A changed queue is refused as
stale, and an empty, over-256 or over-limit graph selection is refused before
any launch with a recoverable handle. Command, model, TUI and scheduled
registration remain with their owners.

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


## Durable schedules

`falryn schedule` and the interactive `/schedule` control use the same durable
schedule actions. The model discovers `schedule` through the normal tool
registry and gateway. Definitions are data, disabled at creation. Enabling,
resuming, adopting an import, and triggering a manual occurrence require a
user control, including when the model has permission to prepare definitions.
Model mutations still pass the normal confirmation policy.

The host executes existing built-in actions and typed workflows through shared
capability admission, task resources, policy, hooks, provider bindings and
artifact capture. Workflows with model nodes require an available concrete
main model route. Missing targets or producers remain unavailable. Grouped Todo
Named-route and quota-reset scheduling remain a separate integration under #1113.

A definition may name up to 8 `skills` for its model steps to preload. Only a
`workflow` target with at least one `model` node accepts them; any other target
reports `schedule-skills-need-model-step`. Validation resolves each name with
automatic eligibility from source metadata, without reading a body, and the
binding captured at enable records the exact source and body digest. A name that
cannot resolve, including a manual-only skill, blocks the schedule as
`schedule-skill-unavailable:<reason>`. The host re-validates the binding before
each run and the scheduled gateway re-checks it as its authority, so a skill edited
after enable blocks the schedule as `authority-changed`, and one removed, disabled
or restricted blocks it as `schedule-skill-unavailable:<reason>`, before any body
read or provider call. Each model step then loads exactly the bound bodies; a change
that lands mid-run refuses that step as `skill-preload-stale`. Agent nodes load
their own definitions' skills, not the schedule's.

A `task-list` target selects existing Todo work by queue, scope generation and
stable group and task IDs (at most 256 of each), with `autoCascade` false by
default. Only a `project` or `shared` queue in the host workspace qualifies,
and only user-created schedules may target one. Preview and inspect return the
selector's current revision-bound manifest (task statuses with counts) and start
nothing. Session-bound, foreign or rescoped queues and missing groups are refused
before enable. Each occurrence expands the selector once at the queue's current
revision, freezes that manifest as a finalized artifact, and prepares the
task-list workflow at the same revision with the manifest as its evidence
source. A queue edited in between is refused as `task-list-selection-stale`
after at most three reads. The run uses the occurrence's attempt ID as its handle
generation. Overlapping groups deduplicate. Accepted, cancelled, claimed and
archived tasks never launch, and tasks added later join only later occurrences.
With nothing admissible, the occurrence settles `succeeded` with no effect and
reason `task-list-no-work`. Once every remaining node awaits acceptance, the
occurrence settles with reason `task-list-acceptance-required`: `succeeded`,
`partial` when a node failed or was skipped, or `uncertain`. Its result is the
frozen manifest, and per-task outcomes stay with the linked run and queue items.
Restart reconciles from the persisted run and never relaunches work. Accepting
tasks, and continuing a run after acceptance, belong to the task owner.

A live qualified Falryn host is required. Interactive sessions and live coding
runs compose this host; `falryn schedule host` runs it until interruption.
Control-only CLI commands do not run due work. There is no OS startup service
or execution while Falryn is closed. Linux and macOS provide process birth
identity for recovery. Windows currently supports inert controls but refuses
enable with `schedule-host-unavailable`; it does not infer ownership from a PID.

Create `schedule.json` with a command such as:

~~~json
{
  "operation": "create",
  "id": "inspect-workspace",
  "definition": {
    "version": 1,
    "timing": { "trigger": { "kind": "interval", "everyMs": 60000 } },
    "target": {
      "kind": "action",
      "capability": "builtin:workspace/stat_path@1",
      "input": { "path": "." }
    }
  }
}
~~~

Run `falryn schedule create --input schedule.json --format json`. A subsequent
command file containing `{"operation":"enable","id":"inspect-workspace",
"expectedRevision":1}` enables that exact revision. Use `inspect` to obtain the
current revision before later mutations. Routine wake progress does not change
that control revision. `list`, `history`, `preview`,
`validate`, `delete-preview`, `pause`, `resume`, `update`, `trigger-now`, `cancel`,
`delete`, `import` and `adopt` share this command-file format. `--format jsonl`
uses the normal result protocol. In the TUI, enter `/schedule` followed by the
same JSON, or use Schedule controls in the command palette for operation names.
Escape cancels the local control wait; exact attempt cancellation is separate.

Triggers accept an offset-qualified RFC 3339 `once.at`, an integer interval
of 1,000 through 31,536,000,000 ms, or five numeric calendar fields. Calendar
syntax supports `*`, comma, inclusive range and `/step`, Sunday `0`, and OR when
both day fields are restricted. Timezones are IANA identifiers, default UTC.
DST gaps record missed civil-time ranges; folds select the earlier instant.
Start is inclusive and end exclusive. Deterministic jitter only delays a slot,
by at most 900,000 ms and never into its successor.

Overlap defaults to `skip`; `queue-latest` retains one pending occurrence;
`parallel` accepts an explicit limit of 1 through 4. Missed-run policies are
`none`, `latest`, and oldest-first `bounded-all` with at most 32 catch-up runs.
Lookback defaults to 24 hours and caps at 30 days. The registered user/profile
key `execution.schedules` supplies version-1 defaults for newly prepared
schedules only. Selecting a profile never enables or rewrites definitions.

| Current state | Action | Result |
| --- | --- | --- |
| Disabled | Enable | Binds normalized intent and current authority, then enables |
| Enabled | Pause | Stops new admission; admitted work keeps its original identity |
| Paused | Resume | Revalidates the binding and applies missed-run policy |
| Disabled, enabled or paused | Update | Creates a disabled generation requiring explicit enable |
| Imported, disabled | Adopt | Creates a user-owned disabled generation |
| Enabled | Trigger-now | Deduplicates the request ID separately from recurrence |
| Any nondeleted definition | Delete | Tombstones it; preserves history and retained references |
| Admitted attempt | Cancel | Records request and acknowledgement separately from settlement |
| Stale revision or changed authority | Mutation or admission | Refuses it; inspect and explicitly update/re-enable |
| Corrupt executable record | Discovery | Quarantines that schedule and continues healthy work |
| Uncertain settlement or unavailable executor identity | Recovery | Pauses new admission; inspect before explicit resume |

Migration 30 separates definitions/generations, slots, occurrence claims,
attempts, retained artifacts and notification receipts. A unique nominal key
and transactional claim fence two hosts and clock rollback. Manual receipts,
terminal settlement and notices are independently deduplicated. Bounded pages
advance across retained catalogs, and old pending generations are superseded in
bounded batches. Execution keeps the existing 16-operation shared limit and
hierarchical task budgets. No attempt is automatically retried.

Each effect rechecks its current authority. Package schedules bind declarative
`kind: "schedule"` contributions with a `schedule` definition through the native
registration owner. Package code cannot supply timers. Install, catalog discovery
and publication are inert; update, disable, revocation and removal prevent old
bindings from admitting work. A replacement declaration gets a new disabled
identity and requires explicit activation. Imported definitions require adoption.

`inspect` and `list` show the next nominal/eligible time, current blocker and last
attempt; paginated history retains skipped, missed, coalesced and superseded
facts. Results keep artifact handles, workflow/task identities, partial effects,
and truthful uncertainty. Notifications carry metadata rather than target input.
The existing transcript projects `schedule.settled`; session export and replay
retain the event without starting another run. Deletion previews references and
keeps evidence needed for recovery. On shutdown, due admission stops first;
unsettled work becomes uncertain after a bounded wait, and late completion
cannot replace that terminal result.

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
In an interactive terminal session their questions are presented locally, as
described under Structured questions. Headless missing-presenter requests
return durable waiting receipts. Restart requires the original host question
capability to reconnect and answer.

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
its item waiting for native criteria validation.

Interactive sessions and `falryn run` compose one work-queue action owner for
root workflows. It routes each request to the location its queue record names
across `workspace-state`, `user-state` and `memory`; records naming different
locations for one ID are refused as `conflicting-identity`, and queue creation
or resume is not routed. Its authority acts as `local-user` for the host
session: it reads, claims and submits evidence but never creates queues or
accepts completion. Session-bound queues stay usable only from their own
session; project and shared queues are usable from any session in the
workspace. A claim is admitted only for a live task-list run in the workspace,
and is observed through the persisted run and its process task, so a restart
never relaunches work or resets a claim. Evidence sources must be finalized,
available artifacts whose digest matches the stated generation. The runtime's
`taskLists.prepare` turns an existing queue selection into a workflow
definition, deriving each agent node from the task's registered `agentType`
within that definition's capability and effect ceilings; unregistered,
unavailable or incompatible agents are refused before launch. The user-role
authority accepts completion only with `user` authority. Its command, queue
creation and the task-list UI remain with #949; scheduled selections use the
`task-list` schedule target. Configuration alone starts nothing.

A task-list run waiting for acceptance ends its process task, while the durable
run and claim stay waiting. A later `resume` drives the run after acceptance.

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
model answer tool, and goal adapter remain separate.

An interactive terminal session binds one local presenter principal
(`local-user` channel); headless and non-interactive hosts keep the
`headless-user` principal and bind no presenter. Workflow question nodes and MCP
form input requests both publish to that principal. The local presenter connects to
each question published for that principal in the session, holds at most 64 in
publication order, and shows one at a time in an OpenTUI question sheet. The
sheet shows the source, prompt, time left and how many more are waiting, and
renders single-select, multi-select with its bounds, free text with a live UTF-8
byte count, and review items. Over-limit text is refused whole. Return commits an
item, Ctrl+B goes back, Ctrl+R refuses, and Esc leaves the question waiting by
disconnecting the presenter; the palette's Show waiting questions reconnects the
oldest one. The sheet never covers another overlay, yields to confirmations, and
returns when they close. Answers, refusals, expiry, owner cancellation and
conflicting submissions settle only through the service; the presenter drops a
question once the service reports it settled and never supplies a default answer.
Protected questions are shown as unavailable and can only be refused or left.
Question text and answers are not written to logs or events by the presenter.
Presenter capabilities live only in the running process, so a question still
waiting after a restart is not shown again.

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
environment or trust scope is denied unless an exact route grant covers it.

Routes connect endpoints in different trusted worktrees that share this user's
peer registry. The recipient's user grants one direction to one exact sender
identity: `route-preview` shows the direction, both scopes, the
`expectedRevision` and that a reply needs its own reverse grant; then
`route-grant` takes that `expectedRevision`, optional `expiresInMs` (default one
hour, at most 24 hours) and `rights` (`discover`, `send`). Either end can
`route-revoke` with the current revision, naming `direction` (`incoming` or
`outgoing`) when routes exist both ways; `routes` pages both directions with
status `active`, `revoked`, `expired` or `invalid` and a reason such as
`route-endpoint-retired` or `route-scope-changed`. Grants are recipient-owned,
revisioned and bounded to 256 active grants per endpoint. They are never
inferred from a shared remote, clone, path, symlink or display name, and a fork
or new session identity has none. The sender still sends from its own scope.
Admission re-checks the exact grant revision the sender proved, so a revoke
between check and commit returns `stale` with `route-stale`. Revocation refuses
not-yet-admitted delivery and settles its waits; admitted receipts remain
intact. The recipient's `hold`/`deny` still applies. Cross-scope artifact
handles are refused and nothing is copied in their place. A trust change, retired
endpoint or scope change makes the route `invalid`. An identity outside this
registry, such as one using a separate state directory, returns `unsupported`
with `not-in-registry`. Only direct user controls can preview, grant or
revoke; model calls are denied without effect.

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

The normal SQLite store owns migrations 18 and 32 (route grants), fenced endpoint leases, admission,
attempts, acknowledgements, subscriptions, notification consumption and cursors.
UNIX sockets use private directories and mode 0600 entries; Windows uses local
named pipes. Fresh process signing/encryption keys authenticate nonce-bound
requests and opaque single-use operation capabilities. Private keys and tokens
are not persisted. Expired process claims require fresh authentication after
restart. Cross-machine transport and automatic collaboration turns are unavailable.
The separate follow-ups are #1082 for opted-in local turn admission, #1133 for
peers on separate state stores and #1084 for the remote transport and trust
decision. #161 owns their user controls. These issue links do not
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

A definition may name up to 8 `skills` to preload. The child resolves them at
admission in its own narrowed instruction scope, with automatic eligibility and
route reason `child-preload`, and receives their complete bodies before its first
provider request. It does no automatic skill routing. A manual-only, disabled,
untrusted, restricted, missing or ambiguous skill fails the child before any
provider request, tool call or body read, and the parent integrates that failure
with its reason (for example `selection-unavailable:deploy`).

Each launch supplies an objective through `inputJson`, selected context, exact
capability IDs, requested effects, resource limits and the existing version-1
foreground/background policy. Children use the ordinary provider/tool runtime,
the same workspace and shared resource admission. Explorer, Researcher, Planner
and Reviewer have an observation-only ceiling. General and Implementer can
narrow the parent's effects and explicitly admit nested delegation. Consequential
operations still require the normal confirmation host; the existing lack of a
production confirmation presenter remains a limitation.

A write-capable launch may supply `editScope`: up to 64 workspace-relative path
prefixes or single-segment globs (`*`, `?`), each at most 1 KiB. Patterns are
normalized; `..`, absolute and other glob syntax are refused as
`edit-scope-invalid`, including any scope on an observation-only definition.
Without a scope a writer may write its whole inherited workspace, and a nested
child stays inside its parent's scope (`edit-scope-outside-parent`). Writers
reserve their scope durably (migration 0033) in one transaction before any
resource is admitted. A scope that overlaps a running writer in the workspace, where
two globs that might intersect count as overlapping and an unscoped writer overlaps
every writer, returns `agent-launch-refused` with reason `edit-scope-overlap`
and that child's handle. The launch is not queued. A reservation ends when the
child's task ends with a known effect. An uncertain effect keeps it until
`cleanup`, including across restart. An admission that never linked its task
expires after 60 seconds. Continuation reserves the same scope again, and
`inspect` of a retained child reports it.

A scoped child's workspace mutations are checked before resource admission, on
every admitted input including a hook's rewrite. `write_files`, `mutate_paths`
and `apply_patch` must name only paths inside the scope. One outside path refuses
the whole call (`edit-scope-violation`), and a move across the boundary is
`edit-scope-boundary`; neither has any effect. `run_process` and `run_shell`
are available to a scoped child only under a strict sandbox with directory-only
scopes. Existing scope directories become the only command write roots, and a
`sandboxExpansion` outside them is refused. Any other capability that can write
anywhere, such as PTY, Git mutation or language edits, makes the launch return
`agent-launch-refused` with reason `edit-scope-unenforceable` naming those
capabilities. Reads are not restricted.

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
The wait continues through child settlements until the join is decided, the
time expires, or a wait settles no child, so one settled child of several does
not end it early.

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
Observers belong to their session, not their subject's turn. Before a session's
stores close, its observers settle: a headless run that ends on its own waits for
each admitted observer inside the deadline reserved when it was admitted, while a
stopped run and a closed terminal session cancel them. Either way each observer
leaves exactly one final receipt and nothing of the session runs afterwards. Work an
observer asks for through the gateway, such as an MCP tool hook's call, is accounted
to the observer's own retained task.

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
usage and effect uncertainty; the HTTP and MCP tool adapters produce remote receipts,
while model adapters remain unavailable. Queue and
overflow receipts retain the captured binding. Failure receipts become transcript
notices, including passive replay/export, and so does each async observer's
completion (`Hook <hook> observed <invocation>: <decision>`), once, after its
queued receipt. Audit or health-store failure refuses
required gates; after native settlement, persistence failure remains visible
without re-executing the subject or changing its recorded observed effect.

Package preparation rejects unknown hook points, versions, fields and invalid
handler/mode combinations. External entrypoints require inventory digest locks.
`falryn extension inspect <directory> --format json` reports the declared point,
handler and availability; human output reports the same unavailable reason.
Inspection neither activates handlers nor exposes arguments or credentials.
The handler union includes built-in, command, HTTP, MCP and evaluator declarations.
Built-ins and explicitly installed/trusted/native-activated Python, HTTP, MCP tool and
evaluator package hooks execute at the two gateway points. Other publishers remain
unavailable. One scheduler applies the declared class budgets: local
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

An `http-v1` hook declares an exact HTTPS URL, `nonlocalOptIn`, `authority.effects`
with `external` (optionally `observation`) and, when it names a
`credentialReference`, only that name in `secretReferences`; it has no execution and
no other authority. It runs no package code, so it needs no Python or sandbox host.
Each invocation rechecks the installed package and activation, then sends one POST
of the shared hook input document (at most 64 KiB) to exactly the granted URL, with
the granted credential as a bearer token resolved for that contribution alone.
Every resolved address must be publicly routable: loopback, private, link-local,
shared, documentation, multicast and reserved space, and IPv6 forms embedding such
IPv4 addresses, fail as `hook-destination-private`, including when mixed with public
answers. The connection is pinned to the checked address while TLS verifies the
hostname, so a later rebinding cannot redirect it. Redirects fail as
`hook-redirect-refused`, other non-2xx statuses as `hook-http-status`, and 204, empty,
malformed, trailing, wrong-invocation and over-16-KiB responses as
`invalid-hook-response` or `hook-response-too-large`. The decision is decoded by the
same codec and native revalidation as command hooks; success is never consent.
Receipts keep transport, status, HTTP status, response validity, omitted bytes and
an unknown effect once sent, never headers, bodies or credentials. Cancellation,
timeout and disconnect after sending are never retried. Async HTTP observers enter
the same bounded queue and settle with their session. `src/domain/extensions/hook-fixtures.ts` has an example
declaration.

An `mcp-tool-v1` hook names a configured MCP `serverId`, the exact `toolId` (the
tool name, never its title), the `schemaDigest` of the normalized input schema its
mapping was written against (the `schemaDigest` that `mcp_catalog` reports for one
entry), the structured `outputField` holding the decision, and up to 16 `arguments`
mappings of `{ name, from }`. `from` is `binding` (the decision binding a veto or
transform must echo), an envelope header field such as `subjectId`, or
`payload.<field>` of the hook's point; anything else, or a repeated name, is refused
at preparation. Its authority is `external` (optionally `observation`) with no
secret references, since the configured server owns authentication; like HTTP it runs
no package code. It binds only in a session that composes MCP (headless runs and the
terminal), so `falryn extension catalog` lists it as `hook-mcp-session-required`.
Each invocation goes through the enclosing gateway as hook-origin work: an
unconnected server is connected with `mcp_connect`, then the tool is called once with
`mcp_call_tool`, each with ordinary policy, focused confirmation, resources and
history receipts. Hook-origin work is recorded one recursion level deep with origin
`hook`; the point that asked is recorded as `reentry-suppressed` rather than run
again, and hook-origin work cannot itself start more (`hook-recursion-denied`).
Only the declared field of an object structured result is decoded, by the same
codec and revalidation as the other handlers. Prose and every other field are
ignored; a missing field fails as `hook-mcp-output-missing`, `isError` as
`hook-mcp-tool-error`, a different schema digest or a catalog generation that
changed during the call as `hook-mcp-schema-changed`, a refused call or
confirmation as `hook-mcp-call-refused`, and an uncertain result such as a disconnect
after sending as `hook-mcp-effect-uncertain`. Nothing is retried. Receipts carry
transport `mcp`, the catalog generation called, response validity, result size and
the effect certainty, never result content; the call's own ordinary history keeps its
exact result.

A `prompt-evaluator-v1` or `agent-evaluator-v1` hook asks a model for a verdict. It
declares a `bindingId` naming the model it needs, package-relative UTF-8
`instructions` (at most 16 KiB, used verbatim with no interpolation), and up to 16
`evidence` mappings of `{ name, from }` with the same sources as MCP arguments; an
agent evaluator also lists 1–8 `readTools` by exact tool name. Like the other remote
hooks it declares `external` (optionally `observation`), no secret references,
execution or other authority, and `nonlocalOptIn`. Sync evaluators are accepted only
at `user.submit`, `user.prompt.expand`, `before-capability-invocation` and
`model.switch.before`; `turn.complete`, `task.complete`, `workflow.complete`,
`subagent.stop` and other observation points accept only async evaluators; shutdown,
idle, job-stop and display points reject them. Only the two gateway points have a
publisher today. `src/domain/extensions/hook-fixtures.ts` has an example declaration.

Installing a package or matching an event admits no model and no spending. `falryn
package enable` lists each evaluator's `requirements` as `{ contribution, binding }`;
its `grants` entry repeats them and adds `model` with the exact `providerProfileId`,
`providerId` and `modelId`. A different binding fails as `hook-grant-binding-mismatch`.
Each evaluation resolves that profile with current credentials through the session's
own provider connections; a missing profile or model is `hook-model-unavailable` and a
model whose catalog does not report structured output support is
`hook-model-unsupported`. There is no role inheritance, alias, fallback model or
premium processing. Evaluators bind only in headless and terminal sessions, so
`falryn extension catalog` lists them as `hook-evaluator-session-required`.

The evaluation is one owned child on the hook's own resource task, so it shares the
triggering task's budgets, run by the ordinary live-turn executor with no workspace
instructions, memory, hooks or confirmation. Its input is the package instructions,
Falryn's protocol text and one canonical JSON document of the point and declared
evidence, sent as untrusted user content. Each request asks for a strict JSON-schema
verdict (`verdict` allow or deny, a `reason` of at most 120 characters, and at a sync
point that accepts context evidence, up to eight `evidence` notes) with at most
8,192 input and 1,024 output tokens. A prompt evaluator makes one request with no
tools. An agent evaluator makes at most four requests and eight reads; each declared
tool must be natively observation-only with no input-dependent effect or workspace
writes (otherwise `hook-evaluator-tool-refused` before any request), only those tools
are offered, and each call goes through the child's ordinary gateway. A suggestion
outside them fails the evaluation as `hook-evaluator-tool-refused`, and using the
whole request allowance without a verdict as `hook-evaluator-limit`.

Exactly the complete response is decoded; prose, fences, extra, missing or invalid
fields are `hook-evaluator-output-invalid`, partial output is
`hook-evaluator-incomplete`, and provider limits or quota are `hook-evaluator-limit`.
Nothing is retried or repaired. A deny vetoes only a sync gate it is still holding;
an allow, or any verdict from an async observer, becomes an observation annotated with
the verdict and reason. The shared codec then revalidates the decision, so an
evaluator never transforms input or requests effects. Stops, shutdown, recovery and
evaluator-origin events never start one (`hook-evaluator-ineligible`). Receipts use
handler facts of kind `model`: status, response validity, requests, reads, reported
input and output tokens, the requested and resolved model and `actualModel` (null,
since providers do not report the served model), and whether evidence left the
process. The facts never include the verdict text or evidence. Cancellation or timeout
before dispatch spends nothing; after dispatch the observed usage is kept and the
request is not replayed. Deterministic journeys cover the protocol; there is no
recorded evidence yet of verdict quality, false positive or negative rates, latency
or cost with a real model.

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
and schedule paths described above, no goal/loop or automatic work-item runner
is product-composed. Opportunity records do not automatically
launch those runtimes. Their existing owners include GitHub issues #155–#162,
#797 and #897. Extensions, MCP servers, package contributions, skills,
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
