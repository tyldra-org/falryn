/**
 * Commit-plan CLI surface (#727).
 *
 * `falryn task commit-plan` previews reviewable groups from actual changes.
 * Applying requires `--confirm plan-commit-…` for the refreshed plan — never
 * silent autocommit.
 */

import {
  type ExecuteOutcomeCommitPlanResult,
  executeOutcomeCommitPlan,
  fromUnknown,
} from "../application/index.ts";
import {
  describeTaskCommitPlanError,
  type FalrynError,
  type TerminalOutcome,
} from "../domain/index.ts";
import { createHostGitPort, createHostProcessCapturePort } from "../integrations/index.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";

export const TASK_COMMIT_PLAN_OWNER = "#727";

const MUTATION_NOT_OBSERVED: CommandEffect = { intent: "mutate", observed: "none" };
const MUTATION_OBSERVED: CommandEffect = { intent: "mutate", observed: "completed" };

export type TaskCommitPlanArguments = {
  readonly outcomeId: string;
  readonly taskId: string | null;
  readonly scope: readonly string[];
  readonly startPath: string;
  readonly confirmation: string | null;
};

export type TaskCommitPlanPayload = {
  readonly owner: typeof TASK_COMMIT_PLAN_OWNER;
  readonly advice: ExecuteOutcomeCommitPlanResult["advice"];
  readonly confirmToken: string;
  readonly confirmation: ExecuteOutcomeCommitPlanResult["confirmation"];
  readonly commits: ExecuteOutcomeCommitPlanResult["commits"];
};

function resultFor(
  payload: TaskCommitPlanPayload | null,
  errors: readonly FalrynError[] = [],
  outcome?: TerminalOutcome,
  effect: CommandEffect = READ_ONLY_EFFECT,
): CommandResultOf<"task.commit-plan", TaskCommitPlanPayload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command: "task.commit-plan",
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect,
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

export function summarizeTaskCommitPlan(payload: TaskCommitPlanPayload): string {
  const groups = payload.advice.plan.groups.length;
  if (payload.confirmation === "applied") {
    return `Applied ${payload.commits.length} commit(s) across ${groups} group(s).`;
  }
  if (payload.confirmation === "refused") {
    return `Confirmation refused. Re-run with --confirm ${payload.confirmToken}.`;
  }
  return `Preview: ${groups} group(s). Re-run with --confirm ${payload.confirmToken} to apply.`;
}

/** Preview or apply a commit plan from actual repository changes. */
export async function runTaskCommitPlan(
  arguments_: TaskCommitPlanArguments,
  signal?: AbortSignal,
): Promise<CommandResultOf<"task.commit-plan", TaskCommitPlanPayload>> {
  const gitExecutable = Bun.which("git");
  if (gitExecutable === null) {
    return resultFor(null, [
      fromUnknown(new Error("git executable was not found on PATH"), {
        operation: "plan commits",
      }),
    ]);
  }
  const git = createHostGitPort({ capture: createHostProcessCapturePort() });
  const result = await executeOutcomeCommitPlan(
    git,
    {
      outcomeId: arguments_.outcomeId,
      ...(arguments_.taskId === null ? {} : { taskId: arguments_.taskId }),
      ...(arguments_.scope.length === 0 ? {} : { scope: arguments_.scope }),
      gitExecutable,
      startPath: arguments_.startPath,
      confirmation: arguments_.confirmation,
    },
    signal,
  );
  if (!result.ok) {
    return resultFor(null, [
      fromUnknown(new Error(describeTaskCommitPlanError(result.error)), {
        operation: "plan commits",
      }),
    ]);
  }
  const payload: TaskCommitPlanPayload = {
    owner: TASK_COMMIT_PLAN_OWNER,
    advice: result.value.advice,
    confirmToken: result.value.confirmToken,
    confirmation: result.value.confirmation,
    commits: result.value.commits,
  };
  if (result.value.confirmation === "refused") {
    return resultFor(
      payload,
      [
        fromUnknown(new Error("the confirmed plan identity does not match the current plan"), {
          operation: "confirm commit plan",
        }),
      ],
      { kind: "failed", effect: "none" },
    );
  }
  if (arguments_.confirmation === null) {
    return resultFor(payload);
  }
  return resultFor(
    payload,
    [],
    { kind: "completed" },
    result.value.commits.length > 0 ? MUTATION_OBSERVED : MUTATION_NOT_OBSERVED,
  );
}

export function taskCommitPlanArgumentsFor(parsed: {
  readonly "outcome-id"?: string | undefined;
  readonly "task-id"?: string | undefined;
  readonly scope?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly confirm?: string | undefined;
}): TaskCommitPlanArguments | string {
  return {
    outcomeId: parsed["outcome-id"]?.trim() || "cli-outcome",
    taskId: parsed["task-id"]?.trim() || null,
    scope: parsed.scope ?? [],
    startPath: parsed.cwd?.trim() || process.cwd(),
    confirmation: parsed.confirm?.trim() || null,
  };
}
