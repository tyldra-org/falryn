/** Command routing and root/config/run argument normalization. */

import type { CodingRunArguments } from "../coding-run.ts";

import type {
  CompletionCommandArguments,
  ConfigSetArguments,
  RawArguments,
  RunnableCommand,
} from "./contracts.ts";

export function commandFrom(
  positional: readonly string[],
  action: string | null,
  shell: string | undefined,
): RunnableCommand | null {
  const [group] = positional;
  if (group === undefined) {
    // The no-argument invocation. `src/cli/dispatch.ts` decides from observed
    // facts whether it opens the shell or falls back to help, and this module
    // does not know the difference — parsing names the command, nothing more.
    return "default";
  }
  if (group === "doctor") {
    return action === null ? "doctor" : null;
  }
  if (group === "completion") {
    if (action !== null) {
      return null;
    }
    if (shell === "bash" || shell === "zsh" || shell === "fish") {
      return "completion";
    }
    return null;
  }
  if (group === "run") {
    // Remaining positionals are the prompt; there is no nested action.
    return "run";
  }
  if (group === "provider") {
    return action === null ? null : "provider";
  }
  if (group === "export") {
    return action === null ? "export" : null;
  }
  if (group === "import") {
    return action === null ? "import" : null;
  }
  if (group === "replay") {
    return action === null ? "replay" : null;
  }
  if (group === "task") {
    switch (action) {
      case "decompose":
        return "task.decompose";
      case "validate":
        return "task.validate";
      case "progress":
        return "task.progress";
      case "commit-plan":
        return "task.commit-plan";
      default:
        return null;
    }
  }
  if (group === "config") {
    switch (action) {
      case "show":
        return "config.show";
      case "validate":
        return "config.validate";
      case "path":
        return "config.path";
      case "set":
        return "config.set";
      default:
        return null;
    }
  }
  if (group === "data") {
    switch (action) {
      case "reset":
        return "data.reset";
      case "uninstall":
        return "data.uninstall";
      case "backup":
        return "data.backup";
      case "restore":
        return "data.restore";
      case "inspect":
        return "data.inspect";
      case "diagnostics":
        return "data.diagnostics";
      case "retention":
        return "data.retention";
      case "gc":
        return "data.gc";
      default:
        return null;
    }
  }
  if (group === "session") {
    switch (action) {
      case "list":
        return "session.list";
      case "show":
        return "session.show";
      case "resume":
        return "session.resume";
      case "fork":
        return "session.fork";
      case "rewind":
        return "session.rewind";
      case "replay":
        return "session.replay";
      default:
        return null;
    }
  }
  if (group === "artifact") {
    switch (action) {
      case "list":
        return "artifact.list";
      case "show":
        return "artifact.show";
      case "get":
        return "artifact.get";
      default:
        return null;
    }
  }
  if (group === "workspace") {
    switch (action) {
      case "list":
        return "workspace.list";
      case "show":
        return "workspace.show";
      case "save":
        return "workspace.save";
      case "load":
        return "workspace.load";
      default:
        return null;
    }
  }
  return null;
}

export function completionArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): CompletionCommandArguments | null | string {
  if (command !== "completion") {
    return null;
  }
  if (parsed.shell === undefined) {
    return "Argument shell is required for completion; choose bash, zsh, or fish.";
  }
  if (parsed.shell !== "bash" && parsed.shell !== "zsh" && parsed.shell !== "fish") {
    return `Argument shell: "${parsed.shell}" is not valid.`;
  }
  if (parsed.name !== undefined) {
    return "Argument name is only valid with data backup, restore, inspect, or workspace save/load.";
  }
  return { shell: parsed.shell };
}

export function configSetArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ConfigSetArguments | null | string {
  if (command !== "config.set") {
    return null;
  }
  if (parsed.key === undefined || parsed.value === undefined) {
    return "Arguments key and value are required for config set.";
  }
  if (parsed.name !== undefined) {
    return "Argument name is only valid with data backup, restore, inspect, or workspace save/load.";
  }
  if (parsed.limit !== undefined) {
    return "Argument limit is only valid with workspace list.";
  }
  if (parsed.force === true) {
    return "Argument force is only valid with workspace save.";
  }
  const scope = parsed["file-scope"] ?? "user";
  if (scope !== "user" && scope !== "project" && scope !== "profile") {
    return `Argument file-scope: "${scope}" is not valid.`;
  }
  if (parsed.revision !== undefined && parsed.revision.length === 0) {
    return "Argument revision must not be empty.";
  }
  return {
    keyPath: parsed.key,
    rawValue: parsed.value,
    scope,
    expectedRevision: parsed.revision ?? null,
  };
}

export function runArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): CodingRunArguments | null {
  if (command !== "run") {
    return null;
  }
  // yargs puts `run [prompt..]` into `prompt`, not into `_`.
  const brief = parsed.brief;
  if (brief !== undefined) {
    return {
      promptParts: parsed.prompt ?? [],
      brief: brief as "compact" | "balanced" | "detailed" | "auto",
    };
  }
  return { promptParts: parsed.prompt ?? [] };
}
