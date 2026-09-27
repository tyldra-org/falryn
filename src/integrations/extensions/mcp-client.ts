import {
  Client,
  type FetchLike,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  MCP_DEADLINE_MS,
  MCP_MESSAGE_BYTES,
  MCP_STDERR_BYTES,
  type McpClientFactory,
  McpLimitExceeded,
  type McpListChanges,
  McpUnavailable,
} from "../../domain/extensions/mcp.ts";
import { MCP_SERVER_FEATURES } from "../../domain/extensions/mcp-catalog.ts";
import type { EnvironmentPort } from "../../domain/foundation/index.ts";
import { duration, managedServiceId } from "../../domain/foundation/index.ts";
import {
  MAX_MANAGED_SERVICE_REPLAY_BYTES,
  type ManagedServicePort,
} from "../../domain/process/index.ts";
import { ManagedMcpTransport } from "./mcp-stdio.ts";

export type HostMcpPorts = {
  readonly services: (names: readonly string[]) => ManagedServicePort;
  readonly environment: EnvironmentPort;
  readonly environmentGeneration: () => string | null;
  readonly currentEnvironmentGeneration?: () => string | null;
  readonly environmentValues?: (
    names: readonly string[],
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, string>> | null>;
  readonly fetch?: FetchLike;
  readonly identity: string;
};

/** Fetch remains bound to one admitted destination. Redirects and authentication never change it. */
function boundedFetch(
  endpoint: string,
  authorize: (signal: AbortSignal) => Promise<boolean>,
  fetcher: FetchLike,
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
    const credential =
      connection.transport === "http" && connection.credentialEnvironment
        ? ports.environment.get(connection.credentialEnvironment)
        : null;
    if (connection.transport === "http" && connection.credentialEnvironment && !credential)
      throw new McpUnavailable("mcp-credential-unavailable");
    const current = () =>
      (connection.transport !== "stdio" ||
        !ports.currentEnvironmentGeneration ||
        ports.currentEnvironmentGeneration() === environmentGeneration) &&
      (connection.transport !== "http" ||
        !connection.credentialEnvironment ||
        ports.environment.get(connection.credentialEnvironment) === credential);
    const allowed = async (signal: AbortSignal) =>
      !signal.aborted && current() && (await authorize(signal));
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
        fetch: boundedFetch(connection.url, allowed, ports.fetch ?? fetch),
        ...(credential === null ? {} : { authProvider: { token: async () => credential } }),
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
        enforceStrictCapabilities: true,
        listMaxPages: 16,
        listChanged: { tools: changed, resources: changed, prompts: changed },
      },
    );
    // During connect the SDK reports optional setup failures (such as a refused list-change
    // subscription) through onerror while completing the connection; they are not fatal.
    let connecting = false;
    client.onerror = (error) => {
      if (connecting) return;
      if (error instanceof SdkHttpError && [502, 503, 504].includes(error.status)) return;
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
            await client.connect(transport, {
              signal,
              timeout: Math.max(1, Math.min(MCP_DEADLINE_MS, admission.deadline - Date.now())),
            });
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
            return client.request({ method, params }, options);
          };
          let result: unknown;
          try {
            result = await execute();
          } catch (error) {
            if (error instanceof SdkError && error.code === SdkErrorCode.ListPaginationExceeded)
              throw new McpLimitExceeded("mcp-list-pagination-exceeded");
            // Only a safe read receiving a transient HTTP failure gets one retry.
            if (
              method === "tools/call" ||
              !(error instanceof SdkHttpError) ||
              ![502, 503, 504].includes(error.status) ||
              !(await allowed(signal))
            )
              throw error;
            result = await execute();
          }
          if (new TextEncoder().encode(JSON.stringify(result)).length > MCP_MESSAGE_BYTES)
            throw new McpLimitExceeded("mcp-result-too-large");
          const secrets = [credential, ...Object.values(values ?? {})].filter(
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
