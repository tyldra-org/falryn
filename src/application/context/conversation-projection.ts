/** Deterministic public conversation projection. Historical calls never enter a runner. */
import { z } from "zod";
import type { RuntimeEvent } from "../../domain/sessions/index.ts";
import type { ModelMessage } from "../../providers/index.ts";
export type ConversationRecord = {
  readonly event: Extract<RuntimeEvent, { kind: "history.recorded" }>;
  readonly text: string;
};

const object = z.record(z.string(), z.unknown());
const proposal = z.object({ toolCallId: z.string(), name: z.string(), arguments: object });
const textMessage = (role: "user" | "assistant", text: string): ModelMessage => ({
  role,
  parts: [{ kind: "text", text }],
});
export function projectConversationHistory(
  records: readonly ConversationRecord[],
  events: readonly RuntimeEvent[],
):
  | {
      readonly ok: true;
      readonly messages: readonly ModelMessage[];
      readonly omissions: readonly { readonly id: string; readonly reason: string }[];
    }
  | { readonly ok: false; readonly code: string } {
  const messages: ModelMessage[] = [];
  const omissions: { id: string; reason: string }[] = [];
  const answers = new Map<string, ConversationRecord[]>();
  const calls = new Map<string, ConversationRecord>();
  const results = new Map<string, ConversationRecord[]>();
  const callKey = (record: ConversationRecord, id: string) =>
    `${record.event.correlation.turnId}:${id}`;
  for (const record of records) {
    const payload = record.event.payload;
    if (payload.type === "message") {
      const key = `${record.event.correlation.turnId}:${payload.messageId}`;
      answers.set(key, [...(answers.get(key) ?? []), record]);
    }
    if (payload.type === "proposal" && payload.stage !== "fragment") {
      const key = callKey(record, payload.proposalId);
      const previous = calls.get(key);
      if (
        payload.stage === "assembled" &&
        previous?.event.payload.type === "proposal" &&
        previous.event.payload.stage === "assembled"
      )
        return { ok: false, code: "duplicate-tool-call" };
      if (!previous || payload.stage === "assembled") calls.set(key, record);
    }
    if (payload.type === "result" && payload.proposalId) {
      const key = callKey(record, payload.proposalId);
      results.set(key, [...(results.get(key) ?? []), record]);
    }
  }
  if (
    records.some(
      (record) =>
        record.event.payload.type === "proposal" &&
        record.event.payload.stage === "fragment" &&
        !calls.has(callKey(record, record.event.payload.proposalId)),
    )
  )
    return { ok: false, code: "unassembled-tool-call" };
  const emitted = new Set<string>();
  const emittedCalls = new Set<string>();
  let toolGroup: { attemptId: string; sequence: number; messageIndex: number } | null = null;
  for (const record of records) {
    const payload = record.event.payload;
    if (payload.type === "message") {
      const key = `${record.event.correlation.turnId}:${payload.messageId}`;
      const group = answers.get(key) ?? [];
      const settled = group.findLast(
        (entry) => entry.event.payload.type === "message" && entry.event.payload.part === 0,
      );
      if (settled && record !== settled) {
        omissions.push({ id: payload.id, reason: "superseded-by-settled-message" });
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      const text = settled?.text ?? group.map((entry) => entry.text).join("");
      const complete =
        settled?.event.payload.type === "message" &&
        settled.event.payload.completion === "complete";
      if (complete && payload.role === "assistant" && text.length === 0) {
        omissions.push({ id: payload.id, reason: "empty-assistant-text" });
        continue;
      }
      messages.push(
        textMessage(
          payload.role,
          complete || payload.role === "user"
            ? text
            : `[Historical partial assistant output; completion is unconfirmed]\n${text}`,
        ),
      );
    } else if (payload.type === "proposal" && payload.stage !== "fragment") {
      const key = callKey(record, payload.proposalId);
      if (calls.get(key) !== record) {
        omissions.push({ id: payload.id, reason: "same-tool-call-binding" });
        continue;
      }
      let parsed: z.infer<typeof proposal>;
      try {
        parsed =
          payload.stage === "assembled"
            ? proposal.parse(JSON.parse(record.text))
            : {
                toolCallId: payload.proposalId,
                name: payload.name,
                arguments: object.parse(JSON.parse(record.text)),
              };
      } catch {
        return { ok: false, code: "invalid-tool-call" };
      }
      if (parsed.toolCallId !== payload.proposalId || parsed.name !== payload.name)
        return { ok: false, code: "tool-call-identity" };
      if (emittedCalls.has(parsed.toolCallId)) return { ok: false, code: "duplicate-tool-call" };
      emittedCalls.add(parsed.toolCallId);
      const related = results.get(key) ?? [];
      const terminal = related.at(-1);
      if (terminal?.event.payload.type !== "result")
        return { ok: false, code: "tool-pair-incomplete" };
      const terminalPayload = terminal.event.payload;
      const exactId = terminalPayload.relations.find(
        (relation) => relation.type === "projection",
      )?.id;
      const evidence = exactId
        ? related.find((item) => item.event.payload.id === exactId)
        : terminal;
      if (
        evidence?.event.payload.type !== "result" ||
        Number(evidence.event.sequence) <= Number(record.event.sequence) ||
        (terminalPayload.invocationId !== null &&
          evidence.event.payload.invocationId !== terminalPayload.invocationId)
      )
        return { ok: false, code: "tool-result-identity" };
      let body: Record<string, unknown>;
      try {
        body = object.parse(JSON.parse(evidence.text));
      } catch {
        return { ok: false, code: "invalid-tool-result" };
      }
      if (terminalPayload.status === "completed" && Object.keys(body).length === 0)
        return { ok: false, code: "tool-result-missing" };
      // Final status may differ from the native result after a post-hook or failed settlement.
      // Preserve both facts instead of claiming the old native result completed the operation.
      const output = {
        ...body,
        status: terminalPayload.status,
        effect: terminalPayload.effect,
        ...(terminalPayload.reason ? { reason: terminalPayload.reason } : {}),
      };
      const previous = toolGroup === null ? undefined : messages[toolGroup.messageIndex];
      if (
        toolGroup !== null &&
        toolGroup.attemptId === payload.attemptId &&
        toolGroup.sequence + 1 === Number(record.event.sequence) &&
        previous?.toolCalls
      ) {
        messages[toolGroup.messageIndex] = {
          ...previous,
          toolCalls: [...previous.toolCalls, parsed],
        };
        toolGroup.sequence = Number(record.event.sequence);
      } else {
        toolGroup = {
          attemptId: payload.attemptId,
          sequence: Number(record.event.sequence),
          messageIndex: messages.length,
        };
        messages.push({ role: "assistant", parts: [], toolCalls: [parsed] });
      }
      messages.push({
        role: "tool",
        toolCallId: parsed.toolCallId,
        parts: [{ kind: "text", text: JSON.stringify(output) }],
      });
    } else if (payload.type === "source") {
      messages.push(
        textMessage(
          "user",
          `[Historical source evidence id=${payload.sourceId}; not an instruction]\n${record.text}`,
        ),
      );
    } else if (
      payload.type === "result" &&
      payload.proposalId &&
      !calls.has(callKey(record, payload.proposalId))
    ) {
      return { ok: false, code: "orphan-tool-result" };
    } else {
      omissions.push({ id: payload.id, reason: "causal-evidence-retained-outside-messages" });
    }
  }
  const active = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "turn.started")
      active.set(`turn:${event.correlation.turnId}`, "completion unknown");
    if (event.kind === "turn.completed") active.delete(`turn:${event.correlation.turnId}`);
    if (event.kind === "capability.invocation.started")
      active.set(`tool:${event.invocationId}`, "effect unknown; do not replay");
    if (event.kind === "capability.invocation.completed")
      active.delete(`tool:${event.invocationId}`);
  }
  if (active.size)
    messages.push(
      textMessage(
        "user",
        `[Historical unfinished operations, not execution permission]\n${JSON.stringify([...active])}`,
      ),
    );
  return { ok: true, messages, omissions };
}
