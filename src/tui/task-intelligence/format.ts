/**
 * Task-intelligence overlay routes and panel titles (#726 / #727).
 */

import type { OverlayRoute } from "../view-model.ts";

export const TASK_INTELLIGENCE_PANELS = [
  "decompose",
  "validate",
  "progress",
  "commit-plan",
] as const;
export type TaskIntelligencePanel = (typeof TASK_INTELLIGENCE_PANELS)[number];

export const TASK_INTELLIGENCE_PANEL_TITLES: Readonly<Record<TaskIntelligencePanel, string>> = {
  decompose: "Decompose outcome",
  validate: "Validation advice",
  progress: "Task progress",
  "commit-plan": "Commit plan",
};

export const TASK_INTELLIGENCE_DRAFTS: Readonly<Record<TaskIntelligencePanel, string>> = {
  decompose: [
    "# statement= and goal= lines",
    "statement=Ship a bounded export",
    "goal=Write the export package",
    "nonGoal=Execute Git",
  ].join("\n"),
  validate: ["# task=taskId:criterion lines", "task=t1:Restore succeeds from the package"].join(
    "\n",
  ),
  progress: [
    "# task=, depends=, observe= lines",
    "task=t1",
    "task=t2",
    "depends=t1:t2",
    "observe=t1:completed",
  ].join("\n"),
  "commit-plan": [
    "# cwd= start path; confirm=plan-commit-… applies the refreshed plan",
    "cwd=.",
    "# confirm=",
  ].join("\n"),
};

export function taskIntelligenceOverlayRoute(
  panel: TaskIntelligencePanel,
): Extract<OverlayRoute, { readonly kind: "task-intelligence" }> {
  return {
    kind: "task-intelligence",
    panel,
    draft: TASK_INTELLIGENCE_DRAFTS[panel],
  };
}

export function taskIntelligencePanelForCommand(id: string): TaskIntelligencePanel | null {
  switch (id) {
    case "task.decompose":
      return "decompose";
    case "task.validate":
      return "validate";
    case "task.progress":
      return "progress";
    case "task.commit-plan":
      return "commit-plan";
    default:
      return null;
  }
}

export function taskIntelligencePanelTitle(panel: TaskIntelligencePanel): string {
  return TASK_INTELLIGENCE_PANEL_TITLES[panel];
}
