import {
  MCP_DEADLINE_MS,
  MCP_MESSAGE_BYTES,
  MCP_PENDING_REQUESTS,
  MCP_RETRY,
  type McpAdmission,
  McpAuthFailure,
  type McpClientFactory,
  type McpClientPort,
  type McpConfiguration,
  type McpConnection,
  type McpMethod,
  type McpOutcome,
  McpRequestFailure,
  type McpSnapshot,
  McpUnavailable,
  mcpTransientRefusal,
} from "../../domain/extensions/mcp.ts";
import { type ClockPort, createSystemClock, duration } from "../../domain/foundation/clock.ts";
import { backoffDelayMs } from "../../domain/sessions/retry.ts";
import { awaitBackoff } from "../runtime/recovery.ts";

type Live = {
  connection: McpConnection;
  snapshot: McpSnapshot;
  client: McpClientPort | null;
  stop: AbortController;
  requests: Map<string, Promise<void>>;
  opening: Promise<McpOutcome> | null;
};
export type McpLifecyclePorts = {
  readonly configuration: () => McpConfiguration;
  readonly authorize: (admission: McpAdmission) => Promise<boolean>;
  readonly clients: McpClientFactory;
  readonly observe?: (snapshot: McpSnapshot) => void;
  /** Waits between retries; injected so tests observe them. Defaults to the system clock. */
  readonly clock?: ClockPort;
  /** A fraction in [0, 1) spreading each backoff; defaults to Math.random. */
  readonly jitter?: () => number;
};

type Wait = "elapsed" | "cancelled" | "deadline";

