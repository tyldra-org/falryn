/** Bounded capture ahead of provider assembly, preserving provider sequence order. */
import type { TurnId } from "../../domain/foundation/index.ts";
import type { NormalizedProviderEvent } from "../../providers/index.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { historyDigest, type SessionHistory } from "./session-history.ts";

export const providerHistoryIdentity = (value: string) =>
  /^[A-Za-z0-9._:@/-]{1,256}$/u.test(value) ? value : `withheld-${historyDigest(value).slice(8)}`;
export async function* recordProviderHistory(options: {
  readonly events: AsyncIterable<NormalizedProviderEvent>;
  readonly admittedSignal?: AbortSignal;
  readonly onProposal?: (id: string) => void;
  readonly history: SessionHistory;
  readonly resources: ProductTaskResources;
  readonly turnId: TurnId;
  readonly attemptId: string;
  readonly request: number;
  readonly generation: number;
  readonly catalogGeneration: number;
  readonly disclosureDigest: string;
}): AsyncGenerator<NormalizedProviderEvent> {
  let pending: NormalizedProviderEvent[] = [];
  let bytes = 0;
  const key = (event: NormalizedProviderEvent) =>
    event.kind === "text-delta"
      ? "text"
      : event.kind === "tool-call-delta" || event.kind === "tool-proposal"
        ? `proposal:${event.toolCallId}`
        : null;
  const record: SessionHistory["record"] = (turnId, metadata, text, resources) =>
    options.admittedSignal
      ? options.history.recordWithinAdmission(
          turnId,
          metadata,
          text,
          // The provider reservation remains held through generator cleanup.
          // Cancellation stops new input; already observed bytes get bounded settlement.
          options.admittedSignal.aborted ? AbortSignal.timeout(30000) : options.admittedSignal,
        )
      : options.history.record(turnId, metadata, text, resources);
  async function capture() {
    const batch = pending;
    if (batch.length === 0) return batch;
    pending = [];
    bytes = 0;
    const first = batch[0];
    if (!first) return batch;
    const id = `${options.attemptId}:request:${options.request}:capture:${first.sequence}`;
    const common = { version: 1 as const, id, generation: options.generation };
    if (first.kind === "text-delta") {
      const text = batch.map((event) => (event.kind === "text-delta" ? event.text : "")).join("");
      const captured = await record(
        options.turnId,
        {
          ...common,
          type: "message",
          messageId: `${options.attemptId}:response:${options.request}`,
          part: first.sequence,
          role: "assistant",
          attemptId: options.attemptId,
          completion: "partial",
          relations: [],
        },
        text,
        options.resources,
      );
      if (!captured.committed || captured.evidence.availability === "unavailable")
        throw new Error("resource-admission:history-stream-unavailable");
    } else if (first.kind === "tool-proposal" || first.kind === "tool-call-delta") {
      options.onProposal?.(providerHistoryIdentity(first.toolCallId));
      const text = JSON.stringify(batch);
      const captured = await record(
        options.turnId,
        {
          ...common,
          type: "proposal",
          stage: "fragment",
          inputDigest: historyDigest(text),
          attemptId: options.attemptId,
          proposalId: providerHistoryIdentity(first.toolCallId),
          invocationId: null,
          name: providerHistoryIdentity(first.name ?? "unassembled"),
          catalogGeneration: options.catalogGeneration,
          policyGeneration: options.generation,
          disclosureDigest: options.disclosureDigest,
        },
        text,
        options.resources,
      );
      if (!captured.committed || captured.evidence.availability === "unavailable")
        throw new Error("resource-admission:history-proposal-unavailable");
    }
    return batch;
  }
  try {
    for await (const event of options.events) {
      const group = key(event);
      const first = pending[0];
      if (first && key(first) !== group) for (const ready of await capture()) yield ready;
      if (group === null) {
        yield event;
        continue;
      }
      pending.push(event);
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (pending.length >= 32 || bytes >= 16 * 1024)
        for (const ready of await capture()) yield ready;
    }
    for (const ready of await capture()) yield ready;
  } finally {
    // An interrupted stream can leave a final observed batch. Retain it without
    // publishing more provider events or treating it as a completed response.
    await capture();
  }
}
