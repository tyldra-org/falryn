/** Human projections for task intelligence and commit planning. */

import type { TaskCommitPlanPayload } from "../task-commit-plan-commands.ts";
import type {
  TaskDecomposePayload,
  TaskProgressPayload,
  TaskValidatePayload,
} from "../task-intelligence-commands.ts";
import type { RenderedPayload } from "./payload.ts";
import { paint, type Session } from "./session.ts";
import { safe } from "./text.ts";

export function renderTaskDecompose(
  session: Session,
  payload: TaskDecomposePayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No task decomposition is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Task decomposition"),
    `  Outcome   ${safe(payload.decomposition.outcomeId)}`,
    `  Statement ${safe(payload.decomposition.statement)}`,
    "  Tasks",
  ];
  for (const task of payload.decomposition.tasks) {
    lines.push(`    ${safe(task.taskId)}  ${safe(task.objective)}`);
  }
  if (payload.decomposition.omittedGoals.length > 0) {
    lines.push(`  Omitted goals  ${payload.decomposition.omittedGoals.map(safe).join(", ")}`);
  }
  return {
    lines,
    diagnostics: ["Advice only. This command does not execute work or mutate state."],
  };
}

export function renderTaskValidate(
  session: Session,
  payload: TaskValidatePayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No validation advice is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Validation advice"),
    `  Outcome   ${safe(payload.advice.outcomeId)}`,
    "  Recommendations",
  ];
  for (const recommendation of payload.advice.recommendations) {
    lines.push(
      `    ${safe(recommendation.taskId)}  ${safe(recommendation.kind)}  ${safe(recommendation.statement)}`,
    );
  }
  if (payload.advice.omittedTasks.length > 0) {
    lines.push(
      `  Omitted tasks  ${payload.advice.omittedTasks.map((task) => safe(task)).join(", ")}`,
    );
  }
  return {
    lines,
    diagnostics: ["Advice only. This command does not run tests or mark work complete."],
  };
}

export function renderTaskProgress(
  session: Session,
  payload: TaskProgressPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No progress projection is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Task progress"),
    `  Outcome  ${safe(payload.projection.outcomeId)}`,
    `  Overall  ${safe(payload.projection.overall)}`,
    "  Next actions",
  ];
  for (const action of payload.projection.nextActions) {
    lines.push(`    ${safe(action.kind)}  ${safe(action.taskId)}  ${safe(action.statement)}`);
  }
  return {
    lines,
    diagnostics: ["Advice only. This command does not execute work or mark tasks complete."],
  };
}

export function renderTaskCommitPlan(
  session: Session,
  payload: TaskCommitPlanPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No commit plan is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Commit plan"),
    `  Outcome       ${safe(payload.advice.outcomeId)}`,
    `  Confirmation  ${safe(payload.confirmation)}`,
    `  Confirm token ${safe(payload.confirmToken)}`,
    "  Groups",
  ];
  for (const group of payload.advice.plan.groups) {
    lines.push(`    ${safe(group.id)}  ${safe(group.subject)}`);
    for (const path of group.paths) {
      lines.push(`      ${safe(path)}`);
    }
  }
  if (payload.advice.plan.unassigned.length > 0) {
    lines.push("  Unassigned");
    for (const item of payload.advice.plan.unassigned) {
      lines.push(`    ${safe(item.path)}  ${safe(item.reason)}`);
    }
  }
  if (payload.commits.length > 0) {
    lines.push("  Commits");
    for (const commit of payload.commits) {
      lines.push(`    ${safe(commit.oid.slice(0, 12))}  ${safe(commit.subject)}`);
    }
  }
  const diagnostics =
    payload.confirmation === "not-requested"
      ? [
          `Preview only. Re-run with --confirm ${safe(payload.confirmToken)} to apply this exact plan.`,
        ]
      : payload.confirmation === "refused"
        ? ["Confirmation refused. No Git mutation ran."]
        : ["Applied through Git stage+commit with expectedHead checks."];
  return { lines, diagnostics };
}
