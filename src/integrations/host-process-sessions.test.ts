import { describe, expect, test } from "bun:test";
import {
  duration,
  type ManagedServiceEvent,
  type ManagedServiceRequest,
  managedServiceId,
  type PtySessionEvent,
  type PtySessionRequest,
  serviceGeneration,
} from "../domain/index.ts";
import { createHostManagedServicePort, createHostPtySessionPort } from "./host-process-sessions.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const ENVIRONMENT = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const decoder = new TextDecoder();

function ptyRequest(script: string): PtySessionRequest {
  return {
    executable: "/bin/sh",
    argv: ["-c", script],
    environment: ENVIRONMENT,
    dimensions: { columns: 80, rows: 24 },
    backlogBytes: 128,
  };
}

function serviceRequest(
  serviceId: string,
  script: string,
  overrides: Partial<ManagedServiceRequest> = {},
): ManagedServiceRequest {
  return {
    serviceId: managedServiceId.from(serviceId),
    protocol: "test",
    executable: "/bin/sh",
    argv: ["-c", script],
    environment: ENVIRONMENT,
    readiness: {
      kind: "output-marker",
      marker: "ready",
      stream: "stdout",
      timeoutMs: duration(2_000),
    },
    idle: { kind: "disabled" },
    restart: { maxRestarts: 0, windowMs: duration(2_000) },
    shutdownTimeoutMs: duration(1_000),
    replayBytes: 128,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition did not settle before the test deadline");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("host PTY sessions", () => {
  platformTest("opens, writes, resizes, detaches, and reattaches", async () => {
    const port = createHostPtySessionPort();
    const opened = await port.open(
      ptyRequest("printf 'ready\\n'; IFS= read line; printf 'got:%s\\n' \"$line\""),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    let output = decoder.decode(opened.value.replay.bytes);
    const events: PtySessionEvent[] = [];
    const attached = port.attach(opened.value.sessionId, (event) => {
      events.push(event);
      if (event.kind === "data") {
        output += decoder.decode(event.bytes);
      }
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) {
      return;
    }

    expect(port.resize(opened.value.sessionId, { columns: 100, rows: 30 })).toEqual({
      ok: true,
      value: { columns: 100, rows: 30 },
    });
    expect(port.write(opened.value.sessionId, new TextEncoder().encode("hello\n"))).toMatchObject({
      ok: true,
      value: { status: "accepted" },
    });

    await waitUntil(() => output.includes("got:hello"));
    expect(events.some((event) => event.kind === "opened")).toBe(false);
    expect(events.some((event) => event.kind === "resized")).toBe(true);

    attached.value.detach();
    attached.value.detach();
    const reattached = port.attach(opened.value.sessionId, () => {});
    expect(reattached.ok).toBe(true);
    if (reattached.ok) {
      expect(decoder.decode(reattached.value.replay.bytes)).toContain("got:hello");
      reattached.value.detach();
    }

    await waitUntil(() => port.snapshot(opened.value.sessionId)?.state === "exited");
    const snapshot = port.snapshot(opened.value.sessionId);
    expect(snapshot?.exit?.exitCode).toBe(0);
  });

  platformTest("reports termination separately from an already exited session", async () => {
    const port = createHostPtySessionPort();
    const opened = await port.open(ptyRequest("sleep 30"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const terminated = await port.terminate(opened.value.sessionId);
    expect(terminated.ok).toBe(true);
    if (!terminated.ok) {
      return;
    }
    expect(["terminated", "already-exited"]).toContain(terminated.value.kind);
    await waitUntil(() => port.snapshot(opened.value.sessionId)?.state === "exited");
    expect(port.write(opened.value.sessionId, new Uint8Array([1]))).toEqual({
      ok: false,
      error: { kind: "pty", code: "not-running", state: "exited" },
    });
  });

  test("rejects an oversized PTY input before it reaches the host", async () => {
    const port = createHostPtySessionPort();
    const result = await port.open({
      ...ptyRequest("sleep 1"),
      argv: ["-c", "sleep 1"],
    });
    if (result.ok) {
      const oversized = port.write(result.value.sessionId, new Uint8Array(64 * 1_024 + 1));
      expect(oversized).toEqual({
        ok: false,
        error: { kind: "pty", code: "input-too-large", maxBytes: 64 * 1_024 },
      });
      await port.terminate(result.value.sessionId);
    } else if (POSIX) {
      throw new Error(`PTY should have opened: ${result.error.code}`);
    }
  });
});

describe("host managed services", () => {
  platformTest("waits for readiness, serializes input, and stops cleanly", async () => {
    const port = createHostManagedServicePort();
    const started = await port.start(
      serviceRequest(
        "managed-echo",
        "printf ready; while IFS= read line; do printf 'reply:%s\\n' \"$line\"; done",
      ),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    let output = "";
    const events: ManagedServiceEvent[] = [];
    const attached = port.attach(started.value.serviceId, (event) => {
      events.push(event);
      if (event.kind === "output" && event.stream === "stdout") {
        output += decoder.decode(event.bytes);
      }
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) {
      return;
    }
    expect(decoder.decode(attached.value.replay.stdout)).toContain("ready");

    const sent = await port.send(
      started.value.serviceId,
      started.value.generation,
      new TextEncoder().encode("ping\n"),
    );
    expect(sent).toEqual({ ok: true, value: { acceptedBytes: 5 } });
    await waitUntil(() => output.includes("reply:ping"));
    expect(events.some((event) => event.kind === "ready")).toBe(false);

    const stopped = await port.stop(started.value.serviceId, started.value.generation);
    expect(stopped.ok).toBe(true);
    expect(port.snapshot(started.value.serviceId)?.state).toBe("stopped");
    attached.value.detach();
  });

  platformTest("invalidates an old generation after an automatic restart", async () => {
    const port = createHostManagedServicePort();
    const started = await port.start(
      serviceRequest("managed-restart", "printf ready; exit 7", {
        restart: { maxRestarts: 1, windowMs: duration(2_000) },
      }),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    await waitUntil(() => port.snapshot(started.value.serviceId)?.state === "failed");
    const current = port.snapshot(started.value.serviceId);
    expect(current?.generation).toBe(serviceGeneration.from(2));
    const stale = await port.send(
      started.value.serviceId,
      started.value.generation,
      new Uint8Array([1]),
    );
    expect(stale).toEqual({
      ok: false,
      error: { kind: "managed-service", code: "stale-generation" },
    });
  });

  platformTest("reports a no-restart policy for the first service crash", async () => {
    const port = createHostManagedServicePort();
    const failed = await port.start(
      serviceRequest("managed-no-restart", "exit 7", {
        restart: { maxRestarts: 0, windowMs: duration(2_000) },
      }),
    );

    expect(failed).toEqual({
      ok: false,
      error: { kind: "managed-service", code: "no-restart-policy" },
    });
    expect(port.snapshot(managedServiceId.from("managed-no-restart"))?.state).toBe("failed");
  });

  platformTest("applies the idle policy to a ready service", async () => {
    const port = createHostManagedServicePort();
    const started = await port.start(
      serviceRequest("managed-idle", "sleep 30", {
        readiness: { kind: "immediate" },
        idle: { kind: "timeout", timeoutMs: duration(50) },
        shutdownTimeoutMs: duration(500),
      }),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    await waitUntil(() => port.snapshot(started.value.serviceId)?.state === "stopped");
    expect(port.snapshot(started.value.serviceId)?.lastExit).not.toBeNull();
  });

  platformTest("keeps replay bounded while draining service output", async () => {
    const port = createHostManagedServicePort();
    const started = await port.start(
      serviceRequest("managed-replay", "printf ready; printf 12345678901234567890", {
        readiness: {
          kind: "output-marker",
          marker: "ready",
          stream: "stdout",
          timeoutMs: duration(2_000),
        },
        replayBytes: 8,
      }),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    await waitUntil(() => port.snapshot(started.value.serviceId)?.state === "failed");
    const attached = port.attach(started.value.serviceId, () => {});
    expect(attached.ok).toBe(true);
    if (attached.ok) {
      expect(attached.value.replay.stdout.byteLength).toBeLessThanOrEqual(8);
      expect(attached.value.replay.droppedStdoutBytes).toBeGreaterThan(0);
      attached.value.detach();
    }
  });
});
