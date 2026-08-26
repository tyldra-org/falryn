/** Command-aware operation formatting with exact fallback on unknown shapes. */

import { shortestText } from "../../text-format.ts";
import { formatContainerOperationOutput } from "../container/operation.ts";
import { CONTAINER_EXECUTABLES, containerExecutable } from "../container/shared.ts";
import { formatOperationCommand } from "./commands.ts";
import { formatPrismaOperation } from "./prisma.ts";

export function formatOperationOutput(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const formatted =
    (CONTAINER_EXECUTABLES.has(containerExecutable(commandTokens))
      ? formatContainerOperationOutput(text, commandTokens)
      : null) ??
    (commandTokens[0] === "prisma" ? formatPrismaOperation(text, commandTokens) : null) ??
    formatOperationCommand(text, commandTokens);
  return formatted === null ? null : shortestText(text, formatted);
}
