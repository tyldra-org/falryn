/** Bounded active-probe adapter for the pure capability-health domain. */

import type { CapabilityHealthEvidence } from "../domain/capability-health.ts";
import {
  addDuration,
  type CapabilityConsumer,
  type CapabilityHealthSnapshot,
  type CapabilityProbeObservation,
  type CapabilityRecovery,
  type CapabilityRegistry,
  type ClockPort,
  type CorrelationIds,
  duration,
  inspectCapabilityHealth,
  NO_CORRELATION,
  type Result,
} from "../domain/index.ts";
import type { DiagnosticsCollector } from "./diagnostics-collector.ts";
import { redactText } from "./redaction.ts";

export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 2_000;
export const DEFAULT_CAPABILITY_PROBE_TTL_MS = 30_000;
export const MAX_CAPABILITY_PROBES = 32;
export const MAX_CAPABILITY_PROBE_CONCURRENCY = 4;
export const MAX_CAPABILITY_PROBE_TIMEOUT_MS = 15_000;
export const MAX_CAPABILITY_PROBE_TTL_MS = 5 * 60_000;

export type CapabilityProbeResult =
  | { readonly state: "healthy"; readonly ttlMs?: number }
  | {
      readonly state: "degraded" | "unavailable" | "unknown";
      readonly message: string;
      readonly ttlMs?: number;
      readonly recovery?: CapabilityRecovery | null;
    };

export type CapabilityProbePort = {
  readonly capabilityId: string;
  run(signal: AbortSignal): Promise<CapabilityProbeResult>;
};

export type InspectProductCapabilityHealthOptions = {
  readonly registry: CapabilityRegistry;
  readonly consumer: CapabilityConsumer;
  readonly clock: ClockPort;
  readonly evidence?: Omit<CapabilityHealthEvidence, "now" | "probes">;
  readonly probes?: readonly CapabilityProbePort[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly diagnostics?: DiagnosticsCollector;
  readonly correlation?: CorrelationIds;
};

export type CapabilityProbeError =
  | { readonly code: "cancelled" }
  | { readonly code: "too-many-probes"; readonly maximum: number }
  | { readonly code: "invalid-concurrency"; readonly maximum: number }
  | { readonly code: "invalid-timeout"; readonly maximum: number }
  | { readonly code: "duplicate-probe"; readonly capabilityId: string }
  | { readonly code: "unknown-capability"; readonly capabilityId: string };

function probeCode(
  state: Exclude<CapabilityProbeResult["state"], "healthy">,
): CapabilityProbeObservation["code"] {
  switch (state) {
    case "degraded":
      return "probe-degraded";
    case "unavailable":
      return "probe-unavailable";
    case "unknown":
      return "probe-unknown";
  }
}

function boundedTtl(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return DEFAULT_CAPABILITY_PROBE_TTL_MS;
  }
  return Math.min(value, MAX_CAPABILITY_PROBE_TTL_MS);
}

async function runProbe(
  probe: CapabilityProbePort,
  clock: ClockPort,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): Promise<CapabilityProbeObservation> {
  const startedAt = clock.now();
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted === true) controller.abort();

  const probePromise = probe.run(controller.signal).then(
    (value) => ({ kind: "result" as const, value }),
    () => ({ kind: "failed" as const }),
  );
  const deadline = addDuration(startedAt, duration(timeoutMs));
  const deadlinePromise = clock
    .waitUntil(deadline, controller.signal)
    .then((outcome) => ({ kind: "deadline" as const, outcome }));
  const settled = await Promise.race([probePromise, deadlinePromise]);
  controller.abort();
  parentSignal?.removeEventListener("abort", onParentAbort);

  if (settled.kind === "deadline") {
    const cancelled = parentSignal?.aborted === true || settled.outcome === "aborted";
    return {
      state: "unknown",
      code: cancelled ? "probe-cancelled" : "probe-timed-out",
      message: cancelled ? "capability probe was cancelled" : "capability probe timed out",
      observedAt: startedAt,
      expiresAt: startedAt,
      recovery: cancelled
        ? null
        : { kind: "retry", handle: `capability:probe:${probe.capabilityId}` },
    };
  }
  if (settled.kind === "failed") {
    return {
      state: "unknown",
      code: "probe-unknown",
      message: "capability probe failed without a usable observation",
      observedAt: startedAt,
      expiresAt: addDuration(startedAt, duration(DEFAULT_CAPABILITY_PROBE_TTL_MS)),
      recovery: { kind: "retry", handle: `capability:probe:${probe.capabilityId}` },
    };
  }
  const ttlMs = boundedTtl(settled.value.ttlMs);
  const expiresAt = addDuration(startedAt, duration(ttlMs));
  if (settled.value.state === "healthy") {
    return {
      state: "healthy",
      code: "probe-unknown",
      message: "capability probe is healthy",
      observedAt: startedAt,
      expiresAt,
      recovery: null,
    };
  }
  return {
    state: settled.value.state,
    code: probeCode(settled.value.state),
    message: redactText(settled.value.message, 256),
    observedAt: startedAt,
    expiresAt,
    recovery:
      settled.value.recovery === undefined || settled.value.recovery === null
        ? null
        : {
            kind: settled.value.recovery.kind,
            handle: redactText(settled.value.recovery.handle, 120),
          },
  };
}

