import { describe, expect, test } from "bun:test";
import {
  admitMcpInputRound,
  type McpFormRequest,
  mcpFormContent,
  mcpFormItems,
} from "./mcp-input.ts";

const form = (requestedSchema: unknown, message = "Which branch?") => ({
  method: "elicitation/create",
  params: { mode: "form", message, requestedSchema },
});
const round = (inputRequests: Record<string, unknown>, requestState?: string) => ({
  resultType: "input_required",
  inputRequests,
  ...(requestState === undefined ? {} : { requestState }),
});
const RELEASE = {
  type: "object",
  properties: {
    branch: { type: "string", title: "Branch", enum: ["main", "next"], default: "main" },
    notify: { type: "boolean", title: "Notify the team" },
  },
  required: ["branch"],
};
function admitted(schema: unknown, message?: string): McpFormRequest {
  const result = admitMcpInputRound(round({ confirm: form(schema, message) }, "state-1"));
  if (result.kind !== "input") throw new Error(`not admitted: ${JSON.stringify(result)}`);
  const [request] = result.requests;
  if (!request) throw new Error("missing request");
  return request;
}

describe("admitting an input round", () => {
  test("a complete result is not an input round", () => {
    expect(admitMcpInputRound({ content: [] })).toEqual({ kind: "complete" });
    expect(admitMcpInputRound({ resultType: "complete", content: [] })).toEqual({
      kind: "complete",
    });
  });

  test("a form request is admitted with its state, fields and schema digest", () => {
    const result = admitMcpInputRound(round({ confirm: form(RELEASE) }, "state-1"));
    expect(result).toMatchObject({
      kind: "input",
      requestState: "state-1",
      requests: [
        {
          key: "confirm",
          message: "Which branch?",
          fields: [
            { kind: "choice", name: "branch", required: true, default: "main" },
            { kind: "choice", name: "notify", required: false, default: null },
          ],
        },
      ],
    });
    const again = admitMcpInputRound(round({ confirm: form(RELEASE) }));
    expect(result.kind === "input" && again.kind === "input").toBe(true);
    if (result.kind === "input" && again.kind === "input")
      expect(result.requests[0]?.schemaDigest).toBe(again.requests[0]?.schemaDigest ?? "");
  });

  test("anything outside the supported form subset is refused, never approximated", () => {
    const refused = { kind: "unsupported", code: "mcp-input-request-unsupported" } as const;
    const wide = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`f${index}`, { type: "string" }]),
    );
    const cases: unknown[] = [
      round({
        visit: {
          method: "elicitation/create",
          params: {
            mode: "url",
            message: "Sign in",
            url: "https://example.test",
            elicitationId: "a",
          },
        },
      }),
      round({
        sample: { method: "sampling/createMessage", params: { messages: [], maxTokens: 1 } },
      }),
      round({ roots: { method: "roots/list", params: {} } }),
      round({
        a: form(RELEASE),
        b: form(RELEASE),
        c: form(RELEASE),
        d: form(RELEASE),
        e: form(RELEASE),
      }),
      round({ wide: form({ type: "object", properties: wide }) }),
      round({
        pattern: form({ type: "object", properties: { a: { type: "string", pattern: ".*" } } }),
      }),
      round({ nested: form({ type: "object", properties: { a: { type: "object" } } }) }),
      round({ missing: form({ type: "object", properties: {}, required: ["ghost"] }) }),
      round({ long: form({ type: "object", properties: {} }, "x".repeat(8193)) }),
      round({
        crowded: form({
          type: "object",
          properties: {
            pick: { type: "string", enum: Array.from({ length: 32 }, (_, index) => String(index)) },
          },
        }),
      }),
      round({
        bounds: form({
          type: "object",
          properties: { n: { type: "number", minimum: 5, maximum: 1 } },
        }),
      }),
      round({ "bad\u0001key": form(RELEASE) }),
    ];
    for (const value of cases) expect(admitMcpInputRound(value)).toEqual(refused);
    expect(admitMcpInputRound({ resultType: "input_required" })).toEqual({
      kind: "unsupported",
      code: "mcp-input-result-malformed",
    });
  });

  test("a state-only round is admitted with no requests to answer", () => {
    expect(admitMcpInputRound({ resultType: "input_required", requestState: "s" })).toEqual({
      kind: "input",
      requests: [],
      requestState: "s",
    });
  });
});

