import { describe, expect, test } from "bun:test";
import { modelAttemptId } from "../domain/identity.ts";
import { modelRequestId } from "./identity.ts";
import {
  createDeterministicProviderAdapter,
  deterministicEchoRequest,
  isModelRole,
  isTerminalProviderEvent,
  MODEL_ROLES,
  PROVIDER_BOUNDARY_SCHEMA_VERSION,
  PROVIDER_EVENT_KINDS,
  parseModelRequest,
  parseNormalizedProviderEvent,
  redactProviderDiagnosticText,
} from "./index.ts";

describe("provider roles and event vocabulary", () => {
  test("exposes the closed public role set", () => {
    expect(MODEL_ROLES).toContain("default");
    expect(isModelRole("default")).toBe(true);
    expect(isModelRole("fallback")).toBe(false);
  });

  test("names every normalized stream kind", () => {
    expect(PROVIDER_EVENT_KINDS).toEqual([
      "request-started",
      "text-delta",
      "reasoning-delta",
      "tool-call-delta",
      "tool-proposal",
      "usage",
      "provider-metadata",
      "finished",
      "error",
    ]);
  });
});

describe("parseModelRequest", () => {
  test("accepts a minimal valid request", () => {
    const parsed = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-1",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.requestId).toBe(modelRequestId.from("req-1"));
      expect(parsed.value.messages).toHaveLength(1);
    }
  });

  test("rejects unknown fields and oversized text without echoing the payload", () => {
    const parsed = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-2",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [{ role: "user", parts: [{ kind: "text", text: "secret-sk-abcdefghijklmnop" }] }],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
      apiKey: "sk-abcdefghijklmnop",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const serialized = JSON.stringify(parsed.error);
      expect(serialized).not.toContain("sk-abcdefghijklmnop");
      expect(parsed.error.issues.some((issue) => issue.code.length > 0)).toBe(true);
    }
  });

  test("rejects an empty message list", () => {
    const parsed = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-3",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    });
    expect(parsed.ok).toBe(false);
  });

  test("accepts an assistant tool call followed by its result", () => {
    const parsed = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-tool-1",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "read a.ts" }] },
        {
          role: "assistant",
          parts: [{ kind: "text", text: "" }],
          toolCalls: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          parts: [{ kind: "text", text: '{"status":"completed"}' }],
        },
      ],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    });
    expect(parsed.ok).toBe(true);
  });

  test("rejects an orphaned tool result", () => {
    const parsed = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-tool-2",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [
        {
          role: "tool",
          toolCallId: "call-missing",
          parts: [{ kind: "text", text: "{}" }],
        },
      ],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    });
    expect(parsed.ok).toBe(false);
  });

  test("rejects a provider call id reused after its result", () => {
    const parsed = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-tool-reused",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "read twice" }] },
        {
          role: "assistant",
          parts: [{ kind: "text", text: "" }],
          toolCalls: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
        },
        { role: "tool", toolCallId: "call-1", parts: [{ kind: "text", text: "{}" }] },
        {
          role: "assistant",
          parts: [{ kind: "text", text: "" }],
          toolCalls: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "b.ts" } }],
        },
      ],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    });

    expect(parsed.ok).toBe(false);
  });
});

describe("parseNormalizedProviderEvent", () => {
  test("accepts ordered terminal finished events", () => {
    const parsed = parseNormalizedProviderEvent({
      kind: "finished",
      requestId: "req-1",
      modelAttemptId: "attempt-1",
      sequence: 3,
      finishReason: "stop",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isTerminalProviderEvent(parsed.value)).toBe(true);
      expect(parsed.value.modelAttemptId).toBe(modelAttemptId.from("attempt-1"));
    }
  });

  test("rejects a second-shape unknown kind", () => {
    const parsed = parseNormalizedProviderEvent({
      kind: "billing-surprise",
      requestId: "req-1",
      modelAttemptId: "attempt-1",
      sequence: 1,
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("redactProviderDiagnosticText", () => {
  test("strips bearer tokens and api key assignments", () => {
    expect(redactProviderDiagnosticText("Authorization: Bearer abc.def")).toBe("[redacted]");
    expect(redactProviderDiagnosticText("api_key=sk-live-12345678")).toBe("[redacted]");
    expect(redactProviderDiagnosticText("ordinary status text")).toBe("ordinary status text");
  });
});

describe("deterministic provider adapter", () => {
  test("streams started, text, usage, and finished for a successful script", async () => {
    const adapter = createDeterministicProviderAdapter();
    const events = [];
    for await (const event of adapter.stream(deterministicEchoRequest("ping"), {
      signal: new AbortController().signal,
    })) {
      events.push(event.kind);
    }
    expect(events).toEqual(["request-started", "text-delta", "usage", "finished"]);
  });

  test("emits cancellation when the signal is already aborted", async () => {
    const adapter = createDeterministicProviderAdapter();
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of adapter.stream(deterministicEchoRequest(), {
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.kind)).toEqual(["request-started", "error"]);
    const terminal = events[1];
    expect(terminal?.kind).toBe("error");
    if (terminal?.kind === "error") {
      expect(terminal.failure.kind).toBe("cancellation");
    }
  });

  test("emits a scripted error without network", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: { kind: "error", message: "upstream unavailable", retryable: true },
    });
    const events = [];
    for await (const event of adapter.stream(deterministicEchoRequest(), {
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events.at(-1)?.kind).toBe("error");
  });
});