function validateProbes(
  registry: CapabilityRegistry,
  probes: readonly CapabilityProbePort[],
): CapabilityProbeError | null {
  if (probes.length > MAX_CAPABILITY_PROBES) {
    return { code: "too-many-probes", maximum: MAX_CAPABILITY_PROBES };
  }
  const seen = new Set<string>();
  for (const probe of probes) {
    if (seen.has(probe.capabilityId)) {
      return { code: "duplicate-probe", capabilityId: probe.capabilityId };
    }
    seen.add(probe.capabilityId);
    if (!registry.entries.some((entry) => entry.capabilityId === probe.capabilityId)) {
      return { code: "unknown-capability", capabilityId: probe.capabilityId };
    }
  }
  return null;
}

function emitHealthDiagnostics(
  snapshot: CapabilityHealthSnapshot,
  collector: DiagnosticsCollector | undefined,
  correlation: CorrelationIds,
): void {
  if (collector === undefined) return;
  for (const entry of snapshot.entries) {
    if (entry.health === "healthy") continue;
    collector.emit({
      level: entry.health === "degraded" || entry.health === "unknown" ? "warn" : "error",
      subsystem: "capability",
      code: entry.diagnostics[0]?.code ?? "unknown",
      correlation,
      stage: "health",
      metadata: {
        capabilityId: entry.capabilityId,
        consumer: entry.consumer,
        health: entry.health,
      },
    });
  }
}

/**
 * Probe a bounded subset, then fold those observations into one immutable
 * snapshot. A cancellation is terminal for the inspection; partial probe
 * results are not published as if they described the same observation point.
 */
export async function inspectProductCapabilityHealth(
  options: InspectProductCapabilityHealthOptions,
): Promise<Result<CapabilityHealthSnapshot, CapabilityProbeError>> {
  const cancelled = (): boolean => options.signal?.aborted ?? false;
  const probes = options.probes ?? [];
  const invalid = validateProbes(options.registry, probes);
  if (invalid !== null) return { ok: false, error: invalid };
  const concurrency = options.concurrency ?? MAX_CAPABILITY_PROBE_CONCURRENCY;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CAPABILITY_PROBE_CONCURRENCY
  ) {
    return {
      ok: false,
      error: { code: "invalid-concurrency", maximum: MAX_CAPABILITY_PROBE_CONCURRENCY },
    };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_CAPABILITY_PROBE_TIMEOUT_MS
  ) {
    return {
      ok: false,
      error: { code: "invalid-timeout", maximum: MAX_CAPABILITY_PROBE_TIMEOUT_MS },
    };
  }
  if (cancelled()) return { ok: false, error: { code: "cancelled" } };

  const observations: Record<string, CapabilityProbeObservation> = {};
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, probes.length) }, async () => {
    while (next < probes.length) {
      const index = next;
      next += 1;
      const probe = probes[index];
      if (probe === undefined) return;
      observations[probe.capabilityId] = await runProbe(
        probe,
        options.clock,
        timeoutMs,
        options.signal,
      );
    }
  });
  await Promise.all(workers);
  if (cancelled()) return { ok: false, error: { code: "cancelled" } };

  const snapshot = inspectCapabilityHealth(options.registry, options.consumer, {
    ...(options.evidence ?? {}),
    now: options.clock.now(),
    probes: observations,
  });
  emitHealthDiagnostics(snapshot, options.diagnostics, options.correlation ?? NO_CORRELATION);
  return { ok: true, value: snapshot };
}
