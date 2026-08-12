/**
 * Deterministic provider contract / conformance suite (#39).
 *
 * Exercises the public `src/providers/index.ts` surface with the fixture
 * adapter and boundary helpers. No live vendor HTTP. Live/opt-in network
 * tests must never be required by `bun run check`.
 */

import { describe, expect, test } from "bun:test";

import {
  type CredentialReference,
  createManualClock,
  modelId,
  providerId,
} from "../domain/index.ts";
import {
  createDeterministicProviderAdapter,
  createDeterministicRemoteDiscovery,
  createStaticModelDiscovery,
  deterministicEchoRequest,
  discoverModelCatalog,
  isProviderFailureKind,
  type ModelCatalog,
  type ModelPolicy,
  type NormalizedProviderEvent,
  normalizeProviderStream,
  PROVIDER_BOUNDARY_SCHEMA_VERSION,
  PROVIDER_FAILURE_KINDS,
  type ProviderFailureKind,
  type ProviderProfile,
  parseModelPolicy,
  parseModelRequest,
  type RoutedCatalogEntry,
  type RoutingReceipt,
  redactProviderDiagnosticText,
  resolveModelRoute,
  resolveNextFallback,
} from "./index.ts";

const REFERENCE: CredentialReference = {
  storeKind: "environment",
  locator: "FALRYN_CONFORMANCE_PROVIDER_KEY",
  consumer: "provider:conformance",
  accountLabel: "test",
};

const primary = providerId.from("demo-provider");
const secondary = providerId.from("demo-fallback");
const fast = modelId.from("demo-fast");
const vision = modelId.from("demo-vision");

function demoProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    profileId: "conformance",
    providerId: primary,
    adapterKind: "deterministic",
    displayName: "Conformance",
    endpoint: null,
    credential: REFERENCE,
    organization: null,
    project: null,
    enabledModels: [fast, vision],
    discovery: "static",
    timeouts: { connectMs: 5_000, requestMs: 30_000 },
    ...overrides,
  };
}

function catalogFor(models: ModelCatalog["models"], generation = 1): ModelCatalog {
  return {
    generation,
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
        modelId: fast,
        reasoning: "minimal",
        fallbacks: [{ providerId: secondary, modelId: fast }],
      },
      vision: {
        providerId: primary,
        modelId: vision,
        use: "fallback",
      },
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
          modelId: fast,
          modalities: ["text"],
          tools: true,
          streaming: true,
          reasoning: false,
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
        {
          modelId: vision,
          modalities: ["text", "image"],
          tools: true,
          streaming: true,
          reasoning: false,
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
      ]),
    },
    {
      providerId: secondary,
      catalog: catalogFor(
        [
          {
            modelId: fast,
            modalities: ["text"],
            tools: true,
            streaming: true,
            reasoning: false,
            contextTokens: 8_000,
            outputTokens: 2_000,
          },
        ],
        3,
      ),
    },
  ];
}

