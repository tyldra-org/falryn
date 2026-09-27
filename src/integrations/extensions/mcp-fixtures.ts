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
          ? {
              resultType: "complete",
              ttlMs: 0,
              cacheScope: "private",
              tools: [
                {
                  name: "echo",
                  inputSchema: { type: "object", properties: { value: { type: "string" } } },
                },
              ],
            }
          : message.method === "tools/call"
            ? {
                resultType: "complete",
                content: [
                  {
                    type: "text",
                    text:
                      params.name === "pid"
                        ? String(process.pid)
                        : JSON.stringify(params.arguments ?? {}),
                  },
                ],
              }
            : { resultType: "complete" };
  return { jsonrpc: "2.0", id: message.id, result };
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
      if (mode === "pending" && message.method === "tools/call") continue;
      const response = mcpFixtureReply(message);
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
