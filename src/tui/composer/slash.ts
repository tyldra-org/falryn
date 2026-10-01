/**
 * Composer slash text, resolved through the command registry (#790).
 *
 * There is no slash table here. `/mode plan`, `/workspace add`, `/schedule {…}`
 * and every other built-in are forms of registry entries, parsed by the one
 * grammar in `domain/commands`. Text no entry claims is left alone, so skill and
 * prompt-template commands still reach their owners after the built-ins.
 *
 * Pure. No renderer, no shell state.
 */

import { parseSlashCommand, type SlashParse } from "../../domain/commands/index.ts";
import type { ShellCommand } from "../commands/contracts.ts";
import { SHELL_REGISTRY } from "../commands/registry.ts";

export type ParsedComposerSlash = SlashParse<ShellCommand>;

/** Parse composer text against the built-in registry generation. */
export function parseComposerSlash(text: string): ParsedComposerSlash {
  return parseSlashCommand(SHELL_REGISTRY, text);
}

/**
 * Whether a built-in command owns this slash text, including text it refuses.
 * Built-ins always win over skills and package prompt templates in every
 * interface.
 */
export function isBuiltinComposerSlash(text: string): boolean {
  const parsed = parseComposerSlash(text);
  return parsed.kind === "command" || parsed.kind === "invalid";
}
