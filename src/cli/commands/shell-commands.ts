/**
 * `falryn commands`: the interactive shell's command reference (#790).
 *
 * Generated from the same registry generation the shell parses slash text and
 * builds its palette from, so this list cannot drift from what the shell runs.
 * It reads no configuration, storage or provider, and loads no terminal UI.
 */

import { type CommandReference, commandReference } from "../../domain/commands/index.ts";
import { SHELL_REGISTRY } from "../../tui/commands/registry.ts";
import type { CommandResultOf } from "../output/result.ts";
import { resultFor } from "./shared.ts";

export function runShellCommands(): CommandResultOf<"commands", CommandReference> {
  return resultFor(
    "commands",
    commandReference(SHELL_REGISTRY, (entry) => entry.defaultBinding),
    [],
  );
}
