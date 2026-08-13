import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  authorizeToolInvocation,
  configurationGeneration,
  conflictKey,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  describeToolScheduleError,
  type EffectClass,
  invocationId,
  isToolJoinPolicy,
  planToolSchedule,
  type ToolManifestDocument,
  validateAndNormalizeInvocations,
  workUnitIdForInvocation,
} from "./index.ts";

const generation = configurationGeneration.from(0);

const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;
const pathOutputSchema = z.object({ content: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function document(
  effect: EffectClass,
  name: string,
  overrides: Partial<ToolManifestDocument> = {},
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title: name,
    description: `${effect} tool`,
    effect,
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits({ maxInputBytes: 1024, maxOutputBytes: 2048 }),
    concurrency: defaultConcurrencyContract(),
    resultProjection: defaultProjectionContract(),
    ...overrides,
  };
}

function authorize(
  effect: EffectClass,
  name: string,
  id: string,
  args: Readonly<Record<string, unknown>> = { path: `${name}.ts` },
) {
  const entry = createToolRegistryEntry(document(effect, name), {
    inputSchema: pathSchema,
    outputSchema: pathOutputSchema,
    conflictKeysFor: (input) => [conflictKey("file", String(input.path))],
  });
  expect(entry.ok).toBe(true);
  if (!entry.ok) {
    throw new Error("expected entry");
  }
  const registry = createToolRegistry(generation, [entry.value]);
  expect(registry.ok).toBe(true);
  if (!registry.ok) {
    throw new Error("expected registry");
  }
  const validated = validateAndNormalizeInvocations({
    registry: registry.value,
    proposals: [{ toolCallId: `call-${id}`, name, arguments: args }],
    maxQueued: 8,
    nextInvocationId: () => invocationId.from(id),
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) {
    throw new Error("expected validate");
  }
  const ready = validated.value[0];
  if (ready === undefined) {
    throw new Error("expected invocation");
  }
  if (effect === "observation") {
    const authorized = authorizeToolInvocation({ invocation: ready });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) {
      throw new Error("expected authorize");
    }
    return authorized.value;
  }
  const pending = authorizeToolInvocation({ invocation: ready });
  expect(pending.ok).toBe(false);
  if (pending.ok) {
    throw new Error("expected confirmation");
  }
  expect(pending.decision.decision).toBe("require-confirmation");
  if (pending.decision.decision !== "require-confirmation") {
    throw new Error("expected require-confirmation");
  }
  const authorized = authorizeToolInvocation({
    invocation: ready,
    confirmation: { confirmationId: pending.decision.confirmation.confirmationId },
  });
  expect(authorized.ok).toBe(true);
  if (!authorized.ok) {
    throw new Error("expected confirmed authorize");
  }
  return authorized.value;
}

describe("planToolSchedule", () => {
  test("maps authorized invocations onto work units with conflict keys", () => {
    const authorized = authorize("observation", "read_file", "inv-1");
    const planned = planToolSchedule({
      items: [{ authorized }],
      joinPolicy: "all",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(planned.value.work).toHaveLength(1);
    const unit = planned.value.work[0]?.unit;
    expect(unit?.id).toBe(workUnitIdForInvocation(invocationId.from("inv-1")));
    expect(unit?.effect).toBe("observation");
    expect(unit?.conflictKeys).toEqual([conflictKey("file", "read_file.ts")]);
    expect(unit?.expectedOutputBytes).toBe(2048);
  });

  test("rejects empty batches, duplicates, unknown edges, and cycles", () => {
    expect(planToolSchedule({ items: [], joinPolicy: "all" }).ok).toBe(false);

    const first = authorize("observation", "read_file", "inv-1");
    const duplicate = planToolSchedule({
      items: [{ authorized: first }, { authorized: first }],
      joinPolicy: "all",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("duplicate-invocation");
      expect(describeToolScheduleError(duplicate.error)).toBe("duplicate-invocation");
    }

    const unknown = planToolSchedule({
      items: [
        {
          authorized: first,
          dependencies: [invocationId.from("missing")],
        },
      ],
      joinPolicy: "all",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("unknown-dependency");
    }

    const second = authorize("observation", "read_other", "inv-2", { path: "other.ts" });
    const cycle = planToolSchedule({
      items: [
        { authorized: first, dependencies: [invocationId.from("inv-2")] },
        { authorized: second, dependencies: [invocationId.from("inv-1")] },
      ],
      joinPolicy: "all",
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) {
      expect(cycle.error.code).toBe("dependency-cycle");
    }
  });

  test("rejects an oversized batch and an invalid join policy", () => {
    const authorized = authorize("observation", "read_file", "inv-1");
    const oversized = planToolSchedule({
      items: [{ authorized }],
      joinPolicy: "all",
      maxQueued: 0,
    });
    expect(oversized.ok).toBe(true);

    const bounded = planToolSchedule({
      items: [{ authorized }, { authorized: authorize("observation", "read_other", "inv-2") }],
      joinPolicy: "all",
      maxQueued: 1,
    });
    expect(bounded.ok).toBe(false);
    if (!bounded.ok) {
      expect(bounded.error.code).toBe("queue-bound-exceeded");
    }

    expect(isToolJoinPolicy("all")).toBe(true);
    expect(isToolJoinPolicy("join-later")).toBe(false);
    const invalid = planToolSchedule({
      items: [{ authorized }],
      joinPolicy: "nope" as "all",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid-join-policy");
    }
  });
});
