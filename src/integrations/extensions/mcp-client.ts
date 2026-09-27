import {
  Client,
  type FetchLike,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  MCP_DEADLINE_MS,
  MCP_MESSAGE_BYTES,
  MCP_STDERR_BYTES,
  McpAuthFailure,
  type McpClientFactory,
  type McpListChanges,
  type McpMethod,
  McpRequestFailure,
  McpUnavailable,
  mcpCredentialFailure,
  mcpCredentialReference,
  mcpRetryAfterMs,
} from "../../domain/extensions/mcp.ts";
import { MCP_SERVER_FEATURES } from "../../domain/extensions/mcp-catalog.ts";
import { duration, managedServiceId } from "../../domain/foundation/index.ts";
import {
  MAX_MANAGED_SERVICE_REPLAY_BYTES,
  type ManagedServicePort,
} from "../../domain/process/index.ts";
import type { SecretResolverPort } from "../../domain/security/credential.ts";
import { ManagedMcpTransport } from "./mcp-stdio.ts";

export type HostMcpPorts = {
  readonly services: (names: readonly string[]) => ManagedServicePort;
  /** The shared resolver; an HTTP server's reference is scoped to that server. */
  readonly credentials: SecretResolverPort;
  readonly environmentGeneration: () => string | null;
  readonly currentEnvironmentGeneration?: () => string | null;
  readonly environmentValues?: (
    names: readonly string[],
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, string>> | null>;
  readonly fetch?: FetchLike;
  readonly identity: string;
};

/**
 * Fetch remains bound to one admitted destination. Redirects and authentication never
 * change it. A rate-limit or gateway refusal reports its status and Retry-After hint.
 */
function boundedFetch(
  endpoint: string,
  authorize: (signal: AbortSignal) => Promise<boolean>,
  fetcher: FetchLike,
  onRefused: (status: number, retryAfterMs: number | null) => void,
): FetchLike {
  return async (input, init) => {
    const url = String(input);
    const signal = init?.signal ?? new AbortController().signal;
    if (new URL(url).href !== new URL(endpoint).href || !(await authorize(signal)))
      throw new Error("mcp-destination-denied");
    const response = await fetcher(input, { ...init, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("mcp-redirect-denied");
    }
    if ([429, 502, 503, 504].includes(response.status))
      onRefused(response.status, mcpRetryAfterMs(response.headers.get("retry-after"), Date.now()));
    if (Number(response.headers.get("content-length")) > MCP_MESSAGE_BYTES) {
      await response.body?.cancel();
      throw new Error("mcp-message-too-large");
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          count += next.value.byteLength;
          if (count > MCP_MESSAGE_BYTES) {
            await reader.cancel();
            controller.error(new Error("mcp-message-too-large"));
            return;
          }
          controller.enqueue(next.value);
        } catch {
          controller.error(new Error("mcp-response-failed"));
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

const GATEWAY = [502, 503, 504];

/**
 * A server refusal before it accepted anything, or null when the failure may have
 * followed acceptance. A gateway failure on a tool call is not a refusal: the gateway
 * may already have forwarded it.
 */
function refusal(
  error: unknown,
  method: McpMethod | "connect",
  retryAfterMs: number | null,
): McpRequestFailure | null {
  if (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpAuthentication)
  )
    return new McpRequestFailure("mcp-auth-rejected", true);
  if (!(error instanceof SdkHttpError)) return null;
  if (error.code === SdkErrorCode.ClientHttpForbidden || error.status === 403)
    return new McpRequestFailure("mcp-auth-forbidden", true);
  if (error.status === 401) return new McpRequestFailure("mcp-auth-rejected", true);
  if (error.status === 429) return new McpRequestFailure("mcp-rate-limited", true, retryAfterMs);
  if (GATEWAY.includes(error.status) && method !== "tools/call")
    return new McpRequestFailure("mcp-server-unavailable", true, retryAfterMs);
  return null;
}

export function createHostMcpClient(ports: HostMcpPorts): McpClientFactory {
  return async ({ connection, generation, admission, authorize, onFailure, onCatalogChanged }) => {
    if (connection.transport === "stdio" && process.platform === "win32")
      throw new McpUnavailable("mcp-stdio-platform-unavailable");
    const environmentGeneration =
      connection.transport === "stdio" ? ports.environmentGeneration() : null;
    const values =
      connection.transport === "stdio"
        ? await ports.environmentValues?.(connection.environmentNames, admission.signal)
        : null;
    const reference = mcpCredentialReference(connection);
    // Every secret this transport has sent, so a rotated one stays redacted too.
    const sent = new Set<string>();
    const resolve = async (signal: AbortSignal): Promise<string | null> => {
      if (reference === null) return null;
      const resolution = await ports.credentials.resolve(
        { reference, consumer: reference.consumer },
        (secret) => secret,
        { signal },
      );
      if (resolution.kind === "resolved") {
        sent.add(resolution.value);
        return resolution.value;
      }
      const failure = mcpCredentialFailure(resolution.failure.status);
      throw failure === "cancelled" ? new Error("mcp-credential-cancelled") : failure;
    };
    let token = await resolve(admission.signal);
    const current = () =>
      connection.transport !== "stdio" ||
      !ports.currentEnvironmentGeneration ||
      ports.currentEnvironmentGeneration() === environmentGeneration;
    const allowed = async (signal: AbortSignal) =>
      !signal.aborted && current() && (await authorize(signal));
    let retryAfterMs: number | null = null;
    // The SDK's version probe folds some refusals into its own fallback; the fetch saw them.
    let refusedStatus: number | null = null;
    let transport: Transport;
    if (connection.transport === "stdio") {
      transport = new ManagedMcpTransport(ports.services(connection.environmentNames), {
        serviceId: managedServiceId.from(`mcp:${ports.identity}:${connection.id}:${generation}`),
        protocol: "mcp",
        executable: connection.executable,
        argv: connection.args,
        environment: {},
        ...(connection.cwd === undefined ? {} : { cwd: connection.cwd }),
        authorizeLaunch: allowed,
        readiness: { kind: "immediate" },
        idle: { kind: "disabled" },
        restart: { maxRestarts: 0, windowMs: duration(60_000) },
        shutdownTimeoutMs: duration(1000),
        replayBytes: Math.min(MCP_STDERR_BYTES, MAX_MANAGED_SERVICE_REPLAY_BYTES),
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        fetch: boundedFetch(connection.url, allowed, ports.fetch ?? fetch, (status, hint) => {
          refusedStatus = status;
          retryAfterMs = hint;
        }),
        ...(reference === null
          ? {}
          : {
              authProvider: {
                token: async () => token ?? undefined,
                // A rejected credential may have rotated or expired: resolve it again once.
                // The SDK then retries that request once; a second rejection is final.
                async onUnauthorized() {
                  try {
                    token = await resolve(AbortSignal.timeout(MCP_DEADLINE_MS));
                  } catch {
                    // The unchanged credential meets the same rejection.
                  }
                },
              },
            }),
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1,
        },
      });
    }
    let listChanges: McpListChanges = "unobserved";
    // Notifications only mark the catalog stale; the catalog owner decides when to refresh.
    const changed = {
      autoRefresh: false,
      debounceMs: 0,
      onChanged: () => onCatalogChanged(listChanges),
    };
    const client = new Client(
      { name: "falryn", version: "0.0.0" },
      {
        versionNegotiation: {
          mode: connection.protocol === "legacy" ? "legacy" : { pin: connection.protocol },
          probe: { maxRetries: 0 },
        },
        inputRequired: { autoFulfill: false },
        // Current-protocol servers may ask for form input inside tools/call; the catalog owner
        // answers each round. Legacy servers are offered nothing, so they never ask.
        ...(connection.protocol === "legacy"
          ? {}
          : { capabilities: { elicitation: { form: {} } } }),
        enforceStrictCapabilities: true,
        listMaxPages: 16,
        listChanged: { tools: changed, resources: changed, prompts: changed },
      },
    );
    // During connect the SDK reports optional setup failures (such as a refused list-change
    // subscription) through onerror while completing the connection; they are not fatal.
    let connecting = false;
    client.onerror = (error) => {
      // A server refusing one request is reported by that request, not a lost transport.
      if (connecting || refusal(error, "tools/list", null) !== null) return;
      onFailure("mcp-protocol-error");
    };
    client.onclose = () => onFailure("mcp-disconnected");
    return {
      environmentGeneration,
      client: {
        current,
        catalog() {
          const capabilities = client.getServerCapabilities() ?? {};
          return {
            features: MCP_SERVER_FEATURES.filter((feature) => capabilities[feature] !== undefined),
            listChanges,
          };
        },
        async connect(signal) {
          if (!(await allowed(signal))) throw new Error("mcp-admission-revoked");
          connecting = true;
          try {
            retryAfterMs = null;
            refusedStatus = null;
            await client.connect(transport, {
              signal,
              timeout: Math.max(1, Math.min(MCP_DEADLINE_MS, admission.deadline - Date.now())),
            });
          } catch (error) {
            const observed: number | null = refusedStatus;
            const refused =
              refusal(error, "connect", retryAfterMs) ??
              (observed === 429
                ? new McpRequestFailure("mcp-rate-limited", true, retryAfterMs)
                : observed !== null && GATEWAY.includes(observed)
                  ? new McpRequestFailure("mcp-server-unavailable", true, retryAfterMs)
                  : null);
            if (refused === null) throw error;
            if (refused.code === "mcp-auth-rejected" || refused.code === "mcp-auth-forbidden")
              throw new McpAuthFailure(refused.code);
            throw refused;
          } finally {
            connecting = false;
          }
          const capabilities = client.getServerCapabilities() ?? {};
          const advertised = MCP_SERVER_FEATURES.some(
            (feature) => capabilities[feature]?.listChanged === true,
          );
          // Legacy notifications share the session; the current protocol needs a live subscription.
          const subscription = client.autoOpenedSubscription;
          listChanges =
            advertised && (connection.protocol === "legacy" || subscription !== undefined)
              ? "observed"
              : "unobserved";
          void subscription?.closed.then((reason) => {
            if (reason === "local") return;
            listChanges = "unobserved";
            onCatalogChanged(listChanges);
          });
        },
        async request(method, params, signal) {
          if (!(await allowed(signal))) throw new Error("mcp-admission-revoked");
          // Reserved metadata cannot be supplied by a tool argument to replace the SDK envelope.
          if (Object.hasOwn(params, "_meta")) throw new Error("mcp-reserved-metadata");
          const options = { signal, timeout: MCP_DEADLINE_MS, maxTotalTimeout: MCP_DEADLINE_MS };
          const execute = () => {
            if (method === "tools/list") return client.listTools(params, options);
            if (method === "resources/list") return client.listResources(params, options);
            if (method === "resources/templates/list")
              return client.listResourceTemplates(params, options);
            if (method === "prompts/list") return client.listPrompts(params, options);
            // callTool also validates structured output against the listed output schema. An
            // input_required round is returned to the catalog owner, which answers and retries.
            if (method === "tools/call")
              return client.callTool(params as Parameters<Client["callTool"]>[0], {
                ...options,
                allowInputRequired: connection.protocol !== "legacy",
              });
            return client.request({ method, params }, options);
          };
          let result: unknown;
          retryAfterMs = null;
          try {
            result = await execute();
          } catch (error) {
            if (error instanceof SdkError && error.code === SdkErrorCode.ListPaginationExceeded)
              throw new McpRequestFailure("mcp-list-pagination-exceeded");
            if (
              error instanceof SdkError &&
              error.code === SdkErrorCode.UnsupportedResultType &&
              (error.data as { resultType?: unknown } | undefined)?.resultType === "input_required"
            )
              throw new McpRequestFailure("mcp-input-required-unavailable");
            // Whether and when to try again belongs to the lifecycle's retry policy.
            throw refusal(error, method, retryAfterMs) ?? error;
          }
          if (new TextEncoder().encode(JSON.stringify(result)).length > MCP_MESSAGE_BYTES)
            throw new McpRequestFailure("mcp-result-too-large");
          const secrets = [...sent, ...Object.values(values ?? {})].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          );
          for (const secret of [...secrets]) {
            const escaped = JSON.stringify(secret).slice(1, -1);
            if (escaped !== secret) secrets.push(escaped);
          }
          // Redact strings before encoding so quoted and escaped credentials remain covered.
          const redact = (value: unknown): unknown => {
            if (typeof value === "string")
              return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
            if (Array.isArray(value)) return value.map(redact);
            if (value && typeof value === "object")
              return Object.fromEntries(
                Object.entries(value).map(([key, child]) => [String(redact(key)), redact(child)]),
              );
            return value;
          };
          return redact(result);
        },
        async close() {
          await client.close();
          await transport.close();
        },
      },
    };
  };
}
