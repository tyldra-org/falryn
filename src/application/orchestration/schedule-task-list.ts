/**
 * Scheduled Todo selections (#1112). An occurrence expands its selector once at
 * the queue's current revision, freezes that manifest as a finalized artifact,
 * and prepares the task-list workflow at the same revision with the manifest as
 * its evidence source. Nothing here launches work; admission stays with the
 * workflow actions.
 */
import { createHash } from "node:crypto";
import { type ArtifactStorePort, artifactId, contentDigest } from "../../domain/artifacts/index.ts";
import { canonicalJson } from "../../domain/extensions/canonical.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import type {
  ScheduleTaskListTarget,
  ScheduleTerminal,
} from "../../domain/orchestration/schedule-state.ts";
import type { WorkQueue } from "../../domain/orchestration/work-queue.ts";
import type { WorkflowDefinition } from "../../domain/orchestration/workflow-definition.ts";
import type { WorkflowRecord } from "../../domain/orchestration/workflow-state.ts";
import { type ProductTaskLists, TaskListAgentRefusal } from "./work-queue-authority.ts";
import type { WorkQueueResponse } from "./work-queues.ts";
import { TASK_LIST_ACCEPTANCE_WAIT, TaskListSelectionRefusal } from "./workflow-task-list.ts";

type Manifest = NonNullable<WorkQueueResponse["manifest"]>;
type Actions = ProductTaskLists["actions"];
type Refusal = { readonly code: string };

/** Revision races repaired by re-reading before an occurrence is refused as stale. */
const READ_ATTEMPTS = 3;
/** Manifest entries a preview lists; counts always cover the complete selection. */
const PREVIEW_TASKS = 256;
const REASON = /^[a-z0-9-]{1,128}$/u;
/** The workflow definition identity of every scheduled task-list run. */
export const SCHEDULED_TASK_LIST_WORKFLOW = "user/schedules:task-list";

/**
 * The selector's current manifest. Only project and shared queues can follow a
 * durable schedule; session-bound queues stay with their own session.
 */
export async function readScheduledSelection(
  actions: Actions,
  target: ScheduleTaskListTarget,
  signal: AbortSignal,
): Promise<Result<{ queue: WorkQueue; manifest: Manifest }, Refusal>> {
  let revision = 0;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const result = await actions.execute(
      JSON.stringify({
        version: 2,
        action: "expand",
        queueId: target.queueId,
        scopeGeneration: target.scopeGeneration,
        expectedRevision: revision,
        groups: target.groups,
        tasks: target.tasks,
      }),
      signal,
    );
    if (result.ok) {
      const { queue, manifest } = result.value;
      if (!queue || !manifest) return err({ code: "task-list-queue-unavailable" });
      if (queue.scope.kind !== "project" && queue.scope.kind !== "shared")
        return err({ code: "task-list-scope-unsupported" });
      return ok({ queue, manifest });
    }
    if (result.error.code === "stale-page" && result.error.currentRevision !== undefined) {
      revision = result.error.currentRevision;
      continue;
    }
    return err({ code: `task-list-${result.error.code}` });
  }
  return err({ code: "task-list-selection-stale" });
}

function counts(manifest: Manifest) {
  const totals: Record<string, number> = {};
  for (const task of manifest.tasks) totals[task.status] = (totals[task.status] ?? 0) + 1;
  return totals;
}

/** A revision-bound preview of what the next occurrence would select. It launches nothing. */
export async function previewScheduledSelection(
  actions: Actions,
  target: ScheduleTaskListTarget,
  signal: AbortSignal,
): Promise<Result<Readonly<Record<string, unknown>>, Refusal>> {
  const read = await readScheduledSelection(actions, target, signal);
  if (!read.ok) return read;
  const { queue, manifest } = read.value;
  return ok({
    kind: "task-list-selection",
    queue: { id: queue.id, revision: manifest.revision, scope: queue.scope.kind },
    groups: manifest.groups,
    counts: counts(manifest),
    tasks: manifest.tasks.slice(0, PREVIEW_TASKS),
    complete: manifest.tasks.length <= PREVIEW_TASKS,
  });
}

