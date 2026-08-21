/**
 * Task-intelligence overlay sheets (#726 / #727).
 *
 * Collects line-oriented draft text, runs the same application ports as the
 * CLI, and reports a short notice. Decompose/validate/progress never mutate.
 * Commit-plan may stage and commit only when the draft carries the exact
 * confirm token for the refreshed plan.
 */

import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import {
  decomposeOutcome,
  projectOutcomeProgress,
  recommendOutcomeValidation,
} from "../../application/index.ts";
import {
  runTaskCommitPlan,
  summarizeTaskCommitPlan,
  taskCommitPlanArgumentsFor,
} from "../../cli/task-commit-plan-commands.ts";
import {
  summarizeTaskDecomposition,
  summarizeTaskProgress,
  summarizeTaskValidation,
} from "../../cli/task-intelligence-commands.ts";
import {
  decomposeArgumentsFromDraft,
  decomposeInputOf,
  progressArgumentsFromDraft,
  progressInputOf,
  validateArgumentsFromDraft,
  validateInputOf,
} from "../../cli/task-intelligence-parse.ts";
import {
  describeTaskDecomposeError,
  describeTaskProgressError,
  describeTaskValidationError,
} from "../../domain/index.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";
import type { TaskIntelligencePanel } from "./format.ts";
import { TASK_INTELLIGENCE_PANEL_TITLES } from "./format.ts";

export type TaskIntelligenceSheetProps = {
  readonly panel: TaskIntelligencePanel;
  readonly draft: string;
  readonly rows: number;
  readonly onDraft?: (draft: string) => void;
  readonly onNotice?: (message: string) => void;
  readonly onClose?: () => void;
};

export function TaskIntelligenceSheet(props: TaskIntelligenceSheetProps): ReactNode {
  const { terminal } = useFrame();
  const columns = Math.max(8, terminal.columns - 4);

  useKeyboard((event) => {
    if (event.name === "escape") {
      props.onClose?.();
    }
  });

  if (props.rows < 1) {
    return null;
  }

  return (
    <box flexDirection="column">
      <Line color="foreground" typography="body" maxColumns={columns}>
        {TASK_INTELLIGENCE_PANEL_TITLES[props.panel]}
      </Line>
      <input
        value={props.draft}
        focused={props.onDraft !== undefined}
        width={columns}
        placeholder="key=value lines; Enter runs"
        onInput={(value) => props.onDraft?.(value)}
        onSubmit={() => {
          void submitDraft(props);
        }}
      />
      {props.rows > 1 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {props.panel === "commit-plan"
            ? "Preview by default. confirm=plan-commit-… applies the refreshed plan."
            : `Advice only. Enter runs the same ports as falryn task ${props.panel}.`}
        </Line>
      ) : null}
    </box>
  );
}

async function submitDraft(props: TaskIntelligenceSheetProps): Promise<void> {
  switch (props.panel) {
    case "decompose": {
      const parsed = decomposeArgumentsFromDraft(props.draft);
      if (typeof parsed === "string") {
        props.onNotice?.(parsed);
        return;
      }
      const result = decomposeOutcome(decomposeInputOf(parsed));
      if (!result.ok) {
        props.onNotice?.(describeTaskDecomposeError(result.error));
        return;
      }
      props.onNotice?.(summarizeTaskDecomposition(result.value));
      props.onClose?.();
      return;
    }
    case "validate": {
      const parsed = validateArgumentsFromDraft(props.draft);
      if (typeof parsed === "string") {
        props.onNotice?.(parsed);
        return;
      }
      const result = recommendOutcomeValidation(validateInputOf(parsed));
      if (!result.ok) {
        props.onNotice?.(describeTaskValidationError(result.error));
        return;
      }
      props.onNotice?.(summarizeTaskValidation(result.value));
      props.onClose?.();
      return;
    }
    case "progress": {
      const parsed = progressArgumentsFromDraft(props.draft);
      if (typeof parsed === "string") {
        props.onNotice?.(parsed);
        return;
      }
      const result = projectOutcomeProgress(progressInputOf(parsed));
      if (!result.ok) {
        props.onNotice?.(describeTaskProgressError(result.error));
        return;
      }
      props.onNotice?.(summarizeTaskProgress(result.value));
      props.onClose?.();
      return;
    }
    case "commit-plan": {
      const fields = draftFields(props.draft);
      const args = taskCommitPlanArgumentsFor({
        "outcome-id": fields.outcomeId,
        "task-id": fields.taskId,
        scope: fields.scope,
        cwd: fields.cwd,
        confirm: fields.confirm,
      });
      if (typeof args === "string") {
        props.onNotice?.(args);
        return;
      }
      const result = await runTaskCommitPlan(args);
      if (result.payload === null) {
        const first = result.errors[0];
        props.onNotice?.(first === undefined ? "Commit plan failed." : String(first));
        return;
      }
      props.onNotice?.(summarizeTaskCommitPlan(result.payload));
      props.onClose?.();
    }
  }
}

function draftFields(draft: string): {
  readonly outcomeId?: string;
  readonly taskId?: string;
  readonly scope?: readonly string[];
  readonly cwd?: string;
  readonly confirm?: string;
} {
  const scope: string[] = [];
  let outcomeId: string | undefined;
  let taskId: string | undefined;
  let cwd: string | undefined;
  let confirm: string | undefined;
  for (const raw of draft.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (value.length === 0) {
      continue;
    }
    switch (key) {
      case "outcomeId":
      case "outcome-id":
        outcomeId = value;
        break;
      case "taskId":
      case "task-id":
        taskId = value;
        break;
      case "scope":
        scope.push(value);
        break;
      case "cwd":
        cwd = value;
        break;
      case "confirm":
        confirm = value;
        break;
      default:
        break;
    }
  }
  return {
    ...(outcomeId === undefined ? {} : { outcomeId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(scope.length === 0 ? {} : { scope }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(confirm === undefined ? {} : { confirm }),
  };
}
