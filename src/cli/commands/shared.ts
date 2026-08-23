/** Shared command result construction and effect declarations. */

import { adoptForeignError } from "../../application/index.ts";
import type { FalrynError, TerminalOutcome } from "../../domain/index.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "../result.ts";
import {
  describeWorkspaceResolveError,
  type WorkspaceResolveError,
} from "../workspace-resolution.ts";

export function resultFor<Command extends CommandId, Payload>(
  command: Command,
  payload: Payload | null,
  errors: readonly FalrynError[] = [],
  outcome?: TerminalOutcome,
  effect?: CommandEffect,
): CommandResultOf<Command, Payload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    // A command whose *finding* is the failure supplies its own outcome: it
    // raised no `FalrynError`, because nothing went wrong with the command —
    // what it diagnosed is what is wrong.
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect: effect ?? READ_ONLY_EFFECT,
    payload,
    errors,
    warnings: [],
    omissions: [],
    truncation: [],
    artifacts: [],
    correlation: {
      workspaceId: null,
      sessionId: null,
      turnId: null,
      traceId: null,
      scopeId: null,
      invocationId: null,
      capabilityId: null,
      eventId: null,
    },
  };
}

/**
 * A translated issue set as an error list.
 *
 * `fromConfigurationIssues` returns `null` when nothing in the set blocks use,
 * which is a real answer: a load can raise advisory issues and still be valid.
 */
export function errorsFrom(error: FalrynError | null): readonly FalrynError[] {
  return error === null ? [] : [error];
}

/** What a data command planned, and whether its exact plan was then applied. */

export const MUTATION_NOT_OBSERVED: CommandEffect = { intent: "mutate", observed: "none" };
export const WRITE_COMPLETED_EFFECT: CommandEffect = { intent: "mutate", observed: "completed" };

export function workspaceResolveError(error: WorkspaceResolveError): FalrynError {
  return adoptForeignError(
    {
      code: `workspace.resolve.${error.code}`,
      category: "workspace",
      message: describeWorkspaceResolveError(error),
    },
    { operation: "resolve workspace" },
  );
}
