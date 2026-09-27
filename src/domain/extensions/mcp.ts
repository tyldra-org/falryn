import { z } from "zod";
import type { CredentialReference } from "../configuration/configuration.ts";
import { forbiddenEnvironmentName } from "../process/environment.ts";
import {
  type CredentialUnresolvedStatus,
  MAX_CREDENTIAL_LABEL_LENGTH,
  MAX_CREDENTIAL_LOCATOR_LENGTH,
} from "../security/credential.ts";
import type { RetryBackoff } from "../sessions/retry.ts";
import type { McpServerFeature } from "./mcp-catalog.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_MESSAGE_BYTES = 1024 * 1024;
export const MCP_PENDING_REQUESTS = 32;
export const MCP_STDERR_BYTES = 256 * 1024;
export const MCP_DEADLINE_MS = 30_000;
export const MCP_CONNECTIONS_KEY = "tools.mcpConnections";

/**
 * Retry policy for work the server provably did not accept (#132): safe reads that met a
 * rate limit or a transient gateway failure, and connection starts that did. Attempts
 * include the first; every wait must end before the caller's deadline and stops on
 * cancellation. Tool calls are never retried.
 */
export const MCP_RETRY = {
  attempts: 3,
  backoff: { baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0.5 } satisfies RetryBackoff,
  /** A server's Retry-After hint is honored only up to this wait. */
  retryAfterCapMs: 10_000,
} as const;

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
export const mcpConnectionSchema = z
  .discriminatedUnion("transport", [
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
      /** A shared credential-store reference; its consumer is always this server. */
      credential: z
        .strictObject({
          storeKind: z.enum(["operating-system-keychain", "environment"]),
          locator: z.string().min(1).max(MAX_CREDENTIAL_LOCATOR_LENGTH),
          accountLabel: z.string().min(1).max(MAX_CREDENTIAL_LABEL_LENGTH).nullable().default(null),
        })
        .optional(),
      /** Shorthand for an environment credential reference. */
      credentialEnvironment: environmentName.optional(),
    }),
  ])
  .refine(
    (connection) =>
      connection.transport !== "http" ||
      connection.credential === undefined ||
      connection.credentialEnvironment === undefined,
    "credential and credentialEnvironment are exclusive",
  );
export const mcpConfigurationSchema = z
  .strictObject({
    servers: z.array(mcpConnectionSchema).max(64),
  })
  .refine(
    ({ servers }) => new Set(servers.map((server) => server.id)).size === servers.length,
    "duplicate MCP connection identity",
  );
export type McpConnection = z.infer<typeof mcpConnectionSchema>;

/**
 * The reference an HTTP connection authenticates with. Its consumer is the server itself,
 * so the shared resolver refuses it to any other server or integration.
 */
export function mcpCredentialReference(connection: McpConnection): CredentialReference | null {
  if (connection.transport !== "http") return null;
  const consumer = "mcp:" + connection.id;
  if (connection.credential !== undefined) return { ...connection.credential, consumer };
  if (connection.credentialEnvironment !== undefined)
    return {
      storeKind: "environment",
      locator: connection.credentialEnvironment,
      consumer,
      accountLabel: null,
    };
  return null;
}
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
  /** Capability families the negotiated server advertises; empty before readiness. */
  readonly features: readonly McpServerFeature[];
  /** Count of list-change notifications received on this transport generation. */
  readonly catalogRevision: number;
  /** Whether list changes can reach Falryn; unobserved catalogs may change silently. */
  readonly listChanges: McpListChanges;
};
export type McpListChanges = "observed" | "unobserved";
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
  "resources/templates/list",
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
  /** Advertised capability families and list-change observation after a successful connect. */
  catalog(): {
    readonly features: readonly McpServerFeature[];
    readonly listChanges: McpListChanges;
  };
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
  /**
   * A list change or lost list-change subscription, with the observation now in effect.
   * It never refreshes by itself.
   */
  readonly onCatalogChanged: (listChanges: McpListChanges) => void;
}) => Promise<{ readonly client: McpClientPort; readonly environmentGeneration: string | null }>;

export class McpUnavailable extends Error {
  constructor(
    readonly code:
      | "mcp-stdio-platform-unavailable"
      /** The credential store could not be reached or cannot serve this reference. */
      | "mcp-credential-unavailable",
  ) {
    super(code);
  }
}

export type McpAuthFailureCode =
  /** No secret is stored under the reference, or it is empty. */
  | "mcp-credential-missing"
  /** The store is locked or refused the read. */
  | "mcp-credential-denied"
  /** The server rejected the credential, also after it was resolved again. */
  | "mcp-auth-rejected"
  /** The server accepted the credential but refused this access. */
  | "mcp-auth-forbidden";

/**
 * Authentication failed before the server accepted anything. The connection is denied
 * until the credential or access changes; retrying unchanged cannot succeed.
 */
export class McpAuthFailure extends Error {
  constructor(readonly code: McpAuthFailureCode) {
    super(code);
  }
}

/** How a credential store's refusal reads as an MCP connection fact, never its locator. */
export function mcpCredentialFailure(
  status: CredentialUnresolvedStatus,
): McpAuthFailure | McpUnavailable | "cancelled" {
  if (status === "cancelled") return "cancelled";
  if (status === "missing" || status === "empty")
    return new McpAuthFailure("mcp-credential-missing");
  if (status === "locked" || status === "denied")
    return new McpAuthFailure("mcp-credential-denied");
  return new McpUnavailable("mcp-credential-unavailable");
}

/**
 * A request's result cannot be accepted. Either it reached the server and exceeded a
 * protocol limit or asked for input this client does not answer, or the server refused
 * it before accepting anything: authentication, a rate limit or a transient gateway
 * failure. Only a refusal may say so, and only it can carry a retry hint.
 */
export class McpRequestFailure extends Error {
  constructor(
    readonly code:
      | "mcp-result-too-large"
      | "mcp-list-pagination-exceeded"
      | "mcp-input-required-unavailable"
      | McpRefusalCode,
    /** The server refused before accepting the request, so it had no effect. */
    readonly refused = false,
    /** Milliseconds the server asked the client to wait, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

export type McpRefusalCode =
  | Extract<McpAuthFailureCode, "mcp-auth-rejected" | "mcp-auth-forbidden">
  /** HTTP 429: the server is limiting this client. */
  | "mcp-rate-limited"
  /** HTTP 502, 503 or 504 before the server answered. */
  | "mcp-server-unavailable";

/** Refusals a later attempt may overcome, as opposed to authentication. */
export function mcpTransientRefusal(code: string): boolean {
  return code === "mcp-rate-limited" || code === "mcp-server-unavailable";
}

/**
 * A Retry-After header in milliseconds: delta-seconds or an HTTP date, never negative.
 * An absent or unreadable value is null so the caller falls back to its own backoff.
 */
export function mcpRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
