import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  artifactId,
  assembleCapabilityResult,
  capabilityId,
  configurationGeneration,
  defaultProjectionContract,
  duration,
  instant,
  invocationId,
  projectCapabilityResult,
  type SensitiveValueRedactor,
  type TimingBreakdown,
} from "./index.ts";

const outputSchema = z.object({ content: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const timing: TimingBreakdown = {
  startedAt: instant(1_000),
  endedAt: instant(1_250),
  queueMs: duration(10),
  executeMs: duration(200),
  captureMs: duration(40),
};

const redactor: SensitiveValueRedactor = {
  placeholder: "[redacted]",
  redactText: (text, maxLength = 300) =>
    text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text,
  isSecretName: (key) => key.toLowerCase().includes("token"),
};

function assemble(overrides: Partial<Parameters<typeof assembleCapabilityResult>[0]> = {}) {
  return assembleCapabilityResult({
    invocationId: invocationId.from("inv-1"),
    capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
    version: 1,
    catalogGeneration: configurationGeneration.from(0),
    outputSchema,
    maxOutputBytes: 1024,
    outcome: { status: "completed", output: { content: "ok" }, effect: "completed" },
    artifacts: [],
    diagnostics: [{ code: "tool.capture", level: "info", stage: "capture" }],
    timing,
    persistFailed: false,
    captureOverflow: false,
    ...overrides,
  });
}

describe("assembleCapabilityResult", () => {
  test("completes with validated output, diagnostics, timing, and provenance", () => {
    const result = assemble({
      containedOutcome: { kind: "process", exitCode: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.effect).toBe("completed");
    expect(result.value).toEqual({ content: "ok" });
    expect(result.error).toBeNull();
    expect(result.containedOutcome).toEqual({ kind: "process", exitCode: 1 });
    expect(result.diagnostics).toEqual([{ code: "tool.capture", level: "info", stage: "capture" }]);
    expect(result.timing).toEqual(timing);
    expect(result.provenance.invocationId).toBe(invocationId.from("inv-1"));
  });

  test("treats a result-schema failure as an executor defect, not success", () => {
    const result = assemble({
      outcome: { status: "completed", output: { nope: true }, effect: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.value).toBeNull();
    expect(result.error?.code).toBe("tool.output-schema");
    expect(result.error?.category).toBe("tool");
    expect(result.error?.retryable).toBe(false);
    expect(result.effect).toBe("completed");
  });

  test("refuses completed when a required artifact was not committed", () => {
    const result = assemble({
      artifacts: [
        {
          artifactId: artifactId.from("spill-1"),
          required: true,
          committed: false,
          truncated: false,
        },
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("tool.required-artifact");
    expect(result.value).toBeNull();
  });

  test("keeps effect status when capture overflows and records truncation", () => {
    const result = assemble({
      captureOverflow: true,
      artifacts: [
        {
          artifactId: artifactId.from("spill-2"),
          required: false,
          committed: true,
          truncated: true,
        },
      ],
    });
    expect(result.status).toBe("completed");
    expect(result.effect).toBe("completed");
    expect(result.captureTruncated).toBe(true);
    expect(result.value).toEqual({ content: "ok" });
  });

  test("stops a completion claim when persistence fails", () => {
    const result = assemble({ persistFailed: true });
    expect(result.status).toBe("failed");
    expect(result.effect).toBe("uncertain");
    expect(result.error?.code).toBe("tool.result-persist-failed");
    expect(result.error?.recovery).toEqual(["inspect-state"]);
    expect(result.value).toBeNull();
  });

  test("maps cancelled, timed-out, and uncertain without claiming output", () => {
    const cancelled = assemble({
      outcome: { status: "cancelled", effect: "uncertain" },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error?.code).toBe("tool.cancelled");
    expect(cancelled.value).toBeNull();

    const timedOut = assemble({
      outcome: { status: "timed-out", effect: "none" },
    });
    expect(timedOut.status).toBe("timed-out");
    expect(timedOut.error?.code).toBe("tool.timed-out");

    const uncertain = assemble({
      outcome: { status: "uncertain", effect: "uncertain", recoveryHint: "inspect" },
    });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.error?.code).toBe("tool.uncertain");
  });

  test("maps denied, unavailable, malformed, and failed with no completed output", () => {
    expect(
      assemble({ outcome: { status: "denied", reason: "policy", effect: "none" } }).error?.code,
    ).toBe("tool.denied");
    expect(
      assemble({ outcome: { status: "unavailable", reason: "offline", effect: "none" } }).error
        ?.retryable,
    ).toBe(true);
    expect(
      assemble({ outcome: { status: "malformed", reason: "args", effect: "none" } }).effect,
    ).toBe("none");
    const failed = assemble({
      outcome: { status: "failed", reason: "runner-error", effect: "none" },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error?.retryable).toBe(true);
  });

  test("keeps a partial value only when the schema still holds", () => {
    const result = assemble({
      outcome: { status: "partial", output: { content: "chunk" }, effect: "partial" },
    });
    expect(result.status).toBe("partial");
    expect(result.value).toEqual({ content: "chunk" });
    expect(result.error?.code).toBe("tool.partial");
  });
});

describe("projectCapabilityResult", () => {
  test("redacts secret-named fields and leaves canonical output intact", () => {
    const schema = z.object({ token: z.string(), content: z.string() }).strict() as z.ZodType<
      Readonly<Record<string, unknown>>
    >;
    const result = assemble({
      outputSchema: schema,
      outcome: {
        status: "completed",
        output: { token: "secret-value", content: "ok" },
        effect: "completed",
      },
    });
    const view = projectCapabilityResult(result, defaultProjectionContract(), redactor);
    expect(result.value).toEqual({ token: "secret-value", content: "ok" });
    expect(view.value).toEqual({ token: "[redacted]", content: "ok" });
    expect(view.truncated).toBe(false);
  });

  test("omits over-budget projections instead of claiming a truncated JSON value", () => {
    const result = assemble({
      outcome: { status: "completed", output: { content: "abcdefghij" }, effect: "completed" },
    });
    const view = projectCapabilityResult(
      result,
      defaultProjectionContract({ modelMaxBytes: 8, redactSensitive: false }),
      redactor,
    );
    expect(result.value).toEqual({ content: "abcdefghij" });
    expect(view.value).toEqual({
      omitted: true,
      bytes: new TextEncoder().encode(JSON.stringify({ content: "abcdefghij" })).byteLength,
    });
    expect(view.truncated).toBe(true);
    expect(view.omittedBytes).toBeGreaterThan(8);
  });
});
