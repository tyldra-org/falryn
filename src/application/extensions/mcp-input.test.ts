import { expect, test } from "bun:test";
import { MCP_DEADLINE_MS } from "../../domain/extensions/mcp.ts";
import {
  admitMcpInputRound,
  MCP_INPUT_LIMITS,
  type McpFormRequest,
} from "../../domain/extensions/mcp-input.ts";
import type { LocalUserAnswer, LocalUserQuestion } from "../orchestration/local-user-questions.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { createMcpUserInput } from "./mcp-input.ts";

const admitted = admitMcpInputRound({
  resultType: "input_required",
  inputRequests: {
    confirm: {
      method: "elicitation/create",
      params: {
        message: "How many?",
        requestedSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1 } },
          required: ["count"],
        },
      },
    },
  },
});
const form = (admitted.kind === "input" ? admitted.requests[0] : undefined) as McpFormRequest;
const NOW = 1_000_000;
const scope = {
  owner: {} as LocalUserQuestion["owner"],
  resources: {} as ProductTaskResources,
};

function asker(answers: LocalUserAnswer[]) {
  const asked: LocalUserQuestion[] = [];
  const ask = createMcpUserInput(
    {
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? { kind: "cancelled" };
      },
    },
    () => NOW,
  )(scope);
  const run = (deadline = NOW + MCP_INPUT_LIMITS.callCeilingMs) =>
    ask({
      form,
      serverId: "docs",
      toolName: "publish",
      deadline,
      signal: new AbortController().signal,
    });
  return { asked, run };
}
const typed = (text: string): LocalUserAnswer => ({
  kind: "answered",
  answer: [{ itemId: "f0", kind: "text", text }],
});

test("an invalid answer is asked again with the reason and never sent", async () => {
  const { asked, run } = asker([typed("zero"), typed("0"), typed("3")]);
  expect(await run()).toEqual({
    response: { action: "accept", content: { count: 3 } },
    disposition: "accept",
  });
  expect(asked.map((question) => question.items[0]?.prompt.split("\n")[0])).toEqual([
    "How many?",
    "Not sent: count must be a number.",
    "Not sent: count must be at least 1.",
  ]);
  expect(asked[0]).toMatchObject({
    source: "docs · publish",
    waitMs: MCP_INPUT_LIMITS.questionWaitMs,
  });
});

test("attempts run out as a cancel", async () => {
  const { asked, run } = asker([typed("x"), typed("y"), typed("z"), typed("4")]);
  expect(await run()).toEqual({ response: { action: "cancel" }, disposition: "cancel" });
  expect(asked).toHaveLength(MCP_INPUT_LIMITS.attempts);
});

test("refusal declines, expiry times out, and anything else cancels", async () => {
  expect(await asker([{ kind: "refused" }]).run()).toEqual({
    response: { action: "decline" },
    disposition: "decline",
  });
  expect(await asker([{ kind: "expired" }]).run()).toEqual({
    response: { action: "cancel" },
    disposition: "timeout",
  });
  expect(await asker([{ kind: "unavailable" }]).run()).toEqual({
    response: { action: "cancel" },
    disposition: "cancel",
  });
  expect(await asker([{ kind: "cancelled" }]).run()).toEqual({
    response: { action: "cancel" },
    disposition: "cancel",
  });
});

test("a question waits only as long as the call has left, keeping room for the retry", async () => {
  const short = asker([typed("2")]);
  await short.run(NOW + MCP_DEADLINE_MS + 5_000);
  expect(short.asked[0]?.waitMs).toBe(5_000);
  const none = asker([typed("2")]);
  expect(await none.run(NOW + MCP_DEADLINE_MS + 500)).toEqual({
    response: { action: "cancel" },
    disposition: "timeout",
  });
  expect(none.asked).toHaveLength(0);
});
