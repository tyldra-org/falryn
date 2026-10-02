/**
 * Application owners of the built-in actions that headless and model callers
 * may run (#948). Each reads the session owner the shell already uses; the
 * caller supplies the ports its host has, and an absent port is reported as
 * unavailable rather than guessed.
 */

import { parseSkillsCommand } from "../../domain/context/skill-invocation.ts";
import type { CommandActionHandlers } from "./command-actions.ts";

export type BuiltinCommandActionPorts = {
  /** Human lines for one page of the session's skill catalog; never reads a skill body. */
  readonly listSkills?: (
    page: { readonly filter: string | null; readonly offset: number },
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
  /** Human lines for this session's verified package suggestions (#1094). */
  readonly listSuggestions?: (signal: AbortSignal) => Promise<readonly string[]>;
};

/** The built-in action owners, reading the host's ports at call time. */
export function builtinCommandActions(
  ports: () => BuiltinCommandActionPorts,
): CommandActionHandlers {
  return {
    "skills.list": async (invocation, signal) => {
      const list = ports().listSkills;
      if (list === undefined)
        return { kind: "unavailable", message: "Skills are unavailable in this session." };
      const page = parseSkillsCommand(
        invocation.argument === null ? "/skills" : `/skills ${invocation.argument}`,
      ) ?? { filter: null, offset: 0 };
      return { kind: "completed", lines: await list(page, signal) };
    },
    "extensions.suggestions": async (_invocation, signal) => {
      const list = ports().listSuggestions;
      if (list === undefined)
        return {
          kind: "unavailable",
          message: "Package suggestions are unavailable in this session.",
        };
      return { kind: "completed", lines: await list(signal) };
    },
  };
}