async function collectStream(
  events: AsyncIterable<NormalizedProviderEvent>,
): Promise<NormalizedProviderEvent[]> {
  const out: NormalizedProviderEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

async function normalizeToTerminal(events: AsyncIterable<NormalizedProviderEvent>) {
  const iterator = normalizeProviderStream(events);
  let result = await iterator.next();
  while (!result.done) {
    result = await iterator.next();
  }
  return result.value;
}

describe("provider conformance: failure vocabulary", () => {
  test("exposes the closed failure kind set from the design contract", () => {
    expect(PROVIDER_FAILURE_KINDS).toEqual([
      "network",
      "authentication",
      "authorization",
      "rate-limit",
      "invalid-request",
      "unsupported-capability",
      "malformed-stream",
      "provider-safety",
      "server-failure",
      "cancellation",
      "timeout",
      "adapter-defect",
    ]);
    for (const kind of PROVIDER_FAILURE_KINDS) {
      expect(isProviderFailureKind(kind)).toBe(true);
    }
    expect(isProviderFailureKind("billing-surprise")).toBe(false);
  });
});

describe("provider conformance: request translation", () => {
  test("accepts a valid request and rejects unknown/secret fields without echo", () => {
    const accepted = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-conf-1",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    });
    expect(accepted.ok).toBe(true);

    const rejected = parseModelRequest({
      schemaVersion: PROVIDER_BOUNDARY_SCHEMA_VERSION,
      requestId: "req-conf-2",
      providerId: "openai",
      modelId: "gpt-test",
      messages: [{ role: "user", parts: [{ kind: "text", text: "prompt" }] }],
      tools: [],
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
      authorization: "Bearer sk-abcdefghijklmnop",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      const serialized = JSON.stringify(rejected.error);
      expect(serialized).not.toContain("sk-abcdefghijklmnop");
      expect(serialized).not.toContain("Bearer");
    }
  });
});

describe("provider conformance: classified failures and retryability", () => {
  const cases: ReadonlyArray<{
    failureKind: ProviderFailureKind;
    retryable: boolean;
    message: string;
  }> = [
    { failureKind: "authentication", retryable: false, message: "credentials rejected" },
    { failureKind: "rate-limit", retryable: true, message: "provider rate limited" },
    { failureKind: "timeout", retryable: true, message: "upstream timed out" },
    { failureKind: "invalid-request", retryable: false, message: "schema rejected upstream" },
    { failureKind: "provider-safety", retryable: false, message: "safety filter" },
  ];

  for (const fixture of cases) {
    test(`scripts ${fixture.failureKind} with retryable=${fixture.retryable}`, async () => {
      const adapter = createDeterministicProviderAdapter({
        script: {
          kind: "error",
          failureKind: fixture.failureKind,
          message: fixture.message,
          retryable: fixture.retryable,
        },
      });
      const events = await collectStream(
        adapter.stream(deterministicEchoRequest(), { signal: new AbortController().signal }),
      );
      expect(events.map((event) => event.kind)).toEqual(["request-started", "error"]);
      const terminal = events[1];
      expect(terminal?.kind).toBe("error");
      if (terminal?.kind === "error") {
        expect(terminal.failure.kind).toBe(fixture.failureKind);
        expect(terminal.failure.retryable).toBe(fixture.retryable);
        expect(terminal.failure.message).toBe(fixture.message);
      }
    });
  }
});

/** Abort only after the stream has entered generation (past the pre-start check). */
async function collectAbortingAfter(
  events: AsyncIterable<NormalizedProviderEvent>,
  controller: AbortController,
  afterKind: NormalizedProviderEvent["kind"],
): Promise<NormalizedProviderEvent[]> {
  const out: NormalizedProviderEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (event.kind === afterKind && !controller.signal.aborted) {
      controller.abort();
    }
  }
  return out;
}

describe("provider conformance: cancellation and timeout", () => {
  test("pre-aborted signal terminates as cancellation", async () => {
    const adapter = createDeterministicProviderAdapter();
    const controller = new AbortController();
    controller.abort();
    const events = await collectStream(
      adapter.stream(deterministicEchoRequest(), { signal: controller.signal }),
    );
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("error");
    if (terminal?.kind === "error") {
      expect(terminal.failure.kind).toBe("cancellation");
      expect(terminal.failure.retryable).toBe(false);
    }
  });

  test("mid-stream abort classifies as cancellation", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: { kind: "abortable", prefixText: "partial", hangUntilAbort: true },
    });
    const controller = new AbortController();
    const events = await collectAbortingAfter(
      adapter.stream(deterministicEchoRequest(), { signal: controller.signal }),
      controller,
      "text-delta",
    );
    expect(events.some((event) => event.kind === "text-delta")).toBe(true);
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("error");
    if (terminal?.kind === "error") {
      expect(terminal.failure.kind).toBe("cancellation");
    }
  });

  test("mid-stream abort can classify as timeout", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "abortable",
        prefixText: "partial",
        hangUntilAbort: true,
        abortFailureKind: "timeout",
      },
    });
    const controller = new AbortController();
    const events = await collectAbortingAfter(
      adapter.stream(deterministicEchoRequest(), { signal: controller.signal }),
      controller,
      "text-delta",
    );
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("error");
    if (terminal?.kind === "error") {
      expect(terminal.failure.kind).toBe("timeout");
      expect(terminal.failure.retryable).toBe(true);
    }
  });
});

describe("provider conformance: stream assembly and terminals", () => {
  test("assembles fragmented text, reasoning, and finish reason", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "text",
        textFragments: ["hel", "lo"],
        reasoningFragments: ["rea", "son"],
        finishReason: "length",
        usage: { provenance: "provider-reported", outputTokens: 2 },
      },
    });
    const terminal = await normalizeToTerminal(
      adapter.stream(deterministicEchoRequest(), { signal: new AbortController().signal }),
    );
    expect(terminal.kind).toBe("finished");
    if (terminal.kind === "finished") {
      expect(terminal.snapshot.text).toBe("hello");
      expect(terminal.snapshot.reasoning).toBe("reason");
      expect(terminal.finishReason).toBe("length");
      expect(terminal.snapshot.usage).toEqual({
        provenance: "provider-reported",
        outputTokens: 2,
      });
    }
  });

  test("assembles fragmented tool JSON into a proposal", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "tool",
        toolCallId: "call-conf-1",
        name: "read_file",
        argumentFragments: ['{"path":', '"x.ts"}'],
        finishReason: "tool-calls",
        usage: null,
      },
    });
    const terminal = await normalizeToTerminal(
      adapter.stream(deterministicEchoRequest(), { signal: new AbortController().signal }),
    );
    expect(terminal.kind).toBe("finished");
    if (terminal.kind === "finished") {
      expect(terminal.finishReason).toBe("tool-calls");
      expect(terminal.snapshot.usage).toBeNull();
      expect(terminal.snapshot.toolProposals).toHaveLength(1);
      expect(terminal.snapshot.toolProposals[0]?.arguments).toEqual({ path: "x.ts" });
    }
  });

  test("missing terminal is an adapter-defect failure", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: { kind: "text", text: "orphan", usage: null, omitTerminal: true },
    });
    const terminal = await normalizeToTerminal(
      adapter.stream(deterministicEchoRequest(), { signal: new AbortController().signal }),
    );
    expect(terminal.kind).toBe("failed");
    if (terminal.kind === "failed") {
      expect(terminal.failure.kind).toBe("adapter-defect");
      expect(terminal.snapshot.diagnostics.some((d) => d.code === "missing-terminal")).toBe(true);
    }
  });

  test("usage absence stays null and is not invented as zero", async () => {
    const adapter = createDeterministicProviderAdapter({
      script: { kind: "text", text: "n", usage: null, finishReason: "stop" },
    });
    const terminal = await normalizeToTerminal(
      adapter.stream(deterministicEchoRequest(), { signal: new AbortController().signal }),
    );
    expect(terminal.kind).toBe("finished");
    if (terminal.kind === "finished") {
      expect(terminal.snapshot.usage).toBeNull();
      expect(terminal.snapshot.usage).not.toEqual({
        provenance: "unknown",
        inputTokens: 0,
        outputTokens: 0,
      });
    }
  });
});

