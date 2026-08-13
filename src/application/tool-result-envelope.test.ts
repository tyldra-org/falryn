import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  capabilityId,
  configurationGeneration,
  defaultProjectionContract,
  duration,
  instant,
  invocationId,
} from "../domain/index.ts";
import { createRuntimeRedactor, envelopeToolResult, REDACTED } from "./index.ts";

const outputSchema = z.object({ note: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

describe("envelopeToolResult", () => {
  test("redacts a recognizable secret in the projection and not in the canonical value", () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOP";
    const enveloped = envelopeToolResult({
      invocationId: invocationId.from("inv-1"),
      capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
      version: 1,
      catalogGeneration: configurationGeneration.from(0),
      outputSchema,
      maxOutputBytes: 4096,
      outcome: { status: "completed", output: { note: `see ${secret}` }, effect: "completed" },
      artifacts: [],
      diagnostics: [],
      timing: {
        startedAt: instant(1),
        endedAt: instant(2),
        queueMs: duration(0),
        executeMs: duration(1),
        captureMs: duration(0),
      },
      persistFailed: false,
      captureOverflow: false,
      projection: defaultProjectionContract(),
      redactor: createRuntimeRedactor(),
    });
    expect(enveloped.result.value).toEqual({ note: `see ${secret}` });
    expect(JSON.stringify(enveloped.projection.value)).not.toContain(secret);
    expect(JSON.stringify(enveloped.projection.value)).toContain(REDACTED);
  });
});
