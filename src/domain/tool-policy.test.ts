import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  authorizeToolInvocation,
  canonicalizeJson,
  capabilityId,
  classifyEffectForPolicy,
  configurationGeneration,
  confirmationInputFingerprint,
  createFocusedConfirmationRequest,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  describeToolPolicyDenyReason,
  type EffectClass,
  evaluateToolPolicy,
  invocationId,
  isToolPolicyDenyCode,
  resolveFocusedConfirmation,
  type ToolManifestDocument,
  validateAndNormalizeInvocations,
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
  overrides: Partial<ToolManifestDocument> = {},
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name: overrides.name ?? (effect === "observation" ? "read_file" : "write_file"),
    version: 1,
    source: "builtin",
    title: overrides.title ?? effect,
    description: `${effect} tool`,
    effect,
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits({ maxInputBytes: 1024 }),
    concurrency: defaultConcurrencyContract(),
    resultProjection: defaultProjectionContract(),
    ...overrides,
  };
}

function readyInvocation(
  effect: EffectClass,
  args: Readonly<Record<string, unknown>> = { path: "a.ts" },
) {
  const entry = createToolRegistryEntry(document(effect), {
    inputSchema: pathSchema,
    outputSchema: pathOutputSchema,
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
    proposals: [
      {
        toolCallId: "call-1",
        name: entry.value.manifest.name,
        arguments: args,
      },
    ],
    maxQueued: 8,
    nextInvocationId: () => invocationId.from("inv-1"),
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) {
    throw new Error("expected validate");
  }
  const ready = validated.value[0];
  if (ready === undefined) {
    throw new Error("expected invocation");
  }
  return ready;
}

describe("classifyEffectForPolicy", () => {
  test("covers every effect class with confirmation posture", () => {
    expect(classifyEffectForPolicy("observation")).toEqual({
      effectClass: "observation",
      consequential: false,
      confirmationPosture: "none",
    });
    for (const effect of ["mutation", "external", "interactive"] as const) {
      expect(classifyEffectForPolicy(effect)).toEqual({
        effectClass: effect,
        consequential: true,
        confirmationPosture: "focused",
      });
    }
  });
});

describe("evaluateToolPolicy", () => {
  test("allows observations without confirmation", () => {
    const invocation = readyInvocation("observation");
    const decision = evaluateToolPolicy(invocation);
    expect(decision.decision).toBe("allow");
    if (decision.decision !== "allow") {
      return;
    }
    expect(decision.classification.effectClass).toBe("observation");
  });

  test("requires focused confirmation for consequential effects", () => {
    for (const effect of ["mutation", "external", "interactive"] as const) {
      const invocation = readyInvocation(effect, { path: "out.ts" });
      const decision = evaluateToolPolicy(invocation);
      expect(decision.decision).toBe("require-confirmation");
      if (decision.decision !== "require-confirmation") {
        return;
      }
      expect(decision.confirmation.effectClass).toBe(effect);
      expect(decision.confirmation.normalizedInput).toEqual({ path: "out.ts" });
      expect(decision.confirmation.confirmationId.length).toBeGreaterThan(0);
    }
  });

  test("denies by name, capability, and effect with no effect", () => {
    const invocation = readyInvocation("observation");
    const byName = evaluateToolPolicy(invocation, {
      deniedNames: new Set(["read_file"]),
    });
    expect(byName.decision).toBe("deny");
    if (byName.decision === "deny") {
      expect(byName.effect).toBe("none");
      expect(byName.reason.code).toBe("denied-by-name");
      expect(describeToolPolicyDenyReason(byName.reason)).toBe("denied-by-name");
    }

    const byCap = evaluateToolPolicy(invocation, {
      deniedCapabilityIds: new Set([capabilityId.from("builtin:workspace/read_file@1")]),
    });
    expect(byCap.decision).toBe("deny");
    if (byCap.decision === "deny") {
      expect(byCap.reason.code).toBe("denied-by-capability");
    }

    const byEffect = evaluateToolPolicy(invocation, {
      deniedEffects: new Set(["observation"]),
    });
    expect(byEffect.decision).toBe("deny");
    if (byEffect.decision === "deny") {
      expect(byEffect.reason.code).toBe("denied-by-effect");
    }
  });

  test("auto-allow and force-confirmation profile overrides", () => {
    const mutation = readyInvocation("mutation");
    const auto = evaluateToolPolicy(mutation, {
      autoAllowEffects: new Set(["mutation"]),
    });
    expect(auto.decision).toBe("allow");

    const observation = readyInvocation("observation");
    const forced = evaluateToolPolicy(observation, {
      forceConfirmationEffects: new Set(["observation"]),
    });
    expect(forced.decision).toBe("require-confirmation");
  });
});

describe("focused confirmation", () => {
  test("accepts an exact confirmation and reports observed separately from intent", () => {
    const invocation = readyInvocation("mutation", { path: "src/a.ts" });
    const request = createFocusedConfirmationRequest(invocation);
    const accepted = resolveFocusedConfirmation({
      request,
      invocation,
      confirmation: { confirmationId: request.confirmationId },
    });
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") {
      return;
    }
    expect(accepted.observed).toBe("confirmed");
    expect(accepted.effect).toBe("none");
    expect(accepted.requestedIntent.toolName).toBe("write_file");
    expect(accepted.requestedIntent.normalizedInput).toEqual({ path: "src/a.ts" });
  });

  test("expires when normalized input changes", () => {
    const first = readyInvocation("mutation", { path: "a.ts" });
    const request = createFocusedConfirmationRequest(first);
    const second = readyInvocation("mutation", { path: "b.ts" });
    const stale = resolveFocusedConfirmation({
      request,
      invocation: second,
      confirmation: { confirmationId: request.confirmationId },
    });
    expect(stale.status).toBe("stale");
    if (stale.status !== "stale") {
      return;
    }
    expect(stale.observed).toBe("not-confirmed");
    expect(stale.effect).toBe("none");
  });

  test("refuses mismatch and explicit refusal without effect", () => {
    const invocation = readyInvocation("external");
    const request = createFocusedConfirmationRequest(invocation);
    const mismatch = resolveFocusedConfirmation({
      request,
      invocation,
      confirmation: { confirmationId: "other-id" },
    });
    expect(mismatch.status).toBe("mismatch");
    if (mismatch.status === "mismatch") {
      expect(mismatch.effect).toBe("none");
    }

    const refused = resolveFocusedConfirmation({
      request,
      invocation,
      confirmation: { confirmationId: request.confirmationId },
      refused: true,
    });
    expect(refused.status).toBe("refused");
    if (refused.status === "refused") {
      expect(refused.observed).toBe("refused");
      expect(refused.effect).toBe("none");
    }

    const missing = resolveFocusedConfirmation({
      request,
      invocation,
      confirmation: null,
    });
    expect(missing.status).toBe("missing");
  });

  test("authorizeToolInvocation gates consequential work until confirmed", () => {
    const invocation = readyInvocation("mutation", { path: "x.ts" });
    const pending = authorizeToolInvocation({ invocation });
    expect(pending.ok).toBe(false);
    if (pending.ok) {
      return;
    }
    expect(pending.decision.decision).toBe("require-confirmation");
    expect(pending.confirmationOutcome?.status).toBe("missing");

    if (pending.decision.decision !== "require-confirmation") {
      return;
    }
    const authorized = authorizeToolInvocation({
      invocation,
      confirmation: { confirmationId: pending.decision.confirmation.confirmationId },
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) {
      return;
    }
    expect(authorized.value.confirmation).toEqual({
      required: true,
      confirmationId: pending.decision.confirmation.confirmationId,
      observed: "confirmed",
    });
    expect(authorized.value.classification.effectClass).toBe("mutation");
  });

  test("authorizeToolInvocation allows observations immediately", () => {
    const invocation = readyInvocation("observation");
    const authorized = authorizeToolInvocation({ invocation });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) {
      return;
    }
    expect(authorized.value.confirmation).toEqual({ required: false });
  });

  test("deny codes are exhaustive and fingerprints are order-insensitive", () => {
    expect(isToolPolicyDenyCode("denied-by-name")).toBe(true);
    expect(isToolPolicyDenyCode("confirmation-missing")).toBe(false);
    expect(canonicalizeJson({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
    const left = confirmationInputFingerprint(
      capabilityId.from("builtin:workspace/write_file@1"),
      { b: 1, a: 2 },
      "mutation",
    );
    const right = confirmationInputFingerprint(
      capabilityId.from("builtin:workspace/write_file@1"),
      { a: 2, b: 1 },
      "mutation",
    );
    expect(left).toBe(right);
  });
});
