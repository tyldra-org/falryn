/**
 * Application boundary for reviewable commit-plan advice (#126) and confirmed
 * product execution (#727).
 *
 * Reads actual changes through GitPort.planCommits, then attaches outcome
 * lineage and optional scope. Secret-shaped scope paths fail closed. Preview
 * still does not stage or commit. Execution stages and commits only when the
 * caller supplies the exact confirm token for the refreshed plan.
 */

import { createHash } from "node:crypto";

import {
  assertNever,
  type DurationMs,
  err,
  type GitCommitResult,
  type GitError,
  type GitPort,
  ok,
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

/** Stable confirm token for a refreshed commit plan (never silent autocommit). */
export function commitPlanConfirmToken(advice: TaskCommitAdvice): string {
  const head = advice.plan.provenance.head ?? "none";
  const material = [
    head,
    ...advice.plan.groups.map(
      (group) => `${group.id}\0${group.subject}\0${group.paths.join("\0")}`,
    ),
  ].join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 12);
  return `plan-commit-${digest}`;
}

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

export type ExecuteOutcomeCommitPlanInput = PlanOutcomeCommitsInput & {
  readonly confirmation: string | null;
};

export type ExecuteOutcomeCommitPlanResult = {
  readonly advice: TaskCommitAdvice;
  readonly confirmToken: string;
  readonly confirmation: "not-requested" | "applied" | "refused";
  readonly commits: readonly GitCommitResult[];
};

/**
 * Preview or apply a commit plan.
 *
 * Without confirmation, returns advice and the exact token required to apply.
 * With a mismatched token, refuses without mutating. With a match, stages and
 * commits each group in order under expectedHead checks.
 */
export async function executeOutcomeCommitPlan(
  git: GitPort,
  input: ExecuteOutcomeCommitPlanInput,
  signal?: AbortSignal,
): Promise<Result<ExecuteOutcomeCommitPlanResult, TaskCommitPlanError>> {
  const planned = await planOutcomeCommits(git, input, signal);
  if (!planned.ok) {
    return planned;
  }
  const advice = planned.value;
  const confirmToken = commitPlanConfirmToken(advice);
  if (input.confirmation === null) {
    return ok({
      advice,
      confirmToken,
      confirmation: "not-requested",
      commits: [],
    });
  }
  if (input.confirmation !== confirmToken) {
    return ok({
      advice,
      confirmToken,
      confirmation: "refused",
      commits: [],
    });
  }
  if (advice.plan.groups.length === 0) {
    return ok({
      advice,
      confirmToken,
      confirmation: "applied",
      commits: [],
    });
  }

  const commits: GitCommitResult[] = [];
  let expectedHead =
    input.expectedHead ??
    (advice.plan.provenance.head === null ? undefined : advice.plan.provenance.head);

  for (const group of advice.plan.groups) {
    const staged = await git.stage({
      gitExecutable: input.gitExecutable,
      startPath: input.startPath,
      timeoutMs: input.timeoutMs,
      expectedHead,
      paths: group.paths,
      signal,
    });
    if (!staged.ok) {
      return err(fromGitError(staged.error));
    }
    const headAfterStage =
      staged.value.identity.head.state === "observed"
        ? staged.value.identity.head.value
        : expectedHead;
    const committed = await git.commit({
      gitExecutable: input.gitExecutable,
      startPath: input.startPath,
      timeoutMs: input.timeoutMs,
      expectedHead: headAfterStage,
      subject: group.subject,
      signal,
    });
    if (!committed.ok) {
      return err(fromGitError(committed.error));
    }
    commits.push(committed.value);
    expectedHead =
      committed.value.identity.head.state === "observed"
        ? committed.value.identity.head.value
        : committed.value.oid;
  }

  return ok({
    advice,
    confirmToken,
    confirmation: "applied",
    commits,
  });
}
