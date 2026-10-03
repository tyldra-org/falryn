/**
 * Cold MCP discovery planning and catalog-tool accounting (#1157).
 *
 * A configured server that was never queried is `unknown`, not empty. Before a turn the
 * host may prepare a relevant server; this module owns the deterministic relevance rule,
 * the limits and the receipt every attempt records. It performs no I/O.
 */
import { z } from "zod";
import type { McpConnection } from "./mcp.ts";

export const MCP_PREPARATION_LIMITS = {
  /** Servers prepared (connected and/or discovered) for one turn. */
  serversPerTurn: 2,
  /** One deadline for all preparation in a turn. */
  deadlineMs: 30_000,
  /** Untrusted summary tokens compared with the task per server. */
  summaryTokens: 32,
  /** Catalog tools published into one registry. */
  publishedTools: 64,
  /** Server rows one receipt keeps; configuration allows at most 64 servers. */
  servers: 64,
} as const;

export const MCP_PREPARATION_DECISIONS = ["reused", "prepared", "failed", "skipped"] as const;
export type McpPreparationDecision = (typeof MCP_PREPARATION_DECISIONS)[number];

export type McpPreparationServer = {
  readonly serverId: string;
  readonly decision: McpPreparationDecision;
  /** Why a server was skipped or failed; null when reused or prepared. */
  readonly reason: string | null;
  /** Host-issued admission origin of preparation work; null when none was attempted. */
  readonly origin: "discovery" | "user" | null;
  /** Catalog list requests sent while preparing. */
  readonly discoveryRequests: number;
  /** New transports opened while preparing; stdio transports are process starts. */
  readonly transportStarts: number;
  readonly processStarts: number;
  /** The catalog generation the turn can use; null when the catalog is not current. */
  readonly catalogGeneration: number | null;
};

export type McpCatalogToolCounts = {
  /** Catalog tools published into this turn's registry. */
  readonly published: number;
  /** Eligible tools beyond the publication bound. */
  readonly overflow: number;
  /** Tools whose server schema is outside Falryn's supported subset. */
  readonly unsupported: number;
  /** Tools of explicit-only servers the user did not select this turn. */
  readonly withheld: number;
};

export type McpDisclosureCounts = {
  readonly eager: number;
  readonly deferred: number;
  readonly eagerSchemaBytes: number;
  readonly deferredSchemaBytes: number;
};

export type McpPreparationReceipt = {
  readonly schemaVersion: 1;
  readonly servers: readonly McpPreparationServer[];
  readonly tools: McpCatalogToolCounts;
  /** Filled by disclosure: how many published MCP tools the attempt saw, and their bytes. */
  readonly disclosure?: McpDisclosureCounts | undefined;
};

const count = z.int().nonnegative();
export const mcpPreparationReceiptSchema: z.ZodType<McpPreparationReceipt> = z.strictObject({
  schemaVersion: z.literal(1),
  servers: z
    .array(
      z.strictObject({
        serverId: z.string().min(1).max(64),
        decision: z.enum(MCP_PREPARATION_DECISIONS),
        reason: z.string().min(1).max(128).nullable(),
        origin: z.enum(["discovery", "user"]).nullable(),
        discoveryRequests: count,
        transportStarts: count,
        processStarts: count,
        catalogGeneration: z.int().positive().nullable(),
      }),
    )
    .max(MCP_PREPARATION_LIMITS.servers),
  tools: z.strictObject({ published: count, overflow: count, unsupported: count, withheld: count }),
  disclosure: z
    .strictObject({
      eager: count,
      deferred: count,
      eagerSchemaBytes: count,
      deferredSchemaBytes: count,
    })
    .optional(),
});

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
