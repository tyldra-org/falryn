/**
 * Task-intelligence overlay sheets (#726).
 *
 * Collects line-oriented draft text, runs the same application ports as the
 * CLI, and reports a short notice. The sheet never executes work or mutates
 * state.
 */

import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import {
  decomposeOutcome,
  projectOutcomeProgress,
  recommendOutcomeValidation,
} from "../../application/index.ts";
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
        placeholder="key=value lines; Enter runs advice"
        onInput={(value) => props.onDraft?.(value)}
        onSubmit={() => submitDraft(props)}
      />
      {props.rows > 1 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {`Advice only. Enter runs the same ports as falryn task ${props.panel}.`}
        </Line>
      ) : null}
    </box>
  );
}

function submitDraft(props: TaskIntelligenceSheetProps): void {
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
  }
}
