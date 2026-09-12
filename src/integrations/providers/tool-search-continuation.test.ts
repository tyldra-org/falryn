import { expect, test } from "bun:test";
import { parseRetainedContinuation as anthropic } from "./anthropic-sdk-adapter/continuation.ts";
import { parseRetainedContinuation as responses } from "./openai-responses-sdk-adapter/continuation.ts";

const responseCall = {
  type: "tool_search_call",
  id: "search-1",
  call_id: null,
  arguments: {},
  execution: "server",
  status: "completed",
};
const responseOutput = {
  type: "tool_search_output",
  id: "output-1",
  call_id: null,
  tools: [],
  execution: "server",
  status: "completed",
};
const anthropicCall = {
  type: "server_tool_use",
  id: "search-1",
  input: {},
  name: "tool_search_tool_bm25",
};
const anthropicOutput = {
  type: "tool_search_tool_result",
  tool_use_id: "search-1",
  content: { type: "tool_search_tool_search_result", tool_references: [] },
};

test("retained search validates pairing, completion, bounds and old continuation compatibility", () => {
  const openai = (search: unknown) =>
    responses(
      JSON.stringify({ schemaVersion: 1, responseId: "response-1", reasoning: [], search }),
    );
  const claude = (search: unknown) => anthropic(JSON.stringify({ thinking: [], search }));
  expect(
    responses(JSON.stringify({ schemaVersion: 1, responseId: "old", reasoning: [] })),
  ).not.toBeNull();
  expect(anthropic(JSON.stringify({ thinking: [] }))).not.toBeNull();
  expect(openai([responseCall, responseOutput])).not.toBeNull();
  expect(claude([anthropicCall, anthropicOutput])).not.toBeNull();
  for (const invalid of [
    [responseOutput],
    [responseCall],
    [responseCall, responseCall, responseOutput],
    [{ ...responseCall, status: "in_progress" }, responseOutput],
    Array(129).fill(responseCall),
  ])
    expect(openai(invalid)).toBeNull();
  for (const invalid of [
    [anthropicOutput],
    [anthropicCall],
    [anthropicCall, { ...anthropicOutput, tool_use_id: "foreign" }],
    Array(129).fill(anthropicCall),
  ])
    expect(claude(invalid)).toBeNull();
  expect(
    openai([{ ...responseCall, arguments: "x".repeat(4 * 1024 * 1024) }, responseOutput]),
  ).toBeNull();
});
