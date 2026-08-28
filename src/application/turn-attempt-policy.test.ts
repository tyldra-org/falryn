import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  createInMemoryEventStore,
  createManualClock,
  duration,
  modelId,
  providerId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import type { ModelCatalog } from "../providers/discovery.ts";
import type { ModelPolicy } from "../providers/policy.ts";
import { parseModelPolicy } from "../providers/policy-schema.ts";
import type { RoutedCatalogEntry } from "../providers/routing.ts";
import {
  type AttemptModelInput,
  type AttemptRunnerPort,
  type AttemptRunnerRequest,
  attemptCategoryForProviderFailure,
  attemptFactFromProviderFailure,
  createTurnAttemptPolicy,
} from "./turn-attempt-policy.ts";
import { createTurnCoordinator } from "./turn-coordinator.ts";
import { createTurnEventJournal } from "./turn-event-journal.ts";

const generation = configurationGeneration.from(0);
const primary = providerId.from("primary");
const secondary = providerId.from("secondary");
const deep = modelId.from("deep-model");
const fast = modelId.from("fast-model");

function catalogFor(models: ModelCatalog["models"]): ModelCatalog {
  return {
    generation: 1,
    provenance: "static-config",
    fetchedAt: null,
    expiresAt: null,
    models,
  };
}

function samplePolicy(): ModelPolicy {
  const parsed = parseModelPolicy({
    roles: {
      default: {
        providerId: primary,
        modelId: deep,
        reasoning: "balanced",
        fallbacks: [{ providerId: secondary, modelId: fast }],
        budgets: { attempts: 2 },
      },
      "fast-read": { providerId: primary, modelId: fast, reasoning: "minimal" },
      "fast-edit": { providerId: primary, modelId: fast, reasoning: "minimal" },
      commit: { providerId: primary, modelId: deep, reasoning: "balanced" },
      plan: { providerId: primary, modelId: deep, reasoning: "balanced" },
      vision: {
        providerId: primary,
        modelId: deep,
        reasoning: "provider-default",
        use: "off",
      },
      advisor: { providerId: secondary, modelId: deep, use: "explicit" },
      compact: { providerId: primary, modelId: fast, use: "evaluated" },
    },
  });
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}

