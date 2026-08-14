import { describe, expect, test } from "bun:test";
import type { ManagedServiceRequest, PtySessionRequest } from "./index.ts";
import {
  duration,
  type ManagedServiceValidationCode,
  managedServiceId,
  type PtyValidationCode,
  ptyDimensions,
  serviceGeneration,
  validateManagedServiceRequest,
  validatePtySessionRequest,
} from "./index.ts";

const BASE_PTY: PtySessionRequest = {
  executable: "/bin/sh",
  argv: ["-c", "printf ready"],
  environment: { PATH: "/usr/bin:/bin" },
  dimensions: { columns: 80, rows: 24 },
};

const BASE_SERVICE: ManagedServiceRequest = {
  serviceId: managedServiceId.from("service-test"),
  protocol: "test",
  executable: "/bin/sh",
  argv: ["-c", "printf ready"],
  environment: { PATH: "/usr/bin:/bin" },
  readiness: {
    kind: "output-marker",
    marker: "ready",
    stream: "stdout",
    timeoutMs: duration(1_000),
  },
  idle: { kind: "disabled" },
  restart: { maxRestarts: 1, windowMs: duration(1_000) },
  shutdownTimeoutMs: duration(1_000),
};

describe("PTY request contracts", () => {
  test("accepts a bounded direct-argv request", () => {
    expect(validatePtySessionRequest(BASE_PTY)).toBeNull();
    expect(ptyDimensions(120, 40)).toEqual({ ok: true, value: { columns: 120, rows: 40 } });
  });

  test.each([
    ["relative executable", { ...BASE_PTY, executable: "sh" }, "invalid-executable"],
    ["relative working directory", { ...BASE_PTY, cwd: "workspace" }, "invalid-working-directory"],
    ["zero columns", { ...BASE_PTY, dimensions: { columns: 0, rows: 24 } }, "invalid-columns"],
    ["zero rows", { ...BASE_PTY, dimensions: { columns: 80, rows: 0 } }, "invalid-rows"],
    ["unsupported encoding", { ...BASE_PTY, encoding: "ascii" as "utf-8" }, "unsupported-encoding"],
  ])("rejects %s without exposing request data", (_name, request, reason) => {
    expect(validatePtySessionRequest(request)).toBe(reason as PtyValidationCode);
    expect(JSON.stringify(validatePtySessionRequest(request))).not.toContain("workspace");
  });

  test("bounds arguments and the supplied environment", () => {
    expect(
      validatePtySessionRequest({
        ...BASE_PTY,
        argv: Array.from({ length: 33 }, () => "arg"),
      }),
    ).toBe("too-many-arguments");
    expect(
      validatePtySessionRequest({
        ...BASE_PTY,
        environment: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`KEY_${index}`, "value"]),
        ),
      }),
    ).toBe("environment-too-large");
  });
});

describe("managed service request contracts", () => {
  test("accepts readiness, idle, restart, and shutdown policies", () => {
    expect(validateManagedServiceRequest(BASE_SERVICE)).toBeNull();
    const parsed = serviceGeneration.parse(1);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBe(serviceGeneration.from(1));
    }
  });

  test.each([
    ["empty protocol", { ...BASE_SERVICE, protocol: "" }, "invalid-protocol"],
    [
      "empty readiness marker",
      {
        ...BASE_SERVICE,
        readiness: { ...BASE_SERVICE.readiness, marker: "" },
      },
      "invalid-marker",
    ],
    [
      "negative restart budget",
      {
        ...BASE_SERVICE,
        restart: { ...BASE_SERVICE.restart, maxRestarts: -1 },
      },
      "invalid-restart-budget",
    ],
    [
      "zero shutdown timeout",
      { ...BASE_SERVICE, shutdownTimeoutMs: duration(0) },
      "invalid-shutdown-timeout",
    ],
  ])("rejects %s", (_name, request, reason) => {
    expect(validateManagedServiceRequest(request)).toBe(reason as ManagedServiceValidationCode);
  });
});
