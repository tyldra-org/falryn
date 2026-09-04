# CLI runtime and automation

Make `gh` behavior explicit before relying on it in a script or consequential workflow. The installed binary, authenticated host, server capabilities, environment, aliases, extensions, and output mode can all change the result.

## Resolve the executable and version

```bash
command -v gh
gh version
gh <command> <subcommand> --help
```

If output suggests a wrapper or alias, inspect how the shell resolves `gh` before assuming the official binary received the arguments. Do not upgrade or replace the CLI unless the user asked. If a required flag is absent, use a current official API fallback with equivalent semantics or report the blocker.

Preview and experimental commands can change or disappear. Check their current help, host support, data destination, and side effects on every use.

## Bind host and repository

For scripts, pass an explicit `[HOST/]OWNER/REPO` through `--repo` where supported. `GH_REPO` is acceptable when one reviewed environment owns the whole script. Do not let a stale environment variable or current directory silently select another repository.

Use `GH_HOST` only when a command cannot accept or infer the host. Some subcommands expose their own `--hostname`; check help. Resolve the authenticated account for that host separately.

The per-host `api_host` configuration can route API traffic through a gateway without changing the original authentication, Git remote, or browser host. It is experimental and is not a security boundary. Read [context-and-auth.md](context-and-auth.md) before changing it.

## Non-interactive execution

Supply every required target and payload. Disable prompts for a bounded script rather than risking an unattended default:

```bash
GH_PROMPT_DISABLED=1 GH_PAGER=cat NO_COLOR=1 \
  gh <command> ...
```

Set these only for the process that needs them. Prompt suppression does not authorize `--yes`, `--confirm`, `--admin`, deletion, publication, merge, or another consequential default. A command that needs a decision should stop.

Use a body or JSON file for multiline input. Keep secrets out of arguments, files, debug logs, and generated output. Do not enable `GH_DEBUG=api` around sensitive bodies or credentials; HTTP diagnostics can expose request and response data even when authentication headers are redacted.

## Machine-readable output

Prefer documented structured output:

```bash
gh <command> ... --json fieldA,fieldB --jq '<expression>'
gh api <endpoint> --jq '<expression>'
```

Ask a command for its available fields by invoking `--json` without a field list. Request only fields required by the decision. Relative times, color, tables, terminal hyperlinks, wrapped Markdown, and human summaries are display formats, not stable script interfaces.

`--template` uses Go templates and command-specific functions. Keep templates in a reviewed file or single-quoted literal when complex. Do not interpolate untrusted issue, PR, branch, or repository text into shell code.

## Exit status and partial success

The general exit codes are:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | failure |
| 2 | command canceled |
| 4 | authentication required |

Individual commands can define more. Read their help when status controls a workflow. Never treat nonempty stdout as success without the exit status.

Some commands make several API calls. Attachments, release assets, and bulk edits can partly apply and still exit nonzero. Re-read remote state before retrying. Repeating a create command after an uncertain result can duplicate records.

## Configuration

Inspect before changing:

```bash
gh config list --host <host>
gh alias list
gh extension list
```

Use per-host configuration for host-specific protocol or API routing. A global config change affects unrelated repositories and tasks. Verify the stored value and a harmless read after any change.

Shell aliases created with `gh alias set --shell` execute shell code. Treat their body as a script and never feed them untrusted content. For durable automation, prefer explicit native commands over user aliases.

Extensions are executable code and receive the caller's environment and GitHub authority. Inspect repository ownership, source, release assets, checksums or attestations, requested permissions, and installed version. Pin a reviewed version when reproducibility matters. Installation, upgrade, and removal require explicit user direction.

## Completion evidence

Record binary version, host, account, repository, exact selectors, exit status, and stable IDs or URLs. For mutations, independently read the target after the command. CLI success proves only that the command completed, not that downstream Actions, deployments, webhooks, or external systems succeeded.
