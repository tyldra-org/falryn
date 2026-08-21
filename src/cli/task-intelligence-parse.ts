/**
 * Parse bounded CLI and overlay text into task-intelligence port inputs (#726).
 *
 * Explicit flags are preferred. A bounded `--input` JSON file is an alternate
 * path when the declared shape is too large for flags alone.
 */

import { readFile } from "node:fs/promises";

import type {
  TaskDecomposeInput,
  TaskProgressInput,
  TaskValidationInput,
} from "../domain/index.ts";

const MAX_INPUT_FILE_BYTES = 64 * 1_024;

export type TaskDecomposeArguments = {
  readonly outcomeId: string;
  readonly statement: string;
  readonly goals: readonly string[];
  readonly nonGoals: readonly string[];
  readonly proposed: readonly { readonly taskId: string; readonly objective: string }[];
};

export type TaskValidateArguments = {
  readonly outcomeId: string;
  readonly tasks: readonly { readonly taskId: string; readonly criteria: readonly string[] }[];
};

export type TaskProgressArguments = {
  readonly outcomeId: string;
  readonly tasks: readonly string[];
  readonly dependencies: readonly { readonly predecessor: string; readonly successor: string }[];
  readonly blockers: readonly { readonly taskId: string; readonly reason: string }[];
  readonly criteria: readonly { readonly taskId: string; readonly criterion: string }[];
  readonly observations: readonly {
    readonly taskId: string;
    readonly status: string;
    readonly note: string | null;
  }[];
};

export type TaskCommandArguments =
  | { readonly action: "decompose"; readonly input: TaskDecomposeArguments }
  | { readonly action: "validate"; readonly input: TaskValidateArguments }
  | { readonly action: "progress"; readonly input: TaskProgressArguments };

type RawTaskOptions = {
  readonly statement?: string | undefined;
  readonly "outcome-id"?: string | undefined;
  readonly goal?: readonly string[] | undefined;
  readonly "non-goal"?: readonly string[] | undefined;
  readonly proposed?: readonly string[] | undefined;
  readonly task?: readonly string[] | undefined;
  readonly depends?: readonly string[] | undefined;
  readonly observe?: readonly string[] | undefined;
  readonly blocker?: readonly string[] | undefined;
  readonly criterion?: readonly string[] | undefined;
  readonly input?: string | undefined;
};

function splitOnce(
  value: string,
  separator: string,
): { readonly head: string; readonly tail: string } | null {
  const index = value.indexOf(separator);
  if (index < 0) {
    return null;
  }
  const head = value.slice(0, index).trim();
  const tail = value.slice(index + separator.length).trim();
  if (head.length === 0 || tail.length === 0) {
    return null;
  }
  return { head, tail };
}

function parseProposed(
  values: readonly string[] | undefined,
): readonly { readonly taskId: string; readonly objective: string }[] | string {
  const proposed: { taskId: string; objective: string }[] = [];
  for (const [index, value] of (values ?? []).entries()) {
    const parsed = splitOnce(value, ":");
    if (parsed === null) {
      return `Argument proposed[${index}] must be taskId:objective.`;
    }
    proposed.push({ taskId: parsed.head, objective: parsed.tail });
  }
  return proposed;
}

function parseValidateTasks(
  values: readonly string[] | undefined,
): readonly { readonly taskId: string; readonly criteria: readonly string[] }[] | string {
  const byTask = new Map<string, string[]>();
  for (const [index, value] of (values ?? []).entries()) {
    const parsed = splitOnce(value, ":");
    if (parsed === null) {
      return `Argument task[${index}] must be taskId:criterion.`;
    }
    const existing = byTask.get(parsed.head) ?? [];
    existing.push(parsed.tail);
    byTask.set(parsed.head, existing);
  }
  if (byTask.size === 0) {
    return "Argument task is required for task validate; name at least one taskId:criterion pair.";
  }
  return [...byTask.entries()].map(([taskId, criteria]) => ({ taskId, criteria }));
}