/** One session owns each transport generation; observations cannot launch a server. */
export function createMcpLifecycle(ports: McpLifecyclePorts) {
  const connections = new Map<string, Live>();
  const starts = new Map<string, number[]>();
  const denied = new Map<string, McpSnapshot>();
  const openingServers = new Map<string, { abort: AbortController; settled: Promise<void> }>();
  /** The latest refused start's Retry-After hint per server, consumed by the next wait. */
  const startHints = new Map<string, number | null>();
  const clock = ports.clock ?? createSystemClock();
  const jitter = ports.jitter ?? Math.random;
  let nextGeneration = 0;
  let closed = false;
  /**
   * Wait before attempt number attempt + 1. The server's hint wins over backoff, and a
   * wait that would end past the deadline is not started.
   */
  const wait = async (
    attempt: number,
    hint: number | null,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Wait> => {
    const delayMs =
      hint === null
        ? backoffDelayMs(attempt, MCP_RETRY.backoff, jitter())
        : Math.min(hint, MCP_RETRY.retryAfterCapMs);
    if (Date.now() + delayMs >= deadline) return "deadline";
    return awaitBackoff(
      clock,
      { kind: "retry", attempt: attempt + 1, delayMs: duration(delayMs) },
      signal,
    );
  };
  const publish = (live: Live, change: Partial<McpSnapshot>) => {
    live.snapshot = { ...live.snapshot, ...change };
    ports.observe?.({ ...live.snapshot });
  };
  const current = (id: string) => ports.configuration().servers.find((server) => server.id === id);
  const same = (live: Live) =>
    JSON.stringify(current(live.connection.id)) === JSON.stringify(live.connection) &&
    (live.client?.current() ?? true);
  const failed = (
    kind: Exclude<McpOutcome["kind"], "completed">,
    code: string,
    live?: Live,
    effect: "none" | "uncertain" = "none",
  ): McpOutcome => ({ kind, code, effect, snapshot: live ? { ...live.snapshot } : null });
  const allowed = async (admission: McpAdmission, live?: Live) => {
    const config = ports.configuration();
    const selected = current(admission.serverId);
    if (
      closed ||
      admission.signal.aborted ||
      Date.now() >= admission.deadline ||
      !selected?.enabled ||
      (selected.explicitOnly && admission.origin !== "user") ||
      (live ? !same(live) : config.generation !== admission.configurationGeneration)
    )
      return false;
    const abort = AbortSignal.any([
      admission.signal,
      AbortSignal.timeout(Math.max(1, Math.min(MCP_DEADLINE_MS, admission.deadline - Date.now()))),
    ]);
    const authorized = await new Promise<boolean>((resolve) => {
      const stop = () => resolve(false);
      abort.addEventListener("abort", stop, { once: true });
      if (abort.aborted) {
        stop();
        return;
      }
      void ports
        .authorize({ ...admission, signal: abort })
        .then(resolve, () => resolve(false))
        .finally(() => abort.removeEventListener("abort", stop));
    });
    if (!authorized) return false;
    return (
      !closed &&
      !admission.signal.aborted &&
      Date.now() < admission.deadline &&
      (live
        ? same(live) && !live.stop.signal.aborted
        : ports.configuration().generation === admission.configurationGeneration)
    );
  };
  const dispose = async (live: Live) => {
    live.stop.abort();
    await live.client?.close();
    await Promise.all(live.requests.values());
  };
  const inspect = (): readonly McpSnapshot[] =>
    ports.configuration().servers.map((server) => {
      const live = connections.get(server.id);
      if (live)
        return {
          ...live.snapshot,
          ...(!same(live) ? { state: "degraded" as const, code: "mcp-configuration-stale" } : {}),
        };
      const refusal = denied.get(server.id);
      if (refusal && refusal.configurationGeneration === ports.configuration().generation)
        return refusal;
      return {
        serverId: server.id,
        state: server.enabled ? "unqueried" : "denied",
        configurationGeneration: ports.configuration().generation,
        transportGeneration: 0,
        environmentGeneration: null,
        pending: 0,
        code: server.enabled ? null : "mcp-disabled",
        features: [],
        catalogRevision: 0,
        listChanges: "unobserved",
      };
    });
  async function connectOwned(admission: McpAdmission): Promise<McpOutcome> {
    const existing = connections.get(admission.serverId);
    for (const id of denied.keys()) if (!current(id)) denied.delete(id);
    if (!(await allowed(admission))) {
      if (!existing && current(admission.serverId))
        denied.set(admission.serverId, {
          serverId: admission.serverId,
          state: "denied",
          configurationGeneration: ports.configuration().generation,
          transportGeneration: 0,
          environmentGeneration: null,
          pending: 0,
          code: "mcp-admission-denied",
          features: [],
          catalogRevision: 0,
          listChanges: "unobserved",
        });
      return failed(
        admission.signal.aborted ? "cancelled" : "denied",
        "mcp-admission-denied",
        existing,
      );
    }
    denied.delete(admission.serverId);
    for (const [id, retired] of connections) {
      if (current(id)) continue;
      try {
        await dispose(retired);
      } catch {
        return failed("failed", "mcp-shutdown-uncertain", retired, "uncertain");
      }
      connections.delete(id);
      starts.delete(id);
      denied.delete(id);
    }
    if (existing?.opening) return failed("unavailable", "mcp-startup-in-progress", existing);
    if (existing?.snapshot.state === "available" && same(existing))
      return { kind: "completed", value: null, snapshot: { ...existing.snapshot } };
    const history = (starts.get(admission.serverId) ?? []).filter(
      (time) => Date.now() - time < 30_000,
    );
    if (history.length >= 3)
      return failed("unavailable", "mcp-reconnect-budget-exhausted", existing);
    history.push(Date.now());
    starts.set(admission.serverId, history);
    if (existing) {
      try {
        await dispose(existing);
      } catch {
        return failed("failed", "mcp-shutdown-uncertain", existing, "uncertain");
      }
    }
    const connection = current(admission.serverId);
    if (!connection) return failed("unavailable", "mcp-not-configured");
    const live: Live = {
      connection: structuredClone(connection),
      client: null,
      stop: new AbortController(),
      requests: new Map(),
      opening: null,
      snapshot: {
        serverId: connection.id,
        configurationGeneration: admission.configurationGeneration,
        transportGeneration: ++nextGeneration,
        environmentGeneration: null,
        pending: 0,
        state: "connecting",
        code: null,
        features: [],
        catalogRevision: 0,
        listChanges: "unobserved",
      },
    };
    connections.set(connection.id, live);
    publish(live, {});
    const work = async (): Promise<McpOutcome> => {
      let launchAttempted = false;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        Math.max(1, Math.min(MCP_DEADLINE_MS, admission.deadline - Date.now())),
      );
      const signal = AbortSignal.any([admission.signal, live.stop.signal, timeout.signal]);
      try {
        const created = await ports.clients({
          connection: live.connection,
          generation: live.snapshot.transportGeneration,
          admission: { ...admission, signal },
          authorize: (nextSignal) =>
            allowed(
              { ...admission, signal: nextSignal, deadline: Date.now() + MCP_DEADLINE_MS },
              live,
            ),
          onFailure(code) {
            if (!live.stop.signal.aborted) {
              publish(live, { state: "degraded", code });
              live.stop.abort();
              void live.client
                ?.close()
                .catch(() => publish(live, { state: "failed", code: "mcp-shutdown-uncertain" }));
            }
          },
          onCatalogChanged(listChanges) {
            // Repeated notifications collapse into one observable revision change.
            if (!live.stop.signal.aborted)
              publish(live, { catalogRevision: live.snapshot.catalogRevision + 1, listChanges });
          },
        });
        live.client = created.client;
        publish(live, { environmentGeneration: created.environmentGeneration });
        launchAttempted = true;
        await created.client.connect(signal);
        if (signal.aborted || !(await allowed(admission, live)))
          throw new Error("mcp-startup-revoked");
        publish(live, { state: "available", code: null, ...created.client.catalog() });
        return { kind: "completed", value: null, snapshot: { ...live.snapshot } };
      } catch (error) {
        try {
          await dispose(live);
        } catch {
          publish(live, { state: "failed", code: "mcp-shutdown-uncertain" });
          return failed("failed", "mcp-shutdown-uncertain", live, "uncertain");
        }
        if (error instanceof McpUnavailable) {
          publish(live, { state: "failed", code: error.code });
          return failed("unavailable", error.code, live);
        }
        // Authentication failed before the server accepted anything; retrying cannot help.
        if (error instanceof McpAuthFailure) {
          publish(live, { state: "denied", code: error.code });
          return failed("denied", error.code, live);
        }
        // A rate limit or gateway refusal: the caller may wait and start again.
        if (error instanceof McpRequestFailure && error.refused && !admission.signal.aborted) {
          startHints.set(live.connection.id, error.retryAfterMs);
          publish(live, { state: "failed", code: error.code });
          return failed("unavailable", error.code, live);
        }
        const kind = admission.signal.aborted
          ? "cancelled"
          : timeout.signal.aborted
            ? "timed-out"
            : "failed";
        publish(live, { state: "failed", code: `mcp-startup-${kind}` });
        return failed(
          kind,
          live.snapshot.code ?? "mcp-startup-failed",
          live,
          launchAttempted ? "uncertain" : "none",
        );
      } finally {
        clearTimeout(timer);
        live.opening = null;
      }
    };
    live.opening = work();
    return live.opening;
  }
  async function request(
    admission: McpAdmission,
    generation: number,
    method: McpMethod,
    params: Readonly<Record<string, unknown>>,
  ): Promise<McpOutcome> {
    const live = connections.get(admission.serverId);
    if (live?.snapshot.state !== "available" || !live.client)
      return failed("unavailable", "mcp-not-ready", live);
    if (
      generation !== live.snapshot.transportGeneration ||
      admission.configurationGeneration !== live.snapshot.configurationGeneration ||
      !same(live)
    )
      return failed("stale", "mcp-generation-stale", live);
    if (!(await allowed(admission, live)))
      return failed(
        admission.signal.aborted ? "cancelled" : "denied",
        "mcp-admission-denied",
        live,
      );
    if (live.requests.size >= MCP_PENDING_REQUESTS)
      return failed("unavailable", "mcp-request-capacity", live);
    if (live.requests.has(admission.requestId))
      return failed("denied", "mcp-request-identity-in-use", live);
    if (new TextEncoder().encode(JSON.stringify(params)).length > MCP_MESSAGE_BYTES)
      return failed("denied", "mcp-input-too-large", live);
    let settled!: () => void;
    live.requests.set(
      admission.requestId,
      new Promise<void>((resolve) => {
        settled = resolve;
      }),
    );
    publish(live, { pending: live.requests.size });
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      Math.max(1, Math.min(MCP_DEADLINE_MS, admission.deadline - Date.now())),
    );
    const signal = AbortSignal.any([admission.signal, timeout.signal, live.stop.signal]);
    const effect = method === "tools/call" ? "uncertain" : "none";
    // Retries share this request's deadline; waiting never extends it.
    const until = Math.min(admission.deadline, Date.now() + MCP_DEADLINE_MS);
    try {
      let value: unknown;
      for (let attempt = 1; ; attempt += 1) {
        try {
          value = await live.client.request(method, params, signal);
          break;
        } catch (error) {
          if (!(error instanceof McpRequestFailure) || !error.refused || admission.signal.aborted)
            throw error;
          // A refusal means the server accepted nothing, so no effect is uncertain.
          if (!mcpTransientRefusal(error.code)) {
            // The credential no longer works: the connection is denied until it changes.
            publish(live, { state: "denied", code: error.code });
            live.stop.abort();
            void live.client
              ?.close()
              .catch(() => publish(live, { state: "failed", code: "mcp-shutdown-uncertain" }));
            return failed("denied", error.code, live);
          }
          if (method === "tools/call" || attempt >= MCP_RETRY.attempts)
            return failed("unavailable", error.code, live);
          const waited = await wait(attempt, error.retryAfterMs, until, signal);
          if (waited === "deadline") return failed("unavailable", error.code, live);
          if (waited === "cancelled")
            return admission.signal.aborted
              ? failed("cancelled", "mcp-request-cancelled", live)
              : failed("stale", "mcp-generation-stale", live);
          if (generation !== live.snapshot.transportGeneration || !(await allowed(admission, live)))
            return failed("stale", "mcp-generation-stale", live);
        }
      }
      if (!(await allowed(admission, live)) || signal.aborted)
        return failed(
          admission.signal.aborted ? "cancelled" : timeout.signal.aborted ? "timed-out" : "stale",
          "mcp-result-fenced",
          live,
          effect,
        );
      return {
        kind: "completed",
        value,
        snapshot: { ...live.snapshot, pending: live.requests.size - 1 },
      };
    } catch (error) {
      if (error instanceof McpRequestFailure && !admission.signal.aborted)
        return failed("failed", error.code, live, effect);
      const kind = admission.signal.aborted
        ? "cancelled"
        : timeout.signal.aborted
          ? "timed-out"
          : "failed";
      return failed(kind, `mcp-request-${kind}`, live, effect);
    } finally {
      clearTimeout(timer);
      live.requests.delete(admission.requestId);
      settled();
      publish(live, { pending: live.requests.size });
    }
  }
  async function stop(serverId: string): Promise<McpOutcome> {
    const opening = openingServers.get(serverId);
    opening?.abort.abort();
    await opening?.settled;
    const live = connections.get(serverId);
    if (!live) return failed("unavailable", "mcp-not-started");
    try {
      await dispose(live);
      await live.opening;
      publish(live, { state: "stopped", code: null });
      return { kind: "completed", value: null, snapshot: { ...live.snapshot } };
    } catch {
      return failed("failed", "mcp-shutdown-uncertain", live, "uncertain");
    }
  }
  return {
    inspect,
    async connect(admission: McpAdmission): Promise<McpOutcome> {
      if (openingServers.has(admission.serverId))
        return failed(
          "unavailable",
          "mcp-startup-in-progress",
          connections.get(admission.serverId),
        );
      const abort = new AbortController();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      openingServers.set(admission.serverId, { abort, settled });
      try {
        const signal = AbortSignal.any([admission.signal, abort.signal]);
        // Only a refused start is retried, and each attempt spends the start budget.
        for (let attempt = 1; ; attempt += 1) {
          startHints.delete(admission.serverId);
          const outcome = await connectOwned({ ...admission, signal });
          if (
            outcome.kind !== "unavailable" ||
            !mcpTransientRefusal(outcome.code) ||
            attempt >= MCP_RETRY.attempts
          )
            return outcome;
          const live = connections.get(admission.serverId);
          if (live) publish(live, { state: "connecting", code: "mcp-retry-wait" });
          const waited = await wait(
            attempt,
            startHints.get(admission.serverId) ?? null,
            admission.deadline,
            signal,
          );
          if (waited === "elapsed") continue;
          const code = waited === "deadline" ? outcome.code : "mcp-startup-cancelled";
          if (live) publish(live, { state: "failed", code });
          return failed(waited === "deadline" ? "unavailable" : "cancelled", code, live);
        }
      } catch {
        return failed(
          "unavailable",
          "mcp-configuration-unavailable",
          connections.get(admission.serverId),
        );
      } finally {
        openingServers.delete(admission.serverId);
        settle();
      }
    },
    request,
    stop,
    async close() {
      closed = true;
      return Promise.all([...new Set([...connections.keys(), ...openingServers.keys()])].map(stop));
    },
  };
}
export type McpLifecycle = ReturnType<typeof createMcpLifecycle>;
