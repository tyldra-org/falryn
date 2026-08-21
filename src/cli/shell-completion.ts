/**
 * Shell completion generated from the same declared tree as parsing and help.
 *
 * Runtime completion answers `--get-yargs-completions` from a walker over the
 * shipped command vocabulary rather than yargs' `getCompletion`, which hangs once
 * `exitProcess(false)` is set. Install scripts for bash, zsh, and fish wrap that
 * flag; fish has no upstream yargs template, so its wrapper lives here.
 */

import { SESSION_CATALOG_FILTERS } from "../domain/index.ts";
import { SCRIPT_NAME, SESSION_REPLAY_ACTIONS } from "./command-tree.ts";
import { COLOR_CHOICES, OUTPUT_FORMATS } from "./options.ts";

/** Shells `falryn completion` can emit an install script for. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/**
 * Top-level command groups declared in the shipped tree.
 *
 * Kept as data so tests can assert completion never advertises planned groups.
 */
export const DECLARED_TOP_LEVEL_GROUPS = [
  "config",
  "data",
  "doctor",
  "run",
  "export",
  "import",
  "replay",
  "task",
  "session",
  "artifact",
  "workspace",
  "completion",
] as const;

/** Groups named in docs but intentionally absent from the shipped tree. */
export const UNDECLARED_GROUPS = ["provider", "tool", "extension", "update", "uninstall"] as const;

const COMPLETION_FLAG = "--get-yargs-completions";

const GLOBAL_OPTIONS = [
  "--format",
  "--color",
  "--no-color",
  "--quiet",
  "-q",
  "--verbose",
  "-v",
  "--non-interactive",
  "--workspace",
  "--add-dir",
  "--profile",
  "--timeout",
  "--help",
  "-h",
  "--version",
] as const;

const GROUP_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  config: ["show", "validate", "path", "set"],
  data: ["reset", "uninstall", "backup", "restore", "inspect", "diagnostics", "retention", "gc"],
  task: ["decompose", "validate", "progress", "commit-plan"],
  session: ["list", "show", "resume", "fork", "rewind", "replay"],
  artifact: ["list", "show", "get"],
  workspace: ["list", "show", "save", "load"],
  completion: [...COMPLETION_SHELLS],
};

const GROUP_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  config: ["--file-scope", "--revision"],
  data: ["--class", "--confirm", "--pinned-session"],
  run: ["--brief"],
  export: ["--session", "--after", "--before", "--include-sensitive", "--name", "--write"],
  task: [
    "--statement",
    "--outcome-id",
    "--task-id",
    "--scope",
    "--cwd",
    "--confirm",
    "--goal",
    "--non-goal",
    "--proposed",
    "--task",
    "--depends",
    "--observe",
    "--blocker",
    "--criterion",
    "--input",
  ],
  session: [
    "--filter",
    "--search",
    "--limit",
    "--workspace-id",
    "--after-sequence",
    "--schema-generation",
    "--at-turn",
    "--new-session-id",
    "--new-stream-id",
    "--replay-action",
    "--seek-sequence",
  ],
  artifact: ["--limit", "--output"],
  workspace: ["--limit", "--force"],
};

const OPTION_CHOICES: Readonly<Record<string, readonly string[]>> = {
  "--format": OUTPUT_FORMATS,
  "--color": COLOR_CHOICES,
  "--brief": ["compact", "balanced", "detailed", "auto"],
  "--file-scope": ["user", "project", "profile"],
  "--filter": SESSION_CATALOG_FILTERS,
  "--replay-action": SESSION_REPLAY_ACTIONS,
};

const VALUE_OPTIONS = new Set([
  "--format",
  "--color",
  "--workspace",
  "--add-dir",
  "--profile",
  "--timeout",
  "--file-scope",
  "--revision",
  "--class",
  "--confirm",
  "--pinned-session",
  "--session",
  "--after",
  "--before",
  "--name",
  "--statement",
  "--outcome-id",
  "--task-id",
  "--scope",
  "--cwd",
  "--goal",
  "--non-goal",
  "--proposed",
  "--task",
  "--depends",
  "--observe",
  "--blocker",
  "--criterion",
  "--input",
  "--filter",
  "--search",
  "--limit",
  "--workspace-id",
  "--after-sequence",
  "--schema-generation",
  "--at-turn",
  "--new-session-id",
  "--new-stream-id",
  "--replay-action",
  "--seek-sequence",
  "--output",
  "--brief",
]);

const bashTemplate = `###-begin-{{app_name}}-completions-###
#
# Falryn shell completion (bash)
#
# Installation: eval "$({{app_path}} completion bash)"
#    or {{app_path}} completion bash >> ~/.bashrc
#
_{{app_name}}_yargs_completions()
{
    local cur_word args type_list

    cur_word="\${COMP_WORDS[COMP_CWORD]}"
    args=("\${COMP_WORDS[@]}")

    mapfile -t type_list < <({{app_path}} ${COMPLETION_FLAG} "\${args[@]}")
    mapfile -t COMPREPLY < <(compgen -W "$( printf '%q ' "\${type_list[@]}" )" -- "\${cur_word}" |
        awk '/ / { print "\\""$0"\\"" } /^[^ ]+$/ { print $0 }')

    if [ \${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi

    return 0
}
complete -o bashdefault -o default -F _{{app_name}}_yargs_completions {{app_name}}
###-end-{{app_name}}-completions-###
`;