function parseObservation(
  value: string,
  index: number,
): { readonly taskId: string; readonly status: string; readonly note: string | null } | string {
  const first = splitOnce(value, ":");
  if (first === null) {
    return `Argument observe[${index}] must be taskId:status or taskId:status:note.`;
  }
  const second = splitOnce(first.tail, ":");
  if (second === null) {
    return { taskId: first.head, status: first.tail, note: null };
  }
  return { taskId: first.head, status: second.head, note: second.tail };
}

async function readBoundedInput(path: string): Promise<unknown | string> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    return "Argument input must name a readable JSON file.";
  }
  if (bytes.byteLength > MAX_INPUT_FILE_BYTES) {
    return "Argument input exceeds the bounded task-intelligence file size.";
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return "Argument input must contain valid JSON.";
  }
}

function mergeRecord(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...overlay };
}

export async function taskArgumentsFor(
  action: "decompose" | "validate" | "progress",
  parsed: RawTaskOptions,
): Promise<TaskCommandArguments | string> {
  const inputFile = parsed.input === undefined ? null : await readBoundedInput(parsed.input);
  if (typeof inputFile === "string") {
    return inputFile;
  }

  switch (action) {
    case "decompose": {
      const fileRecord =
        inputFile !== null && typeof inputFile === "object" && inputFile !== null
          ? (inputFile as Record<string, unknown>)
          : {};
      const statement =
        parsed.statement ??
        (typeof fileRecord.statement === "string" ? fileRecord.statement : undefined);
      if (statement === undefined) {
        return "Argument statement is required for task decompose.";
      }
      const goals = parsed.goal ?? (Array.isArray(fileRecord.goals) ? fileRecord.goals : undefined);
      if (goals === undefined || goals.length === 0) {
        return "Argument goal is required for task decompose; name at least one declared goal.";
      }
      const proposed = parseProposed(parsed.proposed);
      if (typeof proposed === "string") {
        return proposed;
      }
      return {
        action: "decompose",
        input: {
          outcomeId:
            parsed["outcome-id"] ??
            (typeof fileRecord.outcomeId === "string" ? fileRecord.outcomeId : "cli-outcome"),
          statement,
          goals,
          nonGoals:
            parsed["non-goal"] ?? (Array.isArray(fileRecord.nonGoals) ? fileRecord.nonGoals : []),
          proposed,
        },
      };
    }
    case "validate": {
      const fileRecord =
        inputFile !== null && typeof inputFile === "object" && inputFile !== null
          ? (inputFile as Record<string, unknown>)
          : {};
      const tasks = parseValidateTasks(parsed.task);
      if (typeof tasks === "string" && inputFile === null) {
        return tasks;
      }
      const mergedTasks =
        typeof tasks === "string" ? fileRecord.tasks : tasks.length > 0 ? tasks : fileRecord.tasks;
      if (!Array.isArray(mergedTasks) || mergedTasks.length === 0) {
        return "Argument task is required for task validate; name at least one taskId:criterion pair.";
      }
      return {
        action: "validate",
        input: {
          outcomeId:
            parsed["outcome-id"] ??
            (typeof fileRecord.outcomeId === "string" ? fileRecord.outcomeId : "cli-outcome"),
          tasks: mergedTasks as TaskValidateArguments["tasks"],
        },
      };
    }
    case "progress": {
      const fileRecord =
        inputFile !== null && typeof inputFile === "object" && inputFile !== null
          ? (inputFile as Record<string, unknown>)
          : {};
      const tasks =
        parsed.task ?? (Array.isArray(fileRecord.tasks) ? fileRecord.tasks.map(String) : undefined);
      if (tasks === undefined || tasks.length === 0) {
        return "Argument task is required for task progress; name at least one task id.";
      }
      const dependencies: { predecessor: string; successor: string }[] = [];
      for (const [index, value] of (parsed.depends ?? []).entries()) {
        const edge = splitOnce(value, ":");
        if (edge === null) {
          return `Argument depends[${index}] must be predecessor:successor.`;
        }
        dependencies.push({ predecessor: edge.head, successor: edge.tail });
      }
      const blockers: { taskId: string; reason: string }[] = [];
      for (const [index, value] of (parsed.blocker ?? []).entries()) {
        const blocker = splitOnce(value, ":");
        if (blocker === null) {
          return `Argument blocker[${index}] must be taskId:reason.`;
        }
        blockers.push({ taskId: blocker.head, reason: blocker.tail });
      }
      const criteria: { taskId: string; criterion: string }[] = [];
      for (const [index, value] of (parsed.criterion ?? []).entries()) {
        const criterion = splitOnce(value, ":");
        if (criterion === null) {
          return `Argument criterion[${index}] must be taskId:criterion.`;
        }
        criteria.push({ taskId: criterion.head, criterion: criterion.tail });
      }
      const observations: { taskId: string; status: string; note: string | null }[] = [];
      for (const [index, value] of (parsed.observe ?? []).entries()) {
        const observation = parseObservation(value, index);
        if (typeof observation === "string") {
          return observation;
        }
        observations.push(observation);
      }
      const merged = mergeRecord(fileRecord, {
        outcomeId:
          parsed["outcome-id"] ??
          (typeof fileRecord.outcomeId === "string" ? fileRecord.outcomeId : "cli-outcome"),
        tasks,
        ...(dependencies.length > 0 ? { dependencies } : {}),
        ...(blockers.length > 0 ? { blockers } : {}),
        ...(criteria.length > 0 ? { criteria } : {}),
        ...(observations.length > 0 ? { observations } : {}),
      });
      return {
        action: "progress",
        input: {
          outcomeId: String(merged.outcomeId),
          tasks: tasks.map(String),
          dependencies:
            dependencies.length > 0
              ? dependencies
              : Array.isArray(merged.dependencies)
                ? (merged.dependencies as TaskProgressArguments["dependencies"])
                : [],
          blockers:
            blockers.length > 0
              ? blockers
              : Array.isArray(merged.blockers)
                ? (merged.blockers as TaskProgressArguments["blockers"])
                : [],
          criteria:
            criteria.length > 0
              ? criteria
              : Array.isArray(merged.criteria)
                ? (merged.criteria as TaskProgressArguments["criteria"])
                : [],
          observations:
            observations.length > 0
              ? observations
              : Array.isArray(merged.observations)
                ? (merged.observations as TaskProgressArguments["observations"])
                : [],
        },
      };
    }
  }
}