describe("presenting a form as a question", () => {
  test("the message leads the first item and suggestions are labelled, not applied", () => {
    const items = mcpFormItems(admitted(RELEASE), null);
    expect(items).toMatchObject([
      {
        id: "f0",
        kind: "single-select",
        options: [
          { id: "o0", label: "main" },
          { id: "o1", label: "next" },
        ],
      },
      {
        id: "f1",
        kind: "single-select",
        options: [
          { id: "o0", label: "Yes" },
          { id: "o1", label: "No" },
          { id: "skip", label: "Skip" },
        ],
      },
    ]);
    expect(items[0]?.prompt).toBe("Which branch?\n\nBranch\nServer suggestion (not applied): main");
    expect(items[1]?.prompt).toBe("Notify the team (optional)");
  });

  test("a form without fields is a review of the message", () => {
    const request = admitted({ type: "object", properties: {} }, "Continue?");
    expect(mcpFormItems(request, null)).toEqual([
      { id: "message", kind: "review", prompt: "Continue?" },
    ]);
    expect(
      mcpFormContent(request, [{ itemId: "message", kind: "review", acknowledged: true }]),
    ).toEqual({
      ok: true,
      content: {},
    });
  });

  test("a re-asked question says why the last answer was not sent", () => {
    const [first] = mcpFormItems(admitted(RELEASE), "Not sent: Branch needs one choice.");
    expect(first?.prompt.startsWith("Not sent: Branch needs one choice.\n\nWhich branch?")).toBe(
      true,
    );
  });
});

describe("answer content", () => {
  test("choices map back to their values and a skipped optional field is omitted", () => {
    const request = admitted(RELEASE);
    expect(
      mcpFormContent(request, [
        { itemId: "f0", kind: "selection", optionIds: ["o1"] },
        { itemId: "f1", kind: "selection", optionIds: ["skip"] },
      ]),
    ).toEqual({ ok: true, content: { branch: "next" } });
    expect(
      mcpFormContent(request, [
        { itemId: "f0", kind: "selection", optionIds: ["o0"] },
        { itemId: "f1", kind: "selection", optionIds: ["o1"] },
      ]),
    ).toEqual({ ok: true, content: { branch: "main", notify: false } });
    expect(
      mcpFormContent(request, [
        { itemId: "f0", kind: "selection", optionIds: ["skip"] },
        { itemId: "f1", kind: "selection", optionIds: ["o0"] },
      ]),
    ).toEqual({ ok: false, problem: "Not sent: Branch needs one choice." });
  });

  test("text is validated after entry against length, format and numeric bounds", () => {
    const request = admitted({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        name: { type: "string", minLength: 2, maxLength: 4 },
        count: { type: "integer", minimum: 1, maximum: 5 },
        ratio: { type: "number" },
        when: { type: "string", format: "date" },
      },
      required: ["email", "count"],
    });
    const text = (values: string[]) =>
      values.map((value, index) => ({ itemId: `f${index}`, kind: "text" as const, text: value }));
    expect(mcpFormContent(request, text(["a@b.co", "Ada", "3", "0.5", "2026-01-31"]))).toEqual({
      ok: true,
      content: { email: "a@b.co", name: "Ada", count: 3, ratio: 0.5, when: "2026-01-31" },
    });
    expect(mcpFormContent(request, text(["a@b.co", "", "2", "", ""]))).toEqual({
      ok: true,
      content: { email: "a@b.co", count: 2 },
    });
    expect(mcpFormContent(request, text(["nope", "A", "2.5", "x", "31/01/2026"]))).toEqual({
      ok: false,
      problem:
        "Not sent: email must be an email address; name needs at least 2 characters; count must be a whole number; ratio must be a number; when must be a date like 2026-01-31.",
    });
    expect(mcpFormContent(request, text(["", "", "9", "", ""]))).toEqual({
      ok: false,
      problem: "Not sent: email is required; count must be at most 5.",
    });
  });

  test("multi-select keeps the server's order and its bounds once anything is chosen", () => {
    const request = admitted({
      type: "object",
      properties: {
        platforms: {
          type: "array",
          items: {
            anyOf: [
              { const: "mac", title: "macOS" },
              { const: "linux", title: "Linux" },
              { const: "win", title: "Windows" },
            ],
          },
          minItems: 2,
          maxItems: 2,
        },
      },
    });
    expect(mcpFormItems(request, null)[0]).toMatchObject({
      kind: "multi-select",
      minimum: 0,
      maximum: 2,
    });
    const pick = (ids: string[]) =>
      mcpFormContent(request, [{ itemId: "f0", kind: "selection", optionIds: ids }]);
    expect(pick(["o2", "o0"])).toEqual({ ok: true, content: { platforms: ["mac", "win"] } });
    expect(pick([])).toEqual({ ok: true, content: {} });
    expect(pick(["o1"])).toEqual({ ok: false, problem: "Not sent: platforms needs 2 choices." });
    expect(pick(["o9"])).toEqual({
      ok: false,
      problem: "Not sent: platforms has an unknown choice.",
    });
  });
});