describe("provider conformance: discovery modalities and provenance", () => {
  test("static discovery catalogs with provenance", async () => {
    const clock = createManualClock();
    const outcome = await discoverModelCatalog(
      demoProfile(),
      { staticDiscovery: createStaticModelDiscovery({ generation: 7 }) },
      { signal: new AbortController().signal, now: clock.now() },
    );
    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.provenance).toBe("static-config");
      expect(outcome.catalog.generation).toBe(7);
    }
  });

  test("remote discovery double preserves modalities without network", async () => {
    const clock = createManualClock();
    const remoteCatalog: ModelCatalog = {
      generation: 11,
      provenance: "remote-discovery",
      fetchedAt: clock.now(),
      expiresAt: null,
      models: [
        {
          modelId: vision,
          modalities: ["text", "image"],
          tools: true,
          streaming: true,
          reasoning: false,
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
      ],
    };
    const outcome = await discoverModelCatalog(
      demoProfile({ discovery: "remote" }),
      {
        staticDiscovery: createStaticModelDiscovery(),
        remoteDiscovery: createDeterministicRemoteDiscovery({ catalog: remoteCatalog }),
      },
      { signal: new AbortController().signal, now: clock.now() },
    );
    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.provenance).toBe("remote-discovery");
      expect(outcome.catalog.models[0]?.modalities).toContain("image");
    }
  });
});

describe("provider conformance: routing receipt and non-recursive fallback", () => {
  test("records receipt fields and walks fallback without recursion", () => {
    const policy = samplePolicy();
    const first = resolveModelRoute({
      policy,
      catalogs: catalogs(),
      intent: "coding",
    });
    expect(first.kind).toBe("selected");
    if (first.kind !== "selected") {
      return;
    }
    const receipt: RoutingReceipt = first.receipt;
    expect(receipt.role).toBe("default");
    expect(receipt.intent).toBe("coding");
    expect(receipt.fallbackPosition).toBe(0);
    expect(receipt.catalogProvenance).toBe("static-config");
    expect(receipt.providerId).toBe(primary);
    expect(receipt.modelId).toBe(fast);

    const second = resolveNextFallback({ policy, catalogs: catalogs(), intent: "coding" }, receipt);
    expect(second.kind).toBe("selected");
    if (second.kind !== "selected") {
      return;
    }
    expect(second.receipt.selectionReason).toBe("fallback");
    expect(second.receipt.fallbackPosition).toBe(1);
    expect(second.receipt.providerId).toBe(secondary);

    const third = resolveNextFallback(
      { policy, catalogs: catalogs(), intent: "coding" },
      second.receipt,
    );
    expect(third.kind).toBe("no-eligible-route");
    if (third.kind === "no-eligible-route") {
      expect(third.code).toBe("fallback-exhausted");
    }

    const recursive = resolveModelRoute({
      policy,
      catalogs: catalogs(),
      intent: "coding",
      visited: new Set([`${primary}\0${fast}`]),
    });
    expect(recursive.kind).toBe("no-eligible-route");
    if (recursive.kind === "no-eligible-route") {
      expect(recursive.code).toBe("fallback-recursion");
    }
  });
});

describe("provider conformance: diagnostic redaction", () => {
  test("redacts secrets and leaves ordinary diagnostics intact", () => {
    expect(redactProviderDiagnosticText("Authorization: Bearer tok.secret")).toBe("[redacted]");
    expect(redactProviderDiagnosticText("x-api-key: sk-abcdefghijklmnop")).toBe("[redacted]");
    expect(redactProviderDiagnosticText("api_key=sk-live-12345678")).toBe("[redacted]");
    expect(redactProviderDiagnosticText("rate limited; retry after 2s")).toBe(
      "rate limited; retry after 2s",
    );
  });
});
