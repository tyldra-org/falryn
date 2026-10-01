/**
 * Built-in operation profiles and their provider definitions (#946).
 *
 * The Git family is three profiles over the existing native Git tools: inspect
 * (read-only), branch/worktree and changes/synchronization. Each operation keeps
 * its native tool, schema, effect and executor; a profile only shapes what the
 * model sees. GitHub operations join this family when their adapters are
 * executable; until then nothing here implies they exist.
 */

import type {
  OperationProfileDefinition,
  OperationProfileMember,
} from "../../domain/tools/index.ts";

export const GIT_OPERATION_PROFILES: readonly OperationProfileDefinition[] = [
  {
    id: "git.inspect",
    version: 1,
    name: "git_inspect",
    description: "Inspect the workspace's Git repository without changing it.",
    members: [
      { operation: "discover", toolName: "git_discover" },
      { operation: "status", toolName: "git_status" },
      { operation: "diff", toolName: "git_diff" },
      { operation: "log", toolName: "git_log" },
      { operation: "blame", toolName: "git_blame" },
      { operation: "list_worktrees", toolName: "git_list_worktrees" },
    ],
  },
  {
    id: "git.branch",
    version: 1,
    name: "git_branch",
    description: "Create, switch or delete Git branches and add or remove worktrees.",
    members: [
      { operation: "create_branch", toolName: "git_create_branch" },
      { operation: "switch_branch", toolName: "git_switch_branch" },
      { operation: "delete_branch", toolName: "git_delete_branch" },
      { operation: "create_worktree", toolName: "git_create_worktree" },
      { operation: "remove_worktree", toolName: "git_remove_worktree" },
    ],
  },
  {
    id: "git.change",
    version: 1,
    name: "git_change",
    description: "Stage or unstage paths, commit, or sync the current Git branch.",
    members: [
      { operation: "stage", toolName: "git_stage" },
      { operation: "unstage", toolName: "git_unstage" },
      { operation: "commit", toolName: "git_commit" },
      { operation: "sync", toolName: "git_sync" },
    ],
  },
];

/** Every built-in profile, in the order they are considered. */
export const PRODUCT_OPERATION_PROFILES: readonly OperationProfileDefinition[] =
  GIT_OPERATION_PROFILES;

/** One disclosed operation with the native definition it lowers to. */
export type ProfileOperationSource = OperationProfileMember & {
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
};

/**
 * The provider-facing definition of one profile: `operation` names the native
 * operation, and that operation's native arguments go under the property of the
 * same name. Only disclosed operations appear, so the schema is state-valid.
 */
export function operationProfileDefinition(
  definition: OperationProfileDefinition,
  operations: readonly ProfileOperationSource[],
): {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
} {
  const properties: Record<string, unknown> = {
    operation: {
      type: "string",
      enum: operations.map((operation) => operation.operation),
      description: "The operation to run.",
    },
  };
  for (const operation of operations) {
    properties[operation.operation] = withoutSchemaHeader(operation.parameters);
  }
  return {
    name: definition.name,
    description: `${definition.description} Set "operation", and put that operation's arguments in the property of the same name; leave the others out. Operations: ${operations
      .map((operation) => `${operation.operation} (${operation.description})`)
      .join("; ")}.`,
    parameters: {
      type: "object",
      properties,
      required: ["operation"],
      additionalProperties: false,
    },
  };
}

function withoutSchemaHeader(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { $schema: _header, ...rest } = schema;
  return rest;
}
