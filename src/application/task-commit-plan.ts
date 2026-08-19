/**
 * Application boundary for reviewable commit-plan advice (#126).
 *
 * Reads actual changes through GitPort.planCommits, then attaches outcome
 * lineage and optional scope. Secret-shaped scope paths fail closed. This
 * module still does not stage, commit, or call a model.
 */

import {
  assertNever,
  type DurationMs,
  err,
  type GitError,
  type GitPort,
  planTaskCommits,
  type Result,
  type TaskCommitAdvice,
  type TaskCommitPlanError,
  type TaskCommitPlanInput,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function commitPlanError(
  code: TaskCommitPlanError["code"],
  field: string | null,
): TaskCommitPlanError {
  return { kind: "task-commit-plan", code, field };
}

function fromGitError(error: GitError): TaskCommitPlanError {
  switch (error.code) {
    case "cancelled":
      return commitPlanError("cancelled", "git");
    case "secret-path":
      return commitPlanError("secret", "git");
    case "authentication":
    case "already-exists":
    case "checkpoint-missing":
    case "checked-out":
    case "dirty-worktree":
    case "diverged":
    case "empty-index":
    case "failed":
    case "head-mismatch":
    case "hook-failed":
    case "invalid-request":
    case "lock-contention":
    case "no-upstream":
    case "non-fast-forward":
    case "not-a-repository":
    case "not-merged":
    case "operation-in-progress":
    case "output-exceeded":
    case "rejected":
    case "restore-ambiguous":
    case "signing-failed":
    case "spawn-failed":
    case "timed-out":
    case "unsafe-ownership":
      return commitPlanError("unavailable", "git");
    default:
      return assertNever(error, "unhandled git error");
  }
}

export type PlanOutcomeCommitsInput = {
  readonly outcomeId: unknown;
  readonly taskId?: unknown;
  readonly scope?: unknown;
  readonly gitExecutable: string;
  readonly startPath: string;
  readonly timeoutMs?: DurationMs | undefined;
  readonly expectedHead?: string | undefined;
  readonly subjects?: unknown;
  readonly model?: unknown;
};

export async function planOutcomeCommits(
  git: GitPort,
  input: PlanOutcomeCommitsInput,
  signal?: AbortSignal,
): Promise<Result<TaskCommitAdvice, TaskCommitPlanError>> {
  if (Array.isArray(input.scope)) {
    for (const [index, path] of input.scope.entries()) {
      if (typeof path === "string" && containsRedactableSecret(path)) {
        return err(commitPlanError("secret", `scope.${index}`));
      }
    }
  }
  const snapshot = await git.planCommits({
    gitExecutable: input.gitExecutable,
    startPath: input.startPath,
    timeoutMs: input.timeoutMs,
    expectedHead: input.expectedHead,
    signal,
  });
  if (!snapshot.ok) {
    return err(fromGitError(snapshot.error));
  }
  const domainInput: TaskCommitPlanInput = {
    outcomeId: input.outcomeId,
    taskId: input.taskId,
    scope: input.scope,
    identity: snapshot.value.identity,
    plan: snapshot.value.plan,
    subjects: input.subjects,
    model: input.model,
  };
  return planTaskCommits(domainInput, signal);
}
