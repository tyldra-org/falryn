/** Validate sealed child artifacts before asking the durable parent owner to integrate them. */

import type { ArtifactStorePort } from "../../domain/artifacts/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type {
  AgentLink,
  JoinEvidence,
  JoinOwner,
  JoinRecord,
  JoinResult,
  JoinStore,
} from "../../domain/orchestration/agent-join.ts";
import { MAX_PROCESS_TASK_LOG_BYTES } from "../../domain/orchestration/process-task.ts";
import type { ProcessTaskStore } from "../../domain/orchestration/process-task-store.ts";
import {
  agentDefinitionSchema,
  MAX_AGENT_RESULT_BYTES,
  validateAgentValue,
} from "./agent-definition.ts";
import { sealedAgentResultSchema } from "./delegation-contract.ts";
import { readProcessTaskBytes } from "./process-task-output.ts";

export function createAgentJoins(options: {
  readonly store: JoinStore;
  readonly tasks: ProcessTaskStore;
  readonly artifacts: ArtifactStorePort;
}) {
  const { store, tasks, artifacts } = options;
  async function evidence(link: AgentLink, signal: AbortSignal): Promise<JoinResult<JoinEvidence>> {
    const task = tasks.get(link.handle.task);
    const base: JoinEvidence = {
      handle: link.handle,
      state: "missing",
      effect: "uncertain",
      resultDigest: null,
      artifactId: null,
      sequence: null,
    };
    if (!task.ok) return task.error.code === "not-found" ? ok(base) : err({ code: "unavailable" });
    if (task.value.state !== "terminal") return ok({ ...base, state: "running", effect: "none" });
    const sequence = store.sealSequence(link.handle.task);
    if (!sequence.ok || sequence.value === null) return err({ code: "unavailable" });
    const terminal = {
      ...base,
      state: task.value.terminal.outcome,
      effect: task.value.terminal.effect,
      sequence: sequence.value,
    };
    if (task.value.terminal.result === null) return ok({ ...terminal, state: "uncertain" });
    const length = task.value.terminal.result.byteLength;
    if (length > MAX_AGENT_RESULT_BYTES + 1024) return ok({ ...terminal, state: "invalid" });
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += MAX_PROCESS_TASK_LOG_BYTES) {
      const chunk = await readProcessTaskBytes(
        tasks,
        artifacts,
        task.value,
        "result",
        offset,
        Math.min(MAX_PROCESS_TASK_LOG_BYTES, length - offset),
        signal,
      );
      if (!chunk.ok || chunk.value.availableBytes !== length)
        return ok({ ...terminal, state: "invalid" });
      bytes.set(chunk.value.bytes, offset);
    }
    try {
      const wrapper: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof wrapper !== "object" ||
        wrapper === null ||
        !("status" in wrapper) ||
        wrapper.status !== "completed" ||
        !("output" in wrapper)
      )
        return ok({ ...terminal, state: "invalid" });
      const parsed = sealedAgentResultSchema.safeParse(wrapper.output);
      if (!parsed.success) return ok({ ...terminal, state: "invalid" });
      const result = parsed.data;
      const { resultDigest, ...facts } = result;
      const schema = agentDefinitionSchema.shape.resultSchema.safeParse(link.resultSchema);
      if (
        canonicalDigest(facts) !== resultDigest ||
        canonicalDigest(result.handle) !== canonicalDigest(link.handle) ||
        result.definitionDigest !== link.definitionDigest ||
        result.parent.taskId !== link.owner.taskId ||
        result.parent.sessionId !== link.owner.sessionId ||
        result.parent.turnId !== link.owner.turnId ||
        result.rootTaskId !== link.rootTaskId ||
        result.outcome !== terminal.state ||
        result.effect !== terminal.effect ||
        !schema.success ||
        (result.outcome === "completed" &&
          !validateAgentValue(schema.data, result.claims, MAX_AGENT_RESULT_BYTES / 2))
      )
        return ok({ ...terminal, state: "invalid" });
      return ok({ ...terminal, resultDigest, artifactId: task.value.terminal.result.artifactId });
    } catch {
      return ok({ ...terminal, state: "invalid" });
    }
  }
  async function refresh(
    record: JoinRecord,
    signal: AbortSignal,
    cancel = false,
  ): Promise<JoinResult<JoinRecord>> {
    if (record.state !== "waiting") return ok(record);
    const results: JoinEvidence[] = [];
    for (const handle of record.input.children) {
      if (signal.aborted && !cancel) return err({ code: "cancelled" });
      const link = store.link(handle);
      if (!link.ok) return link;
      if (canonicalDigest(link.value.owner) !== canonicalDigest(record.owner))
        return err({ code: "foreign-parent" });
      const result = await evidence(link.value, signal);
      if (!result.ok) return result;
      results.push(result.value);
    }
    if (signal.aborted && !cancel) return err({ code: "cancelled" });
    return store.settle(record, results, cancel);
  }
  return {
    store,
    task: tasks.get,
    refresh,
    evidence,
    ownerMatches: (left: JoinOwner, right: JoinOwner) =>
      canonicalDigest(left) === canonicalDigest(right),
  };
}
export type AgentJoins = ReturnType<typeof createAgentJoins>;
