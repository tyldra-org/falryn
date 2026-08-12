import { describe, expect, test } from "bun:test";

import { modelAttemptId } from "../domain/identity.ts";
import { modelRequestId } from "./identity.ts";
import type { NormalizedProviderEvent } from "./stream.ts";
import { normalizeProviderStream, ProviderStreamAssembler } from "./stream-assembly.ts";

const requestId = modelRequestId.from("req-stream-1");
const attemptId = modelAttemptId.from("attempt-stream-1");

function spine(
  sequence: number,
): Pick<NormalizedProviderEvent, "requestId" | "modelAttemptId" | "sequence"> {
  return { requestId, modelAttemptId: attemptId, sequence };
}

describe("ProviderStreamAssembler", () => {
  test("assembles fragmented text and reasoning then finishes", () => {
    const assembler = new ProviderStreamAssembler();
    expect(assembler.push({ ...spine(1), kind: "request-started" }).kind).toBe("emit");
    expect(assembler.push({ ...spine(2), kind: "text-delta", text: "hel" }).kind).toBe("emit");
    expect(assembler.push({ ...spine(3), kind: "text-delta", text: "lo" }).kind).toBe("emit");
    expect(assembler.push({ ...spine(4), kind: "reasoning-delta", text: "think" }).kind).toBe(
      "emit",
    );
    const terminal = assembler.push({
      ...spine(5),
      kind: "finished",
      finishReason: "stop",
    });
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind === "terminal") {
      expect(terminal.terminal.kind).toBe("finished");
      expect(terminal.terminal.snapshot.text).toBe("hello");
      expect(terminal.terminal.snapshot.reasoning).toBe("think");
      expect(terminal.terminal.snapshot.usage).toBeNull();
    }
  });

  test("assembles tool-call deltas into a validated proposal", () => {
    const assembler = new ProviderStreamAssembler();
    assembler.push({ ...spine(1), kind: "request-started" });
    assembler.push({
      ...spine(2),
      kind: "tool-call-delta",
      toolCallId: "call-1",
      name: "read_file",
      argumentsFragment: '{"path":',
    });
    assembler.push({
      ...spine(3),
      kind: "tool-call-delta",
      toolCallId: "call-1",
      argumentsFragment: '"a.ts"}',
    });
    const step = assembler.push({
      ...spine(4),
      kind: "tool-proposal",
      toolCallId: "call-1",
      name: "read_file",
      argumentsJson: "{}",
    });
    expect(step.kind).toBe("emit");
    if (step.kind === "emit") {
      expect(step.snapshot.toolProposals).toHaveLength(1);
      expect(step.snapshot.toolProposals[0]?.arguments).toEqual({ path: "a.ts" });
      expect(JSON.stringify(step.snapshot)).not.toContain("secret");
    }
  });

  test("rejects a sequence gap without echoing payload text", () => {
    const assembler = new ProviderStreamAssembler();
    assembler.push({ ...spine(1), kind: "request-started" });
    const step = assembler.push({
      ...spine(3),
      kind: "text-delta",
      text: "sk-should-not-leak",
    });
    expect(step.kind).toBe("terminal");
    if (step.kind === "terminal" && step.terminal.kind === "failed") {
      expect(step.terminal.failure.kind).toBe("malformed-stream");
      expect(step.terminal.snapshot.diagnostics[0]?.code).toBe("sequence-gap");
      expect(JSON.stringify(step.terminal)).not.toContain("sk-should-not-leak");
    }
  });

  test("rejects duplicate terminal finished events", () => {
    const assembler = new ProviderStreamAssembler();
    assembler.push({ ...spine(1), kind: "request-started" });
    const first = assembler.push({ ...spine(2), kind: "finished", finishReason: "stop" });
    expect(first.kind).toBe("terminal");
    const second = assembler.push({ ...spine(3), kind: "finished", finishReason: "stop" });
    expect(second.kind).toBe("terminal");
    if (second.kind === "terminal" && second.terminal.kind === "failed") {
      expect(
        second.terminal.snapshot.diagnostics.some((d) => d.code === "event-after-terminal"),
      ).toBe(true);
    }
  });

  test("rejects malformed tool JSON on proposal", () => {
    const assembler = new ProviderStreamAssembler();
    assembler.push({ ...spine(1), kind: "request-started" });
    const step = assembler.push({
      ...spine(2),
      kind: "tool-proposal",
      toolCallId: "call-2",
      name: "edit",
      argumentsJson: "not-json",
    });
    expect(step.kind).toBe("terminal");
    if (step.kind === "terminal" && step.terminal.kind === "failed") {
      expect(step.terminal.snapshot.diagnostics[0]?.code).toBe("tool-arguments-invalid-json");
    }
  });

  test("preserves usage provenance and does not invent zeros", () => {
    const assembler = new ProviderStreamAssembler();
    assembler.push({ ...spine(1), kind: "request-started" });
    expect(assembler.snapshot().usage).toBeNull();
    assembler.push({
      ...spine(2),
      kind: "usage",
      usage: { provenance: "provider-reported", outputTokens: 4 },
    });
    expect(assembler.snapshot().usage).toEqual({
      provenance: "provider-reported",
      outputTokens: 4,
    });
  });
});

describe("normalizeProviderStream", () => {
  test("returns finished terminal for a complete async stream", async () => {
    async function* events(): AsyncIterable<NormalizedProviderEvent> {
      yield { ...spine(1), kind: "request-started" };
      yield { ...spine(2), kind: "text-delta", text: "ok" };
      yield { ...spine(3), kind: "finished", finishReason: "stop" };
    }
    const seen: string[] = [];
    const iterator = normalizeProviderStream(events());
    let result = await iterator.next();
    while (!result.done) {
      seen.push(result.value.event.kind);
      result = await iterator.next();
    }
    expect(seen).toEqual(["request-started", "text-delta", "finished"]);
    expect(result.value.kind).toBe("finished");
  });

  test("fails when the stream ends without a terminal event", async () => {
    async function* events(): AsyncIterable<NormalizedProviderEvent> {
      yield { ...spine(1), kind: "request-started" };
    }
    const iterator = normalizeProviderStream(events());
    let result = await iterator.next();
    while (!result.done) {
      result = await iterator.next();
    }
    expect(result.value.kind).toBe("failed");
    if (result.value.kind === "failed") {
      expect(result.value.snapshot.diagnostics.some((d) => d.code === "missing-terminal")).toBe(
        true,
      );
    }
  });
});