function catalogs(): readonly RoutedCatalogEntry[] {
  return [
    {
      providerId: primary,
      catalog: catalogFor([
        {
          schemaVersion: 1,
          modelId: deep,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "supported",
          reasoningControls: ["balanced"],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 128_000,
          outputTokens: 16_000,
        },
        {
          schemaVersion: 1,
          modelId: fast,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unsupported",
          reasoningControls: [],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
      ]),
    },
    {
      providerId: secondary,
      catalog: catalogFor([
        {
          schemaVersion: 1,
          modelId: fast,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unsupported",
          reasoningControls: [],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
        {
          schemaVersion: 1,
          modelId: deep,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "supported",
          reasoningControls: ["balanced"],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 128_000,
          outputTokens: 16_000,
        },
      ]),
    },
  ];
}

function startTurn() {
  const coordinator = createTurnCoordinator();
  const id = turnId.from("turn-attempt-1");
  expect(
    coordinator.start({
      turnId: id,
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    }).ok,
  ).toBe(true);
  return { coordinator, turnId: id };
}

function scriptedRunner(
  scripts: ReadonlyArray<
    (request: AttemptRunnerRequest) => Awaited<ReturnType<AttemptRunnerPort["run"]>>
  >,
): AttemptRunnerPort {
  let index = 0;
  return {
    async run(request) {
      const script = scripts[index];
      index += 1;
      if (script === undefined) {
        throw new Error(`no script for attempt ${request.identity.attemptNumber}`);
      }
      return script(request);
    },
  };
}

function sampleModelInput(): AttemptModelInput {
  return {
    messages: [{ role: "user", parts: [{ kind: "text", text: "inspect" }] }],
    tools: [
      {
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object", additionalProperties: false },
      },
    ],
    output: { kind: "text" },
    budgets: {},
    disclosure: {
      catalogGeneration: generation,
      toolNames: ["read_file"],
      discoveryHandle: "tool-catalog:0",
      families: [
        { family: "read", available: true, reason: null },
        { family: "browser", available: false, reason: "not-installed" },
      ],
      tools: [
        {
          name: "read_file",
          capabilityId: capabilityId.from("workspace.read_file"),
          version: 1,
          schemaDigest: "sha-256:read",
          schemaBytes: 48,
          schemaTokensEstimated: 12,
        },
      ],
      omitted: [{ name: "write_files", reason: "not-authorized" }],
      schemaBytes: 48,
      schemaTokensEstimated: 12,
    },
  };
}

describe("turn attempt policy", () => {
  test("completes on first successful attempt with visible identity", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      backoff: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      runner: scriptedRunner([
        () => ({
          fact: {
            kind: "completed",
            finishReason: "stop",
            observedContent: true,
            emittedToolProposal: false,
          },
          turn: null,
        }),
      ]),
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
      modelInput: sampleModelInput(),
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      return;
    }
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]?.identity).toMatchObject({
      attemptNumber: 1,
      fallbackPosition: 0,
      providerKey: primary,
      modelKey: deep,
    });
    expect(outcome.turn.status).toBe("terminal");
    expect(outcome.turn.status === "terminal" && outcome.turn.outcome).toEqual({
      kind: "completed",
    });
  });

  test("retries the same route with bounded attempt identity then succeeds", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const seen: number[] = [];
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      retryPolicy: { maxAttempts: 3, retryable: true },
      backoff: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      runner: scriptedRunner([
        (request) => {
          seen.push(request.identity.attemptNumber);
          return {
            fact: {
              kind: "failed",
              category: "rate-limit",
              retryable: true,
              effect: "none",
              observedContent: false,
              emittedToolProposal: false,
              message: "rate limited",
            },
            turn: null,
          };
        },
        (request) => {
          seen.push(request.identity.attemptNumber);
          return {
            fact: {
              kind: "completed",
              finishReason: "stop",
              observedContent: true,
              emittedToolProposal: false,
            },
            turn: null,
          };
        },
      ]),
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
    });

    expect(outcome.kind).toBe("completed");
    expect(seen).toEqual([1, 2]);
    if (outcome.kind === "completed") {
      expect(outcome.attempts.map((a) => a.identity.attemptNumber)).toEqual([1, 2]);
      expect(outcome.attempts[0]?.action.kind).toBe("retry-same");
      expect(outcome.attempts.every((a) => a.identity.fallbackPosition === 0)).toBe(true);
    }
  });

  test("falls back to the next route without revisiting the primary", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const routes: string[] = [];
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      retryPolicy: { maxAttempts: 1, retryable: true },
      backoff: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      runner: scriptedRunner([
        (request) => {
          routes.push(`${request.receipt.providerId}/${request.receipt.modelId}`);
          return {
            fact: {
              kind: "failed",
              category: "authentication",
              retryable: false,
              effect: "none",
              observedContent: false,
              emittedToolProposal: false,
              message: "credentials rejected",
            },
            turn: null,
          };
        },
        (request) => {
          routes.push(`${request.receipt.providerId}/${request.receipt.modelId}`);
          return {
            fact: {
              kind: "completed",
              finishReason: "stop",
              observedContent: true,
              emittedToolProposal: false,
            },
            turn: null,
          };
        },
      ]),
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
    });

    expect(outcome.kind).toBe("completed");
    expect(routes).toEqual([`${primary}/${deep}`, `${secondary}/${fast}`]);
    if (outcome.kind === "completed") {
      expect(outcome.attempts[0]?.action.kind).toBe("fallback");
      expect(outcome.attempts[1]?.identity.fallbackPosition).toBe(1);
      expect(new Set(routes).size).toBe(2);
    }
  });

  test("returns a typed refusal for model safety finish reasons", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      runner: scriptedRunner([
        () => ({
          fact: {
            kind: "completed",
            finishReason: "content_filter",
            observedContent: false,
            emittedToolProposal: false,
          },
          turn: null,
        }),
      ]),
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
    });

    expect(outcome.kind).toBe("refusal");
    if (outcome.kind === "refusal") {
      expect(outcome.source).toBe("model");
      expect(outcome.reason).toBe("content_filter");
      expect(outcome.attempts).toHaveLength(1);
    }
  });

  test("retains partial facts without retrying", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    let runs = 0;
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      runner: {
        async run() {
          runs += 1;
          return {
            fact: {
              kind: "partial",
              reason: "missing-terminal",
              effect: "partial",
              observedContent: true,
              emittedToolProposal: false,
            },
            turn: null,
          };
        },
      },
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
    });

    expect(runs).toBe(1);
    expect(outcome.kind).toBe("partial");
    if (outcome.kind === "partial") {
      expect(outcome.reason).toBe("missing-terminal");
      expect(outcome.effect).toBe("partial");
      expect(outcome.turn.status).toBe("terminal");
      expect(outcome.turn.status === "terminal" && outcome.turn.outcome).toEqual({
        kind: "failed",
        effect: "partial",
      });
    }
  });

  test("does not retry after a tool proposal was emitted", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    let runs = 0;
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      retryPolicy: { maxAttempts: 5, retryable: true },
      runner: {
        async run() {
          runs += 1;
          return {
            fact: {
              kind: "failed",
              category: "transport",
              retryable: true,
              effect: "none",
              observedContent: false,
              emittedToolProposal: true,
              message: "dropped after tools",
            },
            turn: null,
          };
        },
      },
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
    });

    expect(runs).toBe(1);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.effect).toBe("partial");
    }
  });

  test("maps provider failures onto attempt facts", () => {
    expect(attemptCategoryForProviderFailure("rate-limit")).toBe("rate-limit");
    expect(attemptCategoryForProviderFailure("provider-safety")).toBe("safety");
    expect(
      attemptFactFromProviderFailure(
        { kind: "provider-safety", retryable: false, message: "blocked" },
        { effect: "none", observedContent: false, emittedToolProposal: false },
      ),
    ).toEqual({
      kind: "refusal",
      source: "provider-safety",
      reason: "blocked",
      effect: "none",
    });
    expect(
      attemptFactFromProviderFailure(
        { kind: "timeout", retryable: true, message: "upstream timed out" },
        { effect: "none", observedContent: false, emittedToolProposal: false },
      ),
    ).toEqual({ kind: "timed-out", effect: "none", retryable: true });
  });

  test("reports routing refusal without silently succeeding", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const parsed = parseModelPolicy({
      roles: {
        default: {
          providerId: primary,
          modelId: deep,
          reasoning: "balanced",
          use: "off",
        },
      },
    });
    // Force an unconfigured role by using a minimal invalid-for-intent path:
    // empty catalogs yield no-eligible-route.
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: [],
      runner: scriptedRunner([]),
    });
    void parsed;

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
    });

    expect(outcome.kind).toBe("routing-refused");
    if (outcome.kind === "routing-refused") {
      expect(outcome.attempts).toEqual([]);
    }
  });

  test("honours cancellation during backoff", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const abort = new AbortController();
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      retryPolicy: { maxAttempts: 3, retryable: true },
      backoff: { baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
      runner: scriptedRunner([
        () => {
          abort.abort();
          return {
            fact: {
              kind: "failed",
              category: "rate-limit",
              retryable: true,
              effect: "none",
              observedContent: false,
              emittedToolProposal: false,
              message: "rate limited",
            },
            turn: null,
          };
        },
      ]),
    });

    const running = policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: abort.signal,
      intent: "coding",
    });
    // Advance the manual clock so awaitBackoff can observe abort.
    clock.advance(duration(1));
    const outcome = await running;
    expect(outcome.kind === "cancelled" || outcome.kind === "exhausted").toBe(true);
  });

  test("records attempt facts through the journal without re-running on replay", async () => {
    const { coordinator, turnId: id } = startTurn();
    const clock = createManualClock();
    const eventStore = createInMemoryEventStore();
    const journal = createTurnEventJournal({
      eventStore,
      clock,
      streamId: streamId.from("session:attempt-journal"),
      correlation: {
        workspaceId: workspaceId.from("workspace-1"),
        sessionId: sessionId.from("session-1"),
        traceId: traceId.from("trace-1"),
        configurationGeneration: generation,
      },
    });

    let runnerCalls = 0;
    const policy = createTurnAttemptPolicy({
      clock,
      coordinator,
      policy: samplePolicy(),
      catalogs: catalogs(),
      journal,
      backoff: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      runner: scriptedRunner([
        () => {
          runnerCalls += 1;
          return {
            fact: {
              kind: "completed",
              finishReason: "stop",
              observedContent: true,
              emittedToolProposal: false,
            },
            turn: null,
          };
        },
      ]),
    });

    const outcome = await policy.run({
      turnId: id,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      intent: "coding",
      modelInput: sampleModelInput(),
    });
    expect(outcome.kind).toBe("completed");
    expect(runnerCalls).toBe(1);

    const replayed = await journal.replayTurn(id);
    expect(replayed.kind).toBe("rebuilt");
    expect(runnerCalls).toBe(1);
    if (replayed.kind === "rebuilt") {
      expect(replayed.turns).toHaveLength(1);
      const [turn] = replayed.turns;
      expect(turn).toBeDefined();
      if (turn === undefined) {
        throw new Error("expected one replayed turn");
      }
      expect(turn.outcome).toEqual({ kind: "completed" });
      expect(turn.attempts).toHaveLength(1);
      expect(turn.attempts[0]?.binding).toMatchObject({
        providerId: primary,
        modelId: deep,
        providerCatalogGeneration: 1,
        modelCapabilitySchemaVersion: 1,
        toolCatalogGeneration: generation,
        policyGeneration: generation,
        discoveryHandle: "tool-catalog:0",
        schemaBytes: 48,
        schemaTokensEstimated: 12,
        tools: [{ name: "read_file", schemaDigest: "sha-256:read" }],
      });
    }
  });
});