export function decomposeInputOf(arguments_: TaskDecomposeArguments): TaskDecomposeInput {
  return {
    outcomeId: arguments_.outcomeId,
    statement: arguments_.statement,
    goals: arguments_.goals,
    nonGoals: arguments_.nonGoals,
    proposed: arguments_.proposed.length > 0 ? arguments_.proposed : undefined,
  };
}

export function validateInputOf(arguments_: TaskValidateArguments): TaskValidationInput {
  return {
    outcomeId: arguments_.outcomeId,
    tasks: arguments_.tasks,
  };
}

export function progressInputOf(arguments_: TaskProgressArguments): TaskProgressInput {
  return {
    outcomeId: arguments_.outcomeId,
    tasks: arguments_.tasks,
    dependencies: arguments_.dependencies.length > 0 ? arguments_.dependencies : undefined,
    blockers: arguments_.blockers.length > 0 ? arguments_.blockers : undefined,
    criteria: arguments_.criteria.length > 0 ? arguments_.criteria : undefined,
    observations:
      arguments_.observations.length > 0
        ? arguments_.observations.map(({ taskId, status, note }) =>
            note === null ? { taskId, status } : { taskId, status, note },
          )
        : undefined,
  };
}

/** Parse line-oriented overlay drafts into decompose arguments. */
export function decomposeArgumentsFromDraft(draft: string): TaskDecomposeArguments | string {
  let outcomeId = "tui-outcome";
  let statement: string | null = null;
  const goals: string[] = [];
  const nonGoals: string[] = [];
  for (const rawLine of draft.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const parsed = splitOnce(line, "=");
    if (parsed === null) {
      return "Each draft line must be key=value.";
    }
    switch (parsed.head) {
      case "outcomeId":
        outcomeId = parsed.tail;
        break;
      case "statement":
        statement = parsed.tail;
        break;
      case "goal":
        goals.push(parsed.tail);
        break;
      case "nonGoal":
        nonGoals.push(parsed.tail);
        break;
      default:
        return `Unknown draft key ${parsed.head}.`;
    }
  }
  if (statement === null) {
    return "Draft must include statement=… and at least one goal=… line.";
  }
  if (goals.length === 0) {
    return "Draft must include at least one goal=… line.";
  }
  return { outcomeId, statement, goals, nonGoals, proposed: [] };
}