const zshTemplate = `#compdef {{app_name}}
###-begin-{{app_name}}-completions-###
#
# Falryn shell completion (zsh)
#
# Installation: eval "$({{app_path}} completion zsh)"
#    or {{app_path}} completion zsh >> ~/.zshrc
#
_{{app_name}}_yargs_completions()
{
  local reply
  local si=$IFS
  IFS=$'\n' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" {{app_path}} ${COMPLETION_FLAG} "\${words[@]}"))
  IFS=$si
  if [[ \${#reply} -gt 0 ]]; then
    _describe 'values' reply
  else
    _default
  fi
}
if [[ "\${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _{{app_name}}_yargs_completions "$@"
else
  compdef _{{app_name}}_yargs_completions {{app_name}}
fi
###-end-{{app_name}}-completions-###
`;

const fishTemplate = `# Falryn shell completion (fish)
#
# Installation: {{app_path}} completion fish | source
#    or {{app_path}} completion fish >> ~/.config/fish/completions/falryn.fish
#
complete -c {{app_name}} -f -a '({{app_path}} ${COMPLETION_FLAG} (commandline -cp))'
`;

type CommandContext = {
  readonly group: string | null;
  readonly action: string | null;
};

/** Whether argv is a runtime completion request. */
export function isCompletionRequest(argv: readonly string[]): boolean {
  return argv.includes(COMPLETION_FLAG);
}

/** The words after \`--get-yargs-completions\`. */
export function completionRequestArgs(argv: readonly string[]): readonly string[] {
  const index = argv.indexOf(COMPLETION_FLAG);
  return index === -1 ? [] : argv.slice(index + 1);
}

/** Candidates derived from the declared tree for one partial invocation. */
export function getCompletionCandidates(args: readonly string[]): readonly string[] {
  const normalized = normalizeCompletionArgs(args);
  const current = normalized.at(-1) ?? "";
  const prior = normalized.slice(0, -1);
  const context = parseCommandContext(prior);

  const previous = prior.at(-1);
  if (previous?.startsWith("-")) {
    const choices = OPTION_CHOICES[previous];
    if (choices !== undefined) {
      return filterByPrefix(choices, current);
    }
  }

  if (current.startsWith("-") || (current === "" && looksLikeOptionCompletion(prior))) {
    return filterByPrefix(optionsForContext(context), current);
  }

  if (context.group === null) {
    return filterByPrefix(DECLARED_TOP_LEVEL_GROUPS, current);
  }

  const actions = GROUP_ACTIONS[context.group];
  if (actions !== undefined && context.action === null) {
    return filterByPrefix(actions, current);
  }

  return filterByPrefix(optionsForContext(context), current);
}

/** One installable completion script for the named shell. */
export function completionInstallScript(
  shell: CompletionShell,
  appPath: string = SCRIPT_NAME,
): string {
  const name = appPath.includes("/") ? appPath.slice(appPath.lastIndexOf("/") + 1) : appPath;
  const template = shell === "bash" ? bashTemplate : shell === "zsh" ? zshTemplate : fishTemplate;
  return template.replaceAll("{{app_name}}", name).replaceAll("{{app_path}}", appPath);
}

function normalizeCompletionArgs(args: readonly string[]): readonly string[] {
  const [first, ...rest] = args;
  if (first === SCRIPT_NAME) {
    return rest;
  }
  return args;
}

function parseCommandContext(tokens: readonly string[]): CommandContext {
  let group: string | null = null;
  let action: string | null = null;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token.startsWith("-")) {
      index += VALUE_OPTIONS.has(token) ? 2 : 1;
      continue;
    }
    if (group === null) {
      group = token;
      index += 1;
      continue;
    }
    const actions = GROUP_ACTIONS[group];
    if (action === null && actions !== undefined && actions.includes(token)) {
      action = token;
      index += 1;
      continue;
    }
    index += 1;
  }

  return { group, action };
}

function optionsForContext(context: CommandContext): readonly string[] {
  const options: string[] = [...GLOBAL_OPTIONS];
  if (context.group !== null) {
    const groupOptions = GROUP_OPTIONS[context.group];
    if (groupOptions !== undefined) {
      options.push(...groupOptions);
    }
  }
  return options;
}

function looksLikeOptionCompletion(tokens: readonly string[]): boolean {
  const last = tokens.at(-1);
  return last?.startsWith("-") ?? false;
}

function filterByPrefix(candidates: readonly string[], prefix: string): readonly string[] {
  if (prefix === "") {
    return candidates;
  }
  return candidates.filter((candidate) => candidate.startsWith(prefix));
}
