/**
 * Cold MCP discovery relevance (#1157).
 *
 * A configured server that was never queried is `unknown`, not empty. Before a turn the
 * host may prepare a relevant server; this module owns the deterministic relevance rule.
 * The receipt and limits live in `mcp-preparation-receipt.ts`. It performs no I/O.
 */
import type { McpConnection } from "./mcp.ts";
import { MCP_PREPARATION_LIMITS } from "./mcp-preparation-receipt.ts";

/** Words too generic to make a server relevant on their own. */
const GENERIC = new Set([
  "mcp",
  "server",
  "servers",
  "tool",
  "tools",
  "api",
  "www",
  "com",
  "org",
  "net",
  "dev",
  "app",
  "localhost",
  "local",
  "http",
  "https",
  "bin",
  "node",
  "bun",
  "npx",
  "bunx",
  "uvx",
  "deno",
  "python",
  "python3",
  "exe",
  "the",
  "and",
]);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter(
    (word) => word.length >= 3 && !GENERIC.has(word),
  );
}

function basename(value: string): string {
  const last = value.split(/[\\/]/u).at(-1) ?? "";
  return last.replace(/\.[a-z0-9]{1,5}$/iu, "");
}

/**
 * The bounded, untrusted words a connection is known by: its ID, its HTTP host labels, or
 * its stdio executable and leading argument names. Nothing is read from the server.
 */
export function mcpConnectionSummary(connection: McpConnection): readonly string[] {
  const parts = [connection.id];
  if (connection.transport === "http") {
    try {
      const host = new URL(connection.url).hostname;
      const labels = host.split(".");
      parts.push(...(labels.length > 1 ? labels.slice(0, -1) : labels));
    } catch {
      // The schema already rejects an unparseable URL.
    }
  } else {
    parts.push(basename(connection.executable), ...connection.args.slice(0, 4).map(basename));
  }
  return [...new Set(parts.flatMap(words))].slice(0, MCP_PREPARATION_LIMITS.summaryTokens);
}

/** A server is relevant when the task names one of its summary words. */
export function mcpServerRelevant(connection: McpConnection, task: string): boolean {
  const taskWords = new Set(words(task));
  return mcpConnectionSummary(connection).some((word) => taskWords.has(word));
}
