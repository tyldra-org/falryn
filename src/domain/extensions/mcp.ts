import { z } from "zod";
import { forbiddenEnvironmentName } from "../process/environment.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_MESSAGE_BYTES = 1024 * 1024;
export const MCP_PENDING_REQUESTS = 32;
export const MCP_STDERR_BYTES = 256 * 1024;
export const MCP_DEADLINE_MS = 30_000;
export const MCP_CONNECTIONS_KEY = "tools.mcpConnections";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u);
const environmentName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
  .refine((value) => !forbiddenEnvironmentName(value));
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const common = {
  id: name,
  enabled: z.boolean().default(true),
  explicitOnly: z.boolean().default(false),
  protocol: z.enum([MCP_PROTOCOL_VERSION, "legacy"]).default(MCP_PROTOCOL_VERSION),
};
export const mcpConnectionSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...common,
    transport: z.literal("stdio"),
    executable: text,
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0")),
      )
      .max(256)
      .default([]),
    cwd: text.optional(),
    environmentNames: z.array(environmentName).max(64).default([]),
  }),
  z.strictObject({
    ...common,
    transport: z.literal("http"),
    url: text.refine((value) => {
      try {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      } catch {
        return false;
      }
    }),
    credentialEnvironment: environmentName.optional(),
  }),
]);
export const mcpConfigurationSchema = z
  .strictObject({
    servers: z.array(mcpConnectionSchema).max(64),
  })
  .refine(
    ({ servers }) => new Set(servers.map((server) => server.id)).size === servers.length,
    "duplicate MCP connection identity",
  );
export type McpConnection = z.infer<typeof mcpConnectionSchema>;
export type McpConfiguration = {
  readonly generation: number;
  readonly servers: readonly McpConnection[];
};
export type McpState =
  | "unqueried"
  | "connecting"
  | "available"
  | "degraded"
  | "denied"
  | "failed"
  | "stopped";
export type McpSnapshot = {
  readonly serverId: string;
  readonly state: McpState;
  readonly configurationGeneration: number;
  readonly transportGeneration: number;
  readonly environmentGeneration: string | null;
  readonly pending: number;
  readonly code: string | null;
};
export type McpOutcome =
  | { readonly kind: "completed"; readonly value: unknown; readonly snapshot: McpSnapshot }
  | {
      readonly kind: "failed" | "denied" | "stale" | "cancelled" | "timed-out" | "unavailable";
      readonly code: string;
      readonly effect: "none" | "uncertain";
      readonly snapshot: McpSnapshot | null;
    };
export const mcpMethodSchema = z.enum([
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "ping",
]);
export type McpMethod = z.infer<typeof mcpMethodSchema>;
export type McpAdmission = {
  readonly serverId: string;
  readonly configurationGeneration: number;
  readonly origin: "user" | "model" | "discovery";
  readonly requestId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
};
/** The protocol adapter owns SDK types. Application consumers receive validated JSON only. */
export type McpClientPort = {
  current(): boolean;
  connect(signal: AbortSignal): Promise<void>;
  request(
    method: McpMethod,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
};
export type McpClientFactory = (input: {
  readonly connection: McpConnection;
  readonly generation: number;
  readonly admission: McpAdmission;
  readonly authorize: (signal: AbortSignal) => Promise<boolean>;
  readonly onFailure: (code: string) => void;
}) => Promise<{ readonly client: McpClientPort; readonly environmentGeneration: string | null }>;

export class McpUnavailable extends Error {
  constructor(readonly code: "mcp-stdio-platform-unavailable" | "mcp-credential-unavailable") {
    super(code);
  }
}