/** Parse line-oriented overlay drafts into validate arguments. */
export function validateArgumentsFromDraft(draft: string): TaskValidateArguments | string {
  let outcomeId = "tui-outcome";
  const tasks = new Map<string, string[]>();
  for (const rawLine of draft.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const parsed = splitOnce(line, "=");
    if (parsed === null) {
      return "Each draft line must be key=value.";
    }
    if (parsed.head === "outcomeId") {
      outcomeId = parsed.tail;
      continue;
    }
    if (parsed.head !== "task") {
      return `Unknown draft key ${parsed.head}.`;
    }
    const task = splitOnce(parsed.tail, ":");
    if (task === null) {
      return "Each task line must be task=taskId:criterion.";
    }
    const existing = tasks.get(task.head) ?? [];
    existing.push(task.tail);
    tasks.set(task.head, existing);
  }
  if (tasks.size === 0) {
    return "Draft must include at least one task=taskId:criterion line.";
  }
  return {
    outcomeId,
    tasks: [...tasks.entries()].map(([taskId, criteria]) => ({ taskId, criteria })),
  };
}

/** Parse line-oriented overlay drafts into progress arguments. */
export function progressArgumentsFromDraft(draft: string): TaskProgressArguments | string {
  let outcomeId = "tui-outcome";
  const tasks: string[] = [];
  const dependencies: { predecessor: string; successor: string }[] = [];
  const blockers: { taskId: string; reason: string }[] = [];
  const criteria: { taskId: string; criterion: string }[] = [];
  const observations: { taskId: string; status: string; note: string | null }[] = [];
  for (const rawLine of draft.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const parsed = splitOnce(line, "=");
    if (parsed === null) {
      return "Each draft line must be key=value.";
    }
    switch (parsed.head) {
      case "outcomeId":
        outcomeId = parsed.tail;
        break;
      case "task":
        tasks.push(parsed.tail);
        break;
      case "depends": {
        const edge = splitOnce(parsed.tail, ":");
        if (edge === null) {
          return "Each depends line must be depends=predecessor:successor.";
        }
        dependencies.push({ predecessor: edge.head, successor: edge.tail });
        break;
      }
      case "observe": {
        const observation = parseObservation(parsed.tail, observations.length);
        if (typeof observation === "string") {
          return observation;
        }
        observations.push(observation);
        break;
      }
      case "blocker": {
        const blocker = splitOnce(parsed.tail, ":");
        if (blocker === null) {
          return "Each blocker line must be blocker=taskId:reason.";
        }
        blockers.push({ taskId: blocker.head, reason: blocker.tail });
        break;
      }
      case "criterion": {
        const criterion = splitOnce(parsed.tail, ":");
        if (criterion === null) {
          return "Each criterion line must be criterion=taskId:text.";
        }
        criteria.push({ taskId: criterion.head, criterion: criterion.tail });
        break;
      }
      default:
        return `Unknown draft key ${parsed.head}.`;
    }
  }
  if (tasks.length === 0) {
    return "Draft must include at least one task=… line.";
  }
  return { outcomeId, tasks, dependencies, blockers, criteria, observations };
}
