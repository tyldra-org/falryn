/** Deterministic protocol peer launched only by the adjacent transport tests. */
const SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";
const catalogResults: Readonly<Record<string, (params: Record<string, unknown>) => unknown>> = {
  // Two pages prove the client walks continuation cursors to one complete list.
  "resources/list": (params) =>
    params.cursor === "page-2"
      ? { resources: [{ uri: "fixture://notes/b", name: "b", mimeType: "text/plain" }] }
      : {
          resources: [{ uri: "fixture://notes/a", name: "a", mimeType: "text/plain" }],
          nextCursor: "page-2",
        },
  "resources/templates/list": () => ({
    resourceTemplates: [
      { uriTemplate: "fixture://notes/{name}", name: "note", mimeType: "text/plain" },
    ],
  }),
  "resources/read": (params) => ({
    contents: [{ uri: params.uri, mimeType: "text/plain", text: `note ${String(params.uri)}\n` }],
  }),
  "prompts/list": () => ({
    prompts: [
      {
        name: "review",
        description: "Review a note",
        arguments: [{ name: "topic", required: true }],
      },
    ],
  }),
  "prompts/get": (params) => ({
    description: "Review a note",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Review ${String((params.arguments as Record<string, unknown>)?.topic)}`,
        },
      },
      { role: "assistant", content: { type: "image", data: "AA==", mimeType: "image/png" } },
    ],
  }),
};
export function mcpFixtureReply(message: Record<string, unknown>) {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const catalog = typeof message.method === "string" ? catalogResults[message.method] : undefined;
  if (catalog)
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        ...(catalog(params) as object),
      },
    };
  const result =
    message.method === "server/discover"
      ? {
          supportedVersions: ["2026-07-28"],
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: { listChanged: true },
          },
          serverInfo: { name: "fixture", version: "1" },
        }
      : message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: fixtureTools }
          : message.method === "tools/call"
            ? toolCall(params)
            : { resultType: "complete" };
  return { jsonrpc: "2.0", id: message.id, result };
}

const fixtureTools = [
  { name: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
  {
    name: "sum",
    title: "Add numbers",
    description: "Add two numbers.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { type: "number", title: "A" }, b: { type: "number", default: 0 } },
      required: ["a", "b"],
    },
    outputSchema: {
      type: "object",
      properties: { sum: { type: "number" } },
      required: ["sum"],
    },
  },
  { name: "fail", description: "Always reports a tool error.", inputSchema: { type: "object" } },
  { name: "ask", description: "Asks the user first.", inputSchema: { type: "object" } },
  { name: "ask-url", description: "Asks for a browser visit.", inputSchema: { type: "object" } },
  {
    name: "ask-sampling",
    description: "Asks for a model sample.",
    inputSchema: { type: "object" },
  },
  { name: "ask-forever", description: "Never stops asking.", inputSchema: { type: "object" } },
  { name: "ask-wide", description: "Asks too many fields.", inputSchema: { type: "object" } },
  {
    name: "union",
    inputSchema: {
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
    },
  },
];
/** The form the `ask` tools request; answers are echoed so tests can see exactly what was sent. */
export const MCP_FIXTURE_FORM = {
  mode: "form",
  message: "Which branch should the release use?",
  requestedSchema: {
    type: "object",
    properties: {
      branch: { type: "string", title: "Branch", enum: ["main", "next"] },
      notify: { type: "boolean", title: "Notify the team" },
    },
    required: ["branch"],
  },
} as const;
const inputRequired = (inputRequests: Record<string, unknown>, requestState?: string) => ({
  resultType: "input_required",
  inputRequests,
  ...(requestState === undefined ? {} : { requestState }),
});
function askCall(name: string, params: Record<string, unknown>) {
  const responses = params.inputResponses as Record<string, unknown> | undefined;
  const state = typeof params.requestState === "string" ? params.requestState : undefined;
  const form = { method: "elicitation/create", params: MCP_FIXTURE_FORM };
  if (name === "ask-url")
    return inputRequired({
      visit: {
        method: "elicitation/create",
        params: {
          mode: "url",
          message: "Sign in to continue.",
          url: "https://example.test/sign-in",
          elicitationId: "sign-in",
        },
      },
    });
  if (name === "ask-sampling")
    return inputRequired({
      sample: {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: "hi" } }],
          maxTokens: 8,
        },
      },
    });
  if (name === "ask-wide")
    return inputRequired({
      wide: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Too many fields.",
          requestedSchema: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 9 }, (_, index) => [`field${index}`, { type: "string" }]),
            ),
          },
        },
      },
    });
  if (name === "ask-forever")
    return inputRequired({ confirm: form }, `round-${Number(state?.slice(6) ?? 0) + 1}`);
  if (responses === undefined) return inputRequired({ confirm: form }, "ask-1");
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify({ requestState: state ?? null, responses }) }],
  };
}
function toolCall(params: Record<string, unknown>) {
  const values = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof params.name === "string" && params.name.startsWith("ask"))
    return askCall(params.name, params);
  if (params.name === "sum") {
    const sum = Number(values.a) + Number(values.b);
    return {
      resultType: "complete",
      content: [{ type: "text", text: String(sum) }],
      structuredContent: { sum },
    };
  }
  if (params.name === "fail")
    return {
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: "bad input" }],
    };
  return {
    resultType: "complete",
    content: [
      { type: "text", text: params.name === "pid" ? String(process.pid) : JSON.stringify(values) },
    ],
  };
}

const hookBinding = {
  type: "object",
  additionalProperties: false,
  required: [
    "factId",
    "subjectId",
    "ownerGeneration",
    "configurationGeneration",
    "registrationGeneration",
    "payloadDigest",
  ],
  properties: {
    factId: { type: "string" },
    subjectId: { type: "string" },
    ownerGeneration: { type: "integer" },
    configurationGeneration: { type: "integer" },
    registrationGeneration: { type: "integer" },
    payloadDigest: { type: "string" },
  },
};
/** The closed input every hook decision tool takes: the binding and the subject capability. */
export const MCP_HOOK_FIXTURE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["binding", "capability"],
  properties: { binding: hookBinding, capability: { type: "string" } },
} as const;
/**
 * Decision tools for package MCP tool hooks (#1174), served only in the hook modes:
 * allow observes, veto echoes its binding, text answers only in prose and refuse is a
 * tool error whose structured result would otherwise allow.
 */
const hookTools = ["allow", "veto", "text", "refuse"].map((name) => ({
  name,
  inputSchema: MCP_HOOK_FIXTURE_INPUT,
}));
function hookToolCall(params: Record<string, unknown>) {
  const values = (params.arguments ?? {}) as Record<string, unknown>;
  const observe = { decision: { kind: "observe", annotations: { mcp: "ok" } } };
  const text = { type: "text", text: JSON.stringify(observe) };
  if (params.name === "veto")
    return {
      resultType: "complete",
      content: [text],
      structuredContent: {
        decision: { kind: "veto", binding: values.binding, reason: "mcp-veto" },
      },
    };
  if (params.name === "text") return { resultType: "complete", content: [text] };
  return {
    resultType: "complete",
    ...(params.name === "refuse" ? { isError: true } : {}),
    content: [text],
    structuredContent: observe,
  };
}
function hookFixtureReply(message: Record<string, unknown>) {
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (message.method === "tools/list")
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: hookTools },
    };
  if (message.method === "tools/call")
    return { jsonrpc: "2.0", id: message.id, result: hookToolCall(params) };
  return mcpFixtureReply(message);
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "stderr") process.stderr.write("s".repeat(300 * 1024));
  if (mode === "malformed") process.stdout.write("not json\n");
  if (mode === "oversized") process.stdout.write("x".repeat(1024 * 1024 + 1));
  let pending = "";
  let serverRequestDenied = "not-observed";
  // A current-protocol subscription stays open; notifications carry its listen request id.
  let listen: unknown = null;
  const notify = (method: string) =>
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: listen === null ? {} : { _meta: { [SUBSCRIPTION]: listen } },
      })}\n`,
    );
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.method !== "string") {
        if (message.id === "server-ask") serverRequestDenied = String(Boolean(message.error));
        continue;
      }
      if (!("id" in message) || mode === "silent") continue;
      if (message.method === "subscriptions/listen") {
        listen = message.id;
        const params = (message.params ?? {}) as Record<string, unknown>;
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: {
              notifications: params.notifications ?? {},
              _meta: { [SUBSCRIPTION]: listen },
            },
          })}\n`,
        );
        continue;
      }
      if (mode === "disconnect" && message.method === "tools/call") process.exit(0);
      if (mode === "hooks-disconnect" && message.method === "tools/call") process.exit(0);
      if (mode === "pending" && message.method === "tools/call") continue;
      const response = mode?.startsWith("hooks")
        ? hookFixtureReply(message)
        : mcpFixtureReply(message);
      if (mode === "unsolicited" && message.method === "tools/call")
        response.result = {
          resultType: "complete",
          content: [{ type: "text", text: String(serverRequestDenied) }],
        };
      if (mode === "environment" && message.method === "tools/call")
        response.result = {
          resultType: "complete",
          content: [{ type: "text", text: JSON.stringify(process.env) }],
        };
      if (mode === "partial") {
        const frame = `${JSON.stringify(response)}\n`;
        const middle = Math.floor(frame.length / 2);
        process.stdout.write(frame.slice(0, middle));
        await new Promise((resolve) => setTimeout(resolve, 5));
        process.stdout.write(frame.slice(middle));
        continue;
      }
      if (mode === "delayed" && message.method === "tools/call")
        setTimeout(() => process.stdout.write(`${JSON.stringify(response)}\n`), 200);
      else process.stdout.write(`${JSON.stringify(response)}\n`);
      if (mode === "catalog-change" && message.method === "tools/call")
        notify("notifications/resources/list_changed");
      if (mode === "unsolicited" && message.method === "ping") {
        notify("notifications/tools/list_changed");
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: "server-ask", method: "roots/list", params: {} })}\n`,
        );
      }
    }
  }
}