export type ScheduledTaskListOccurrence =
  | {
      readonly kind: "prepared";
      readonly definition: WorkflowDefinition;
      readonly manifest: NonNullable<ScheduleTerminal["result"]>;
    }
  | { readonly kind: "settled"; readonly terminal: Omit<ScheduleTerminal, "at"> };

function refusedCode(error: unknown): string {
  if (error instanceof TaskListSelectionRefusal) return `task-list-${error.code}`;
  if (error instanceof TaskListAgentRefusal) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (message === "workflow-task-list-stale-page") return "task-list-selection-stale";
  return REASON.test(message) ? message : "task-list-preparation-failed";
}

/**
 * Freeze one occurrence's selection and prepare its workflow. A selection with no
 * admissible task settles as truthful no-work; refusals settle with no effect.
 */
export async function prepareScheduledTaskList(input: {
  readonly taskLists: ProductTaskLists;
  readonly artifacts: Pick<ArtifactStorePort, "ingest">;
  readonly target: ScheduleTaskListTarget;
  readonly attempt: string;
  readonly signal: AbortSignal;
}): Promise<ScheduledTaskListOccurrence> {
  const { target, signal } = input;
  const unavailable = (reason: string): ScheduledTaskListOccurrence => ({
    kind: "settled",
    terminal: { status: "unavailable", effect: "none", reason, result: null },
  });
  const read = await readScheduledSelection(input.taskLists.actions, target, signal);
  if (!read.ok) return unavailable(read.error.code);
  const { queue, manifest } = read.value;
  const bytes = new TextEncoder().encode(
    canonicalJson({
      version: 1,
      kind: "schedule-task-list-manifest",
      attempt: input.attempt,
      queue: { id: queue.id, scopeGeneration: target.scopeGeneration, revision: manifest.revision },
      selector: { groups: target.groups, tasks: target.tasks, autoCascade: target.autoCascade },
      manifest,
    }),
  );
  const digest = contentDigest.from(`sha-256:${createHash("sha256").update(bytes).digest("hex")}`);
  const id = artifactId.from(`schedule-task-list-${input.attempt}`);
  const saved = await input.artifacts.ingest(
    {
      artifactId: id,
      mediaType: "application/json",
      encoding: "identity",
      sensitivity: "user-content",
      origin: "capture",
      // Frozen before any invocation exists; the attempt ID in its identity links it.
      invocationId: null,
      expectedDigest: digest,
      declaredByteLength: bytes.byteLength,
      content: (async function* () {
        yield bytes;
      })(),
    },
    signal,
  );
  if (!saved.ok) return unavailable("task-list-manifest-unavailable");
  const frozen = { artifactId: id, digest, byteLength: bytes.byteLength };
  const noWork: ScheduledTaskListOccurrence = {
    kind: "settled",
    terminal: { status: "succeeded", effect: "none", reason: "task-list-no-work", result: frozen },
  };
  if (!manifest.tasks.some((task) => task.status === "admissible")) return noWork;
  try {
    const definition = await input.taskLists.prepare({
      queue,
      selected: target.tasks,
      groups: target.groups,
      autoCascade: target.autoCascade,
      source: String(id),
      sourceGeneration: String(digest),
      id: SCHEDULED_TASK_LIST_WORKFLOW,
      signal,
    });
    return { kind: "prepared", definition, manifest: frozen };
  } catch (error) {
    if (error instanceof TaskListSelectionRefusal && error.code === "selection-empty")
      return noWork;
    return {
      kind: "settled",
      terminal: {
        status: "unavailable",
        effect: "none",
        reason: refusedCode(error),
        result: frozen,
      },
    };
  }
}

/**
 * A task-list run has settled for its occurrence once nothing is executing and
 * every waiting node awaits acceptance of submitted evidence. Acceptance, and any
 * dependents it unlocks, belongs to the task owner and a later resume.
 */
export function awaitingTaskAcceptance(record: WorkflowRecord): boolean {
  if (record.state !== "waiting" || record.definition.taskList === undefined) return false;
  const waiting = record.nodes.filter((node) => node.state === "waiting");
  return (
    waiting.length > 0 &&
    waiting.every((node) => node.reason === TASK_LIST_ACCEPTANCE_WAIT) &&
    !record.nodes.some((node) => node.state === "running")
  );
}
