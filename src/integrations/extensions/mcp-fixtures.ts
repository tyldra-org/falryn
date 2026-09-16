/** Deterministic protocol peer launched only by the adjacent transport tests. */
export function mcpFixtureReply(message: Record<string, unknown>) {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const result =
    message.method === "server/discover"
      ? {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, resources: {}, prompts: {} },
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
      if (mode === "unsolicited" && message.method === "ping") {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
        );
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: "server-ask", method: "roots/list", params: {} })}\n`,
        );
      }
    }
  }
}
